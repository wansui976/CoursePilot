//! 局域网直连播放：手机上点开一个只在电脑上有文件的视频，同一个 Wi‑Fi 下直接从电脑串流过来，
//! 不用先传到网盘再下载（坚果云免费版每月只能上传 1 GB，传不了几节课）。
//!
//! 电脑（打开了「局域网直连播放」）：
//! - 在局域网上开一个 HTTPS 服务，只回答 `/v/<视频 id>`（支持 Range）和 `/ping`；
//! - 证书是自签的，第一次打开时生成；访问要带随机口令；
//! - 把「我的地址、端口、口令、证书指纹」写进网盘上自己的文件夹（`lan.json`）。
//!
//! 手机：打开没有文件的视频时，读网盘上别的设备的 `lan.json`，挨个试；连上了就让本机的媒体服务
//! （127.0.0.1）转发这个视频。连接按 `lan.json` 里的证书指纹钉住：同一个 Wi‑Fi 里别人冒充
//! 电脑拿不到口令，也看不到画面。
//!
//! 为什么借网盘配对：两台设备已经用同一个网盘账号同步了，不用再扫码、输配对码。能读这个网盘的人
//! 本来就能读到全部学习数据，口令放在那里不扩大谁能看到什么。

use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;

use crate::commands::settings::{get_setting, set_setting};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::media_server::{read_head, respond_empty, serve_file, RemoteSource};
use crate::sync::remote::RemoteConfig;

pub const SETTING_ENABLED: &str = "lan_share_enabled";
const SETTING_PORT: &str = "lan_share_port";
const SETTING_CERT: &str = "lan_share_cert";
const SETTING_KEY: &str = "lan_share_key";
const SETTING_TOKEN: &str = "lan_share_token";
/// 网盘上每台设备文件夹里公布局域网地址的文件。
pub const ADVERT_FILE: &str = "lan.json";
/// 找电脑时每个地址最多等多久（不在同一个 Wi‑Fi 时别让人干等）。
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// 别的设备公布的地址缓存多久（连着点开几个视频不必每次都读网盘）。
const PEERS_TTL: Duration = Duration::from_secs(120);

/// 只有电脑能开共享（手机切到后台就被系统挂起，当不了服务器）。
pub fn supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows", target_os = "linux"))
}

/// 公布在网盘上的「怎么连到我」。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Advert {
    pub addresses: Vec<String>,
    pub port: u16,
    pub token: String,
    /// 证书（DER）的 SHA-256，十六进制。
    pub cert_sha256: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub supported: bool,
    pub enabled: bool,
    pub running: bool,
    pub port: Option<u16>,
    pub addresses: Vec<String>,
    pub error: Option<String>,
}

struct Running {
    port: u16,
    token: String,
    fingerprint: String,
    task: tokio::task::JoinHandle<()>,
}

fn running() -> &'static Mutex<Option<Running>> {
    static RUNNING: OnceLock<Mutex<Option<Running>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(None))
}

fn last_error() -> &'static Mutex<Option<String>> {
    static ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    ERROR.get_or_init(|| Mutex::new(None))
}

pub async fn is_enabled(db: &Db) -> bool {
    get_setting(db, SETTING_ENABLED).await.ok().flatten().as_deref() == Some("true")
}

pub async fn status(db: &Db) -> Status {
    let enabled = is_enabled(db).await;
    let guard = running().lock().unwrap();
    Status {
        supported: supported(),
        enabled,
        running: guard.is_some(),
        port: guard.as_ref().map(|running| running.port),
        addresses: if guard.is_some() { local_addresses() } else { Vec::new() },
        error: last_error().lock().unwrap().clone(),
    }
}

/// 现在要公布的内容；没在共享时是 None（网盘上的 lan.json 应该删掉）。
pub fn advert() -> Option<Advert> {
    let guard = running().lock().unwrap();
    let running = guard.as_ref()?;
    let addresses = local_addresses();
    if addresses.is_empty() {
        return None;
    }
    Some(Advert {
        addresses,
        port: running.port,
        token: running.token.clone(),
        cert_sha256: running.fingerprint.clone(),
    })
}

/// 这台设备在局域网里的地址。用「连」一个外部地址的 UDP 套接字问系统会走哪块网卡——
/// 不真的发包，也不用列网卡（各个系统的接口都不一样）。
fn local_addresses() -> Vec<String> {
    let mut found = Vec::new();
    for probe in ["8.8.8.8:80", "192.168.0.1:80", "10.0.0.1:80"] {
        let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") else { continue };
        if socket.connect(probe).is_err() {
            continue;
        }
        let Ok(address) = socket.local_addr() else { continue };
        let ip = address.ip();
        if ip.is_loopback() || ip.is_unspecified() {
            continue;
        }
        let text = ip.to_string();
        if !found.contains(&text) {
            found.push(text);
        }
    }
    found
}

struct Keys {
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
    token: String,
}

fn fingerprint(cert_der: &[u8]) -> String {
    Sha256::digest(cert_der).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 证书、私钥、口令：第一次打开时生成，之后一直用同一套（换了的话手机要等重新读到 lan.json）。
async fn keys(db: &Db) -> AppResult<Keys> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let stored = (
        get_setting(db, SETTING_CERT).await?.and_then(|value| b64.decode(value).ok()),
        get_setting(db, SETTING_KEY).await?.and_then(|value| b64.decode(value).ok()),
        get_setting(db, SETTING_TOKEN).await?.filter(|value| value.len() >= 32),
    );
    if let (Some(cert_der), Some(key_der), Some(token)) = stored {
        return Ok(Keys { cert_der, key_der, token });
    }
    let generated = rcgen::generate_simple_self_signed(vec!["coursepilot.local".to_string()])
        .map_err(|error| AppError::Other(format!("生成证书失败：{error}")))?;
    let keys = Keys {
        cert_der: generated.cert.der().to_vec(),
        key_der: generated.signing_key.serialize_der(),
        token: format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()),
    };
    set_setting(db, SETTING_CERT, &b64.encode(&keys.cert_der)).await?;
    set_setting(db, SETTING_KEY, &b64.encode(&keys.key_der)).await?;
    set_setting(db, SETTING_TOKEN, &keys.token).await?;
    Ok(keys)
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// 打开共享（已经开着就什么都不做）。端口尽量沿用上次的，手机缓存的地址不至于马上失效。
pub async fn start(db: Db) -> AppResult<u16> {
    if let Some(running) = running().lock().unwrap().as_ref() {
        return Ok(running.port);
    }
    let result = start_inner(db).await;
    *last_error().lock().unwrap() = result.as_ref().err().map(|error| error.to_string());
    result
}

async fn start_inner(db: Db) -> AppResult<u16> {
    if !supported() {
        return Err(AppError::Config("只有电脑上能打开局域网直连播放".into()));
    }
    let keys = keys(&db).await?;
    let config = rustls::ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|error| AppError::Other(error.to_string()))?
        .with_no_client_auth()
        .with_single_cert(
            vec![rustls::pki_types::CertificateDer::from(keys.cert_der.clone())],
            rustls::pki_types::PrivateKeyDer::Pkcs8(keys.key_der.clone().into()),
        )
        .map_err(|error| AppError::Other(format!("证书不能用：{error}")))?;
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));

    let saved: u16 = get_setting(&db, SETTING_PORT).await?.and_then(|value| value.parse().ok()).unwrap_or(0);
    let listener = match TcpListener::bind(("0.0.0.0", saved)).await {
        Ok(listener) => listener,
        // 上次的端口被别的程序占了：换一个。
        Err(_) if saved != 0 => TcpListener::bind(("0.0.0.0", 0)).await?,
        Err(error) => return Err(error.into()),
    };
    let port = listener.local_addr()?.port();
    if port != saved {
        set_setting(&db, SETTING_PORT, &port.to_string()).await?;
    }

    let token: Arc<str> = Arc::from(keys.token.as_str());
    let server_db = db.clone();
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            let db = server_db.clone();
            let token = token.clone();
            tokio::spawn(async move {
                // 握手卡住的连接（不是我们的客户端）十秒后放弃。
                let Ok(Ok(stream)) = tokio::time::timeout(Duration::from_secs(10), acceptor.accept(stream)).await else {
                    return;
                };
                let _ = handle(stream, &db, &token).await;
            });
        }
    });
    *running().lock().unwrap() = Some(Running {
        port,
        token: keys.token,
        fingerprint: fingerprint(&keys.cert_der),
        task,
    });
    tracing::info!(port, "局域网直连播放已打开");
    Ok(port)
}

pub fn stop() {
    if let Some(running) = running().lock().unwrap().take() {
        running.task.abort();
    }
    *last_error().lock().unwrap() = None;
}

/// 比较口令不因为前几位对上了就早早返回（防止按耗时一位一位猜）。
fn same_secret(given: &str, expected: &str) -> bool {
    given.len() == expected.len() && given.bytes().zip(expected.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

fn valid_video_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

async fn handle<S>(mut stream: S, db: &Db, token: &str) -> std::io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let Some(request) = read_head(&mut stream).await? else { return Ok(()) };
    let authorized = request
        .authorization
        .as_deref()
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|given| same_secret(given.trim(), token));
    if !authorized {
        respond_empty(&mut stream, "401 Unauthorized").await;
        return Ok(());
    }
    let target = request.target.split('?').next().unwrap_or("");
    if target == "/ping" {
        respond_empty(&mut stream, "200 OK").await;
        return Ok(());
    }
    let Some(id) = target.strip_prefix("/v/").filter(|id| valid_video_id(id)) else {
        respond_empty(&mut stream, "404 Not Found").await;
        return Ok(());
    };
    // 只给没在回收站、这台设备上有文件的视频。转过码的给转好的那份（手机多半也放不了原件的编码）。
    let paths: Option<(String, String)> =
        sqlx::query_as("SELECT file_path, data_dir FROM videos WHERE id=? AND deleted_at IS NULL AND file_path<>''")
            .bind(id)
            .fetch_optional(&db.pool)
            .await
            .ok()
            .flatten();
    let Some((file_path, data_dir)) = paths else {
        respond_empty(&mut stream, "404 Not Found").await;
        return Ok(());
    };
    let path = crate::pipeline::playable::cached_playable(std::path::Path::new(&file_path), std::path::Path::new(&data_dir));
    serve_file(&mut stream, &path, &request.method, request.range.as_deref()).await
}

// ---------------------------------------------------------------------------
// 手机这一头：找到有这个视频的电脑

/// 只认指纹对得上的那张证书。自签证书没有 CA 可查，指纹是从网盘上读来的（见模块说明）。
#[derive(Debug)]
struct PinnedCert {
    fingerprint: String,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl rustls::client::danger::ServerCertVerifier for PinnedCert {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if same_secret(&fingerprint(end_entity.as_ref()), &self.fingerprint) {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("局域网里那台设备的证书和网盘上公布的对不上".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// 钉住某张证书的 HTTP 客户端。不设总超时：它也用来转发整段视频。
pub fn pinned_client(cert_sha256: &str) -> AppResult<reqwest::Client> {
    let provider = provider();
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|error| AppError::Other(error.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedCert { fingerprint: cert_sha256.to_ascii_lowercase(), provider }))
        .with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .connect_timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|error| AppError::Other(error.to_string()))
}

struct Peers {
    key: String,
    at: Instant,
    adverts: Vec<Advert>,
}

fn peers_cache() -> &'static Mutex<Option<Peers>> {
    static PEERS: OnceLock<Mutex<Option<Peers>>> = OnceLock::new();
    PEERS.get_or_init(|| Mutex::new(None))
}

/// 网盘上别的设备公布的局域网地址（缓存两分钟）。
async fn peer_adverts(config: &RemoteConfig, own_device: &str) -> AppResult<Vec<Advert>> {
    let key = format!("{}\0{}\0{}", config.url, config.folder, config.user);
    if let Some(cached) = peers_cache().lock().unwrap().as_ref() {
        if cached.key == key && cached.at.elapsed() < PEERS_TTL {
            return Ok(cached.adverts.clone());
        }
    }
    let dav = config.client()?;
    let devices = dav.list(crate::sync::remote::DEVICES_DIR).await?.unwrap_or_default();
    let mut adverts = Vec::new();
    for device in devices.iter().filter(|entry| entry.is_dir && entry.name != own_device) {
        let path = format!("{}{}/{ADVERT_FILE}", crate::sync::remote::DEVICES_DIR, device.name);
        if let Some(advert) = dav.get_optional(&path).await?.and_then(|bytes| serde_json::from_slice::<Advert>(&bytes).ok()) {
            adverts.push(advert);
        }
    }
    *peers_cache().lock().unwrap() = Some(Peers { key, at: Instant::now(), adverts: adverts.clone() });
    Ok(adverts)
}

/// 刚改了共享设置、或者找不到时让下次重新读网盘。
pub fn forget_peers() {
    *peers_cache().lock().unwrap() = None;
}

fn video_url(address: &str, port: u16, video_id: &str) -> String {
    if address.contains(':') {
        format!("https://[{address}]:{port}/v/{video_id}")
    } else {
        format!("https://{address}:{port}/v/{video_id}")
    }
}

/// 在局域网里找一台有这个视频的设备。都连不上（不在同一个 Wi‑Fi、电脑没开）返回 None。
pub async fn find(db: &Db, config: &RemoteConfig, video_id: &str) -> AppResult<Option<RemoteSource>> {
    if !valid_video_id(video_id) {
        return Ok(None);
    }
    let own = crate::sync::identity::ensure_sync_identity(db).await?.device_id;
    let adverts = peer_adverts(config, &own).await?;
    let found = probe(&adverts, video_id).await;
    if found.is_none() {
        // 可能电脑换了地址、刚打开共享：下次重新读网盘。
        forget_peers();
    }
    Ok(found)
}

/// 所有设备的所有地址一起试，谁先回答「有」用谁。
pub async fn probe(adverts: &[Advert], video_id: &str) -> Option<RemoteSource> {
    let mut attempts = tokio::task::JoinSet::new();
    for advert in adverts {
        let Ok(client) = pinned_client(&advert.cert_sha256) else { continue };
        for address in &advert.addresses {
            let url = video_url(address, advert.port, video_id);
            let client = client.clone();
            let token = advert.token.clone();
            attempts.spawn(async move {
                let response = client.head(&url).bearer_auth(&token).timeout(PROBE_TIMEOUT).send().await.ok()?;
                response.status().is_success().then_some(RemoteSource { url, token, client })
            });
        }
    }
    while let Some(result) = attempts.join_next().await {
        if let Ok(Some(source)) = result {
            attempts.abort_all();
            return Some(source);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn shared_video(dir: &std::path::Path) -> (Db, String) {
        let db = Db::connect_and_migrate(&dir.join("pc.db")).await.unwrap();
        let course = crate::commands::courses::create_course(&db, "c".into(), dir.to_string_lossy().into()).await.unwrap();
        let file = dir.join("01.mp4");
        std::fs::write(&file, b"0123456789abcdef").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, file, None).await.unwrap();
        (db, video.id)
    }

    fn advert_for(port: u16, token: String, cert_sha256: String) -> Advert {
        Advert { addresses: vec!["127.0.0.1".into()], port, token, cert_sha256 }
    }

    #[test]
    fn secrets_compare_whole_strings_only() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abd", "abc"));
        assert!(!same_secret("ab", "abc"));
        assert!(valid_video_id("6aba4963-1083-4117-ba11-e4de04111e67"));
        assert!(!valid_video_id("../etc/passwd"));
        assert!(!valid_video_id(""));
    }

    // 一个测试里走完：start/stop 动的是进程里唯一的那个共享服务，分开写会互相踩。
    #[tokio::test(flavor = "multi_thread")]
    async fn a_phone_streams_a_video_from_the_pc_only_with_the_right_token_and_certificate() {
        let dir = tempfile::tempdir().unwrap();
        let (db, video_id) = shared_video(dir.path()).await;
        let port = start(db.clone()).await.unwrap();
        let published = advert().expect("开着共享时有可公布的内容");
        assert_eq!(published.port, port);
        let local = advert_for(port, published.token.clone(), published.cert_sha256.clone());

        // 口令和证书都对：找得到，Range 请求原样转回来。
        let source = probe(std::slice::from_ref(&local), &video_id).await.expect("找到了");
        let media = crate::media_server::start().await.unwrap();
        media.register_remote(&video_id, source);
        let response = reqwest::Client::new()
            .get(media.url(&video_id))
            .header("Range", "bytes=4-7")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 206);
        assert_eq!(response.headers()["content-range"], "bytes 4-7/16");
        assert_eq!(response.bytes().await.unwrap().as_ref(), b"4567");

        // 没有这个视频、口令不对、证书指纹不对：都找不到。
        assert!(probe(std::slice::from_ref(&local), "no-such-video").await.is_none());
        let wrong_token = advert_for(port, "x".repeat(64), published.cert_sha256.clone());
        assert!(probe(&[wrong_token], &video_id).await.is_none());
        let wrong_cert = advert_for(port, published.token.clone(), "0".repeat(64));
        assert!(probe(&[wrong_cert], &video_id).await.is_none());

        // 进了回收站的不给。
        sqlx::query("UPDATE videos SET deleted_at=1 WHERE id=?").bind(&video_id).execute(&db.pool).await.unwrap();
        assert!(probe(std::slice::from_ref(&local), &video_id).await.is_none());

        // 关掉之后连不上，也不再公布；再打开沿用同一个端口和证书。
        stop();
        assert!(advert().is_none());
        assert!(probe(std::slice::from_ref(&local), &video_id).await.is_none());
        sqlx::query("UPDATE videos SET deleted_at=NULL WHERE id=?").bind(&video_id).execute(&db.pool).await.unwrap();
        assert_eq!(start(db.clone()).await.unwrap(), port);
        assert!(probe(std::slice::from_ref(&local), &video_id).await.is_some());
        stop();
    }
}
