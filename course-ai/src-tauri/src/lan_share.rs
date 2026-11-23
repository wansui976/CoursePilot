//! 局域网直连播放：手机上点开一个只在电脑上有文件的视频，同一个 Wi‑Fi 下直接从电脑串流过来，
//! 不用先传到网盘再下载（坚果云免费版每月只能上传 1 GB，传不了几节课）。
//!
//! 电脑（打开了「局域网直连播放」）：
//! - 在局域网上开一个 HTTPS 服务，只回答 `/v/<视频 id>`（支持 Range）、`/t/<视频 id>`
//!   （手机放不了的编码就地转 H.264）和 `/ping`；
//! - 证书是自签的，第一次打开时生成；访问要带随机口令；
//! - 把「我的地址、端口、口令、证书指纹」写进网盘上自己的文件夹（`lan.json`）。
//!
//! 手机：打开没有文件的视频时，读网盘上别的设备的 `lan.json`，挨个试；连上了就让本机的媒体服务
//! （127.0.0.1）转发这个视频。连接按 `lan.json` 里的证书指纹钉住：同一个 Wi‑Fi 里别人冒充
//! 电脑拿不到口令，也看不到画面。
//!
//! 为什么借网盘配对：两台设备已经用同一个网盘账号同步了，不用再扫码、输配对码。能读这个网盘的人
//! 本来就能读到全部学习数据，口令放在那里不扩大谁能看到什么。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

use crate::commands::settings::{get_setting, set_setting};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::media_server::{read_head, respond_empty, serve_file, RemoteAuth, RemoteSource};
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
    cfg!(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "linux"
    ))
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
    get_setting(db, SETTING_ENABLED)
        .await
        .ok()
        .flatten()
        .as_deref()
        == Some("true")
}

pub async fn status(db: &Db) -> Status {
    let enabled = is_enabled(db).await;
    let guard = running().lock().unwrap();
    Status {
        supported: supported(),
        enabled,
        running: guard.is_some(),
        port: guard.as_ref().map(|running| running.port),
        addresses: if guard.is_some() {
            local_addresses()
        } else {
            Vec::new()
        },
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

/// 这台设备在局域网里的地址：所有网卡上的 IPv4，去掉别的设备不可能连上的。
///
/// 不能再用「连一个外网地址，问系统会走哪块网卡」那一招：开着 Clash / Surge 这类 TUN 代理时，
/// 默认路由被虚拟网卡接管，问出来的是 198.18.x.x 这样的假地址——手机照着连永远连不上。
fn local_addresses() -> Vec<String> {
    // 手机切到后台就被系统挂起，当不了服务器，也就不用公布地址。
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    return Vec::new();

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        let Ok(interfaces) = if_addrs::get_if_addrs() else {
            return Vec::new();
        };
        let mut found: Vec<String> = interfaces
            .into_iter()
            .filter_map(|interface| match interface.addr {
                if_addrs::IfAddr::V4(v4) => Some((interface.name, interface.is_p2p, v4.ip)),
                if_addrs::IfAddr::V6(_) => None,
            })
            .filter(|(name, point_to_point, ip)| publishable(name, *point_to_point, *ip))
            .map(|(_, _, ip)| ip.to_string())
            .collect();
        // 固定顺序：网卡枚举顺序变了，写进网盘的内容（以及界面上的显示）不跟着跳。
        found.sort();
        found.dedup();
        found
    }
}

/// 写进公布地址里的：同一个 Wi‑Fi 里连得上的，加上 Tailscale 这类组网给的 100.64/10 地址
/// （两台设备都在同一个 tailnet 里时，手机不在家也连得上）。组网地址挂在隧道网卡上
/// （macOS 上是 utun），所以要在排除隧道之前先认出来。连不上的地址只是并行试探时白等 3 秒，
/// 不碍事。
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn publishable(name: &str, point_to_point: bool, ip: std::net::Ipv4Addr) -> bool {
    tailnet_ipv4(ip) || (shareable_ipv4(ip) && !is_tunnel(name, point_to_point))
}

/// 100.64/10：Tailscale 给每台设备的地址就在这一段（也是运营商级 NAT 的地址段）。
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn tailnet_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let [first, second, ..] = ip.octets();
    first == 100 && (64..=127).contains(&second)
}

/// 别的设备和这台电脑在同一个局域网里时，有可能连上的地址。
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn shareable_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let [first, second, ..] = ip.octets();
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_link_local() // 169.254/16：没拿到 DHCP 地址时的自配地址
        || ip.is_multicast()
        || ip.is_broadcast()
        || first >= 240 // 保留段
        // 198.18/15：Clash / Surge 等 TUN 代理的假 IP 段
        || (first == 198 && (second == 18 || second == 19))
        // 100.64/10：运营商级 NAT、Tailscale 等组网地址，不在同一个 Wi‑Fi 里（组网地址另外认，见 publishable）
        || tailnet_ipv4(ip))
}

/// VPN / 点对点网卡上的地址不在「同一个局域网」里，公布了手机也连不上。
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn is_tunnel(name: &str, point_to_point: bool) -> bool {
    if point_to_point {
        return true;
    }
    let name = name.to_ascii_lowercase();
    [
        "utun", "ipsec", "gif", "stf", "awdl", "llw", "ppp", "tun", "tap", "wg",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
}

struct Keys {
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
    token: String,
}

fn fingerprint(cert_der: &[u8]) -> String {
    Sha256::digest(cert_der)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 证书、私钥、口令：第一次打开时生成，之后一直用同一套（换了的话手机要等重新读到 lan.json）。
async fn keys(db: &Db) -> AppResult<Keys> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let stored = (
        get_setting(db, SETTING_CERT)
            .await?
            .and_then(|value| b64.decode(value).ok()),
        get_setting(db, SETTING_KEY)
            .await?
            .and_then(|value| b64.decode(value).ok()),
        get_setting(db, SETTING_TOKEN)
            .await?
            .filter(|value| value.len() >= 32),
    );
    if let (Some(cert_der), Some(key_der), Some(token)) = stored {
        return Ok(Keys {
            cert_der,
            key_der,
            token,
        });
    }
    let generated = rcgen::generate_simple_self_signed(vec!["coursepilot.local".to_string()])
        .map_err(|error| AppError::Other(format!("生成证书失败：{error}")))?;
    let keys = Keys {
        cert_der: generated.cert.der().to_vec(),
        key_der: generated.signing_key.serialize_der(),
        token: format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        ),
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
            vec![rustls::pki_types::CertificateDer::from(
                keys.cert_der.clone(),
            )],
            rustls::pki_types::PrivateKeyDer::Pkcs8(keys.key_der.clone().into()),
        )
        .map_err(|error| AppError::Other(format!("证书不能用：{error}")))?;
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));

    let saved: u16 = get_setting(&db, SETTING_PORT)
        .await?
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
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
                let Ok(Ok(stream)) =
                    tokio::time::timeout(Duration::from_secs(10), acceptor.accept(stream)).await
                else {
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
    given.len() == expected.len()
        && given
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

fn valid_video_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

async fn handle<S>(mut stream: S, db: &Db, token: &str) -> std::io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let Some(request) = read_head(&mut stream).await? else {
        return Ok(());
    };
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
    // `/i/<id>`：这条视频电脑上会给哪份文件（大小、扩展名）。手机整段下载前先问一声：
    // 转过码的话 `/v/` 给的是 playable.mp4，文件名也该这么叫，下下来才播得了。
    if let Some(id) = target.strip_prefix("/i/").filter(|id| valid_video_id(id)) {
        match server_video_info(db, id).await {
            Some((file_path, data_dir)) => {
                let path = crate::pipeline::playable::cached_playable(
                    Path::new(&file_path),
                    Path::new(&data_dir),
                );
                let info = VideoFileInfo {
                    size: std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0),
                    ext: path
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .map(|ext| ext.to_ascii_lowercase())
                        .filter(|ext| !ext.is_empty() && ext.len() <= 8)
                        .unwrap_or_else(|| "mp4".into()),
                    codec: crate::pipeline::playable::video_codec(&path)
                        .map(|codec| String::from_utf8_lossy(&codec).to_string()),
                };
                let body = serde_json::to_vec(&info).unwrap_or_default();
                respond_json(&mut stream, "200 OK", &body).await;
            }
            None => respond_empty(&mut stream, "404 Not Found").await,
        }
        return Ok(());
    }
    // `/t/<id>`：手机放不了这条视频的编码，让电脑转一份 H.264。
    // POST 点火（`?retry=1` 表示用户点了重试），GET 查进度；回的都是同一行 JSON。
    if let Some(id) = target.strip_prefix("/t/").filter(|id| valid_video_id(id)) {
        let state = if request.method.eq_ignore_ascii_case("POST") {
            let retry = request
                .target
                .split_once('?')
                .map(|(_, query)| query.split('&').any(|part| part == "retry=1"))
                .unwrap_or(false);
            server_start_transcode(db, id, retry).await
        } else {
            server_transcode_status(db, id).await
        };
        let body = serde_json::to_vec(&state).unwrap_or_default();
        respond_json(&mut stream, "200 OK", &body).await;
        return Ok(());
    }
    let Some(id) = target.strip_prefix("/v/").filter(|id| valid_video_id(id)) else {
        respond_empty(&mut stream, "404 Not Found").await;
        return Ok(());
    };
    // 只给没在回收站、这台设备上有文件的视频。转过码的给转好的那份（手机多半也放不了原件的编码）。
    let Some((file_path, data_dir)) = server_video_info(db, id).await else {
        respond_empty(&mut stream, "404 Not Found").await;
        return Ok(());
    };
    let path =
        crate::pipeline::playable::cached_playable(Path::new(&file_path), Path::new(&data_dir));
    serve_file(
        &mut stream,
        &path,
        &request.method,
        request.range.as_deref(),
    )
    .await
}

async fn respond_json<S: AsyncWrite + Unpin>(stream: &mut S, status: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    if stream.write_all(head.as_bytes()).await.is_ok() {
        let _ = stream.write_all(body).await;
        let _ = stream.flush().await;
    }
}

// ---------------------------------------------------------------------------
// 电脑这一头：手机放不了的编码，在电脑上转成 H.264

/// `/i/<id>` 回的：整段下载会拿到多大的文件、什么格式。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFileInfo {
    pub size: u64,
    pub ext: String,
    /// 这份文件的视频编码（mp4 的 stsd，比如 `avc1`、`hvc1`、`av01`）。老版本的电脑不给。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
}

/// `/t/<id>` 回的一行状态，和播放器现有的转码 UI 同一套字段。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscodeState {
    /// idle / running / done / failed
    pub state: String,
    /// 0–100，running 时是当前进度
    pub percent: u32,
}

impl TranscodeState {
    fn idle() -> Self {
        Self {
            state: "idle".into(),
            percent: 0,
        }
    }

    fn running(percent: u32) -> Self {
        Self {
            state: "running".into(),
            percent,
        }
    }

    fn done() -> Self {
        Self {
            state: "done".into(),
            percent: 100,
        }
    }

    fn failed() -> Self {
        Self {
            state: "failed".into(),
            percent: 0,
        }
    }
}

struct FfmpegJob {
    percent: Arc<AtomicU32>,
    /// 失败过的片子不自动重转：10-bit / 坏文件每次点开都重解一遍整片，几分钟的 CPU 白费。
    /// 只有手机带 `?retry=1`（用户点了重试）才再做。
    failed: bool,
}

fn ffmpeg_jobs() -> &'static Mutex<HashMap<String, FfmpegJob>> {
    static JOBS: OnceLock<Mutex<HashMap<String, FfmpegJob>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 电脑上同时只转一条：两三门课一起解 1080p 会把风扇拉满，也拖慢用户正在看的那条。
fn ffmpeg_gate() -> &'static tokio::sync::Semaphore {
    static GATE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Semaphore::new(1))
}

async fn server_video_info(db: &Db, id: &str) -> Option<(String, String)> {
    if !valid_video_id(id) {
        return None;
    }
    sqlx::query_as("SELECT file_path, data_dir FROM videos WHERE id=? AND deleted_at IS NULL AND file_path<>''")
        .bind(id)
        .fetch_optional(&db.pool)
        .await
        .ok()
        .flatten()
}

fn playable_target(data_dir: &str) -> PathBuf {
    Path::new(data_dir).join("playable.mp4")
}

/// 转好的成品：非空、而且真的是 H.264。0 字节或别的编码（比如以前只做了 faststart
/// 转封装留下的 AV1 副本）都不算数。
fn converted_ready(target: &Path) -> bool {
    std::fs::metadata(target)
        .map(|meta| meta.len() > 0)
        .unwrap_or(false)
        && matches!(
            crate::pipeline::playable::video_codec(target),
            Some(codec) if &codec == b"avc1" || &codec == b"avc3"
        )
}

async fn server_transcode_status(db: &Db, id: &str) -> TranscodeState {
    let from_jobs = {
        let jobs = ffmpeg_jobs().lock().unwrap();
        jobs.get(id).map(|job| {
            if job.failed {
                TranscodeState::failed()
            } else {
                let percent = job.percent.load(Ordering::Acquire);
                if percent >= 100 {
                    TranscodeState::done()
                } else {
                    TranscodeState::running(percent)
                }
            }
        })
    };
    if let Some(state) = from_jobs {
        return state;
    }
    // 进程重启过：任务表空了，但转好的成品还在磁盘上。
    match server_video_info(db, id).await {
        Some((_, data_dir))
            if !data_dir.is_empty() && converted_ready(&playable_target(&data_dir)) =>
        {
            TranscodeState::done()
        }
        _ => TranscodeState::idle(),
    }
}

async fn server_start_transcode(db: &Db, id: &str, retry: bool) -> TranscodeState {
    let Some((file_path, data_dir)) = server_video_info(db, id).await else {
        return TranscodeState::failed();
    };
    if data_dir.is_empty() {
        return TranscodeState::failed();
    }
    let target = playable_target(&data_dir);
    if converted_ready(&target) {
        return TranscodeState::done();
    }
    // 「查有没有在转」和「登记」放在同一把锁里：手机连点两下不会起两份。
    let percent = {
        let mut jobs = ffmpeg_jobs().lock().unwrap();
        if let Some(job) = jobs.get(id) {
            if job.failed && !retry {
                return TranscodeState::failed();
            }
            if !job.failed {
                let percent = job.percent.load(Ordering::Acquire);
                return if percent >= 100 {
                    TranscodeState::done()
                } else {
                    TranscodeState::running(percent)
                };
            }
        }
        let percent = Arc::new(AtomicU32::new(1));
        jobs.insert(
            id.to_string(),
            FfmpegJob {
                percent: percent.clone(),
                failed: false,
            },
        );
        percent
    };
    let video_id = id.to_string();
    tauri::async_runtime::spawn(async move {
        let _permit = ffmpeg_gate().acquire().await.ok();
        let outcome = run_ffmpeg(Path::new(&file_path), &target, &percent).await;
        if let Err(error) = &outcome {
            tracing::warn!(%error, %video_id, "电脑上转码失败");
        }
        if let Some(job) = ffmpeg_jobs().lock().unwrap().get_mut(&video_id) {
            if outcome.is_ok() {
                job.percent.store(100, Ordering::Release);
            } else {
                job.failed = true;
                job.percent.store(0, Ordering::Release);
            }
        }
    });
    TranscodeState::running(1)
}

/// 用随包的 ffmpeg 转一份 H.264/AAC，写到 `data_dir/playable.mp4`（先写 `playable.partial.mp4`，
/// 校验通过才换上）。`percent` 是给 `/t/<id>` 轮询看的进度。
async fn run_ffmpeg(source: &Path, target: &Path, percent: &AtomicU32) -> Result<(), String> {
    let ffmpeg = crate::sidecar::resolve(&crate::sidecar::FFMPEG, None)
        .map_err(|error| format!("找不到 ffmpeg：{error}"))?;
    let parent = target
        .parent()
        .ok_or_else(|| "转码目录不存在".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("转码目录创建失败：{error}"))?;
    let partial = parent.join("playable.partial.mp4");
    let _ = tokio::fs::remove_file(&partial).await;

    let mut child = crate::sidecar::command(&ffmpeg)
        .arg("-y")
        .args([
            "-hide_banner",
            "-nostats",
            "-progress",
            "pipe:1",
            "-loglevel",
            "info",
        ])
        .arg("-i")
        .arg(source)
        .args(["-map", "0:v:0", "-map", "0:a:0?"])
        .args([
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
        ])
        .args(["-c:a", "aac", "-b:a", "160k"])
        .args(["-movflags", "+faststart"])
        .arg(&partial)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("ffmpeg 启动失败：{error}"))?;

    // 总时长只在 stderr 的 `Duration:` 里；`duration_ms` 这一列在库里大多是空的。
    let total_us = Arc::new(AtomicU64::new(0));
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "ffmpeg 没有 stderr".to_string())?;
    let total_for_stderr = total_us.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if total_for_stderr.load(Ordering::Acquire) == 0 {
                if let Some(parsed) = parse_ffmpeg_duration(&line) {
                    total_for_stderr.store(parsed, Ordering::Release);
                }
            }
            tracing::trace!(target: "lan_share", "{line}");
        }
    });

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg 没有 stdout".to_string())?;
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Some(done_us) = parse_out_time_us(&line) else {
            continue;
        };
        let total = total_us.load(Ordering::Acquire);
        if total > 0 {
            percent.store(transcode_percent(done_us, total), Ordering::Release);
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|error| format!("ffmpeg 退出状态读不到：{error}"))?;
    let _ = stderr_task.await;
    if !status.success() {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(format!("ffmpeg 退出码 {:?}", status.code()));
    }
    // 转出来的不是 H.264（源里没有视频轨、编码器异常）就别拿去顶掉缓存，手机照样放不了。
    if !matches!(
        crate::pipeline::playable::video_codec(&partial),
        Some(codec) if &codec == b"avc1" || &codec == b"avc3"
    ) {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err("转码产物不是 H.264".into());
    }
    // Windows 上 rename 不覆盖已有文件，先删旧的（旧的那份本来就是放不了的编码）。
    let _ = tokio::fs::remove_file(target).await;
    tokio::fs::rename(&partial, target)
        .await
        .map_err(|error| format!("转码产物落盘失败：{error}"))?;
    percent.store(100, Ordering::Release);
    Ok(())
}

/// ffmpeg `-progress` 的一行：`out_time_us=1234567`（老版本叫 `out_time_ms`，单位同样是微秒）。
fn parse_out_time_us(line: &str) -> Option<u64> {
    let value = line
        .strip_prefix("out_time_us=")
        .or_else(|| line.strip_prefix("out_time_ms="))?;
    value.trim().parse().ok()
}

/// stderr 上的 `Duration: 00:42:17.12, start: …`，换成微秒。
fn parse_ffmpeg_duration(line: &str) -> Option<u64> {
    let stamp = line
        .split_once("Duration:")?
        .1
        .trim()
        .split(&[',', ' '][..])
        .next()
        .filter(|stamp| !stamp.is_empty())?;
    let mut parts = stamp.split(':');
    let hours: u64 = parts.next()?.parse().ok()?;
    let minutes: u64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((hours * 3600 + minutes * 60) * 1_000_000 + (seconds * 1_000_000.0).round() as u64)
}

/// 只往上走到 99：100 由转码真正落盘之后才写，免得用户看到 100% 却还是黑屏。
fn transcode_percent(done_us: u64, total_us: u64) -> u32 {
    if total_us == 0 {
        return 0;
    }
    (done_us.saturating_mul(100) / total_us).min(99) as u32
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
            Err(rustls::Error::General(
                "局域网里那台设备的证书和网盘上公布的对不上".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// 钉住某张证书的 HTTP 客户端。不设总超时：它也用来转发整段视频。
pub fn pinned_client(cert_sha256: &str) -> AppResult<reqwest::Client> {
    let provider = provider();
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|error| AppError::Other(error.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedCert {
            fingerprint: cert_sha256.to_ascii_lowercase(),
            provider,
        }))
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
    let devices = dav
        .list(crate::sync::remote::DEVICES_DIR)
        .await?
        .unwrap_or_default();
    let mut adverts = Vec::new();
    for device in devices
        .iter()
        .filter(|entry| entry.is_dir && entry.name != own_device)
    {
        let path = format!(
            "{}{}/{ADVERT_FILE}",
            crate::sync::remote::DEVICES_DIR,
            device.name
        );
        if let Some(advert) = dav
            .get_optional(&path)
            .await?
            .and_then(|bytes| serde_json::from_slice::<Advert>(&bytes).ok())
        {
            adverts.push(advert);
        }
    }
    *peers_cache().lock().unwrap() = Some(Peers {
        key,
        at: Instant::now(),
        adverts: adverts.clone(),
    });
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
pub async fn find(
    db: &Db,
    config: &RemoteConfig,
    video_id: &str,
) -> AppResult<Option<RemoteSource>> {
    if !valid_video_id(video_id) {
        return Ok(None);
    }
    let own = crate::sync::identity::ensure_sync_identity(db)
        .await?
        .device_id;
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
        let Ok(client) = pinned_client(&advert.cert_sha256) else {
            continue;
        };
        for address in &advert.addresses {
            let url = video_url(address, advert.port, video_id);
            let client = client.clone();
            let token = advert.token.clone();
            attempts.spawn(async move {
                let response = client
                    .head(&url)
                    .bearer_auth(&token)
                    .timeout(PROBE_TIMEOUT)
                    .send()
                    .await
                    .ok()?;
                response.status().is_success().then_some(RemoteSource {
                    url,
                    auth: RemoteAuth::Bearer(token),
                    client,
                })
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

/// 手机这一头记下的「这个视频在哪台电脑上」。转码请求得回到同一台电脑去问。
fn sources() -> &'static Mutex<HashMap<String, RemoteSource>> {
    static SOURCES: OnceLock<Mutex<HashMap<String, RemoteSource>>> = OnceLock::new();
    SOURCES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn remember_source(video_id: &str, source: RemoteSource) {
    sources()
        .lock()
        .unwrap()
        .insert(video_id.to_string(), source);
    // 重新打开这条视频等于重新开始：电脑那头进程重启过、任务表空了的话，还能再自动点一次。
    transcode_requested().lock().unwrap().remove(video_id);
}

pub fn forget_source(video_id: &str) {
    sources().lock().unwrap().remove(video_id);
    transcode_requested().lock().unwrap().remove(video_id);
}

fn source_for(video_id: &str) -> Option<RemoteSource> {
    sources().lock().unwrap().get(video_id).cloned()
}

/// 已经替用户点过一次转码的片子：播放器每秒轮询，不能每秒都发一次 POST。
fn transcode_requested() -> &'static Mutex<HashSet<String>> {
    static REQUESTED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    REQUESTED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 视频地址是 `https://host:port/v/<id>`，转码接口是同机的 `/t/<id>`。
fn transcode_url(source: &RemoteSource) -> Option<String> {
    let (base, id) = source.url.rsplit_once("/v/")?;
    Some(format!("{base}/t/{id}"))
}

/// 转码接口只回一行状态，正常是毫秒级；超时只是别把轮询挂死。
const TRANSCODE_TIMEOUT: Duration = Duration::from_secs(10);

async fn fetch_transcode_state(source: &RemoteSource, url: &str) -> Option<TranscodeState> {
    let response = source
        .authorize(source.client.get(url))
        .timeout(TRANSCODE_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<TranscodeState>().await.ok()
}

async fn request_transcode(
    source: &RemoteSource,
    url: &str,
    retry: bool,
) -> Option<TranscodeState> {
    let mut request = source
        .authorize(source.client.post(url))
        .timeout(TRANSCODE_TIMEOUT);
    if retry {
        request = request.query(&[("retry", "1")]);
    }
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<TranscodeState>().await.ok()
}

/// 手机问电脑：这条转到哪了。第一次问到 idle 就顺手点一次——播放器只在报了解码失败之后
/// 才来轮询，这里就是局域网串流这条链路的自动转码点火点（本机播放是在 cmd_media_url 里点）。
pub async fn phone_transcode_status(video_id: &str) -> Option<TranscodeState> {
    let source = source_for(video_id)?;
    let url = transcode_url(&source)?;
    let state = fetch_transcode_state(&source, &url).await?;
    if state.state != "idle" {
        return Some(state);
    }
    let first = transcode_requested()
        .lock()
        .unwrap()
        .insert(video_id.to_string());
    if !first {
        return Some(state);
    }
    match request_transcode(&source, &url, false).await {
        Some(started) => Some(started),
        None => {
            // 这一次没点着（网络抖了一下）：下次轮询再试。
            transcode_requested().lock().unwrap().remove(video_id);
            Some(state)
        }
    }
}

/// 用户点了「重试转码」：带 `?retry=1`，让电脑清掉上次的失败记录再做一次。
pub async fn phone_start_transcode(video_id: &str, retry: bool) -> Option<TranscodeState> {
    let source = source_for(video_id)?;
    let url = transcode_url(&source)?;
    let state = request_transcode(&source, &url, retry).await?;
    transcode_requested()
        .lock()
        .unwrap()
        .insert(video_id.to_string());
    Some(state)
}

/// 这个视频在哪台电脑上：优先用串流时记下的那台，没有就按网盘上公布的地址再找一遍
/// （比如 App 重启过，但文件已经下了一半）。
async fn remote_source(db: &Db, video_id: &str) -> AppResult<RemoteSource> {
    if let Some(source) = source_for(video_id) {
        return Ok(source);
    }
    let config = crate::sync::remote::saved_config(db)
        .await?
        .ok_or_else(|| AppError::Config("还没连上网盘，找不到那台电脑".into()))?;
    let source = find(db, &config, video_id).await?.ok_or_else(|| {
        AppError::Other(
            "连不上局域网里那台电脑：确认它开着「局域网直连播放」，而且和这台设备在同一个 Wi‑Fi"
                .into(),
        )
    })?;
    remember_source(video_id, source.clone());
    Ok(source)
}

/// 手机上播放器报解码失败时问一声：电脑给的那份文件是什么编码。
/// 本机没有文件，读不了 stsd；老版本的电脑不报编码时给 None。
pub async fn phone_video_codec(video_id: &str) -> Option<String> {
    let source = source_for(video_id)?;
    fetch_file_info(&source).await.ok().flatten()?.codec
}

/// 问电脑 `/i/<id>`：整段下载会是多大的文件、什么扩展名。老版本的电脑没有这个接口时给 None。
async fn fetch_file_info(source: &RemoteSource) -> AppResult<Option<VideoFileInfo>> {
    let Some((base, id)) = source.url.rsplit_once("/v/") else {
        return Ok(None);
    };
    let response = source
        .authorize(source.client.get(format!("{base}/i/{id}")))
        .timeout(TRANSCODE_TIMEOUT)
        .send()
        .await
        .map_err(|error| AppError::Other(error.to_string()))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(AppError::Other(format!(
            "电脑回了个 {}，暂时不能下载",
            response.status()
        )));
    }
    Ok(response.json::<VideoFileInfo>().await.ok())
}

/// 老版本的电脑没有 `/i/`：退一步用 HEAD 拿大小，扩展名按内容类型猜（电脑只认 mp4/webm）。
async fn head_file_info(source: &RemoteSource) -> AppResult<Option<VideoFileInfo>> {
    let response = source
        .authorize(source.client.head(&source.url))
        .timeout(TRANSCODE_TIMEOUT)
        .send()
        .await
        .map_err(|error| AppError::Other(error.to_string()))?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let ext = match response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "video/webm" => "webm",
        "video/ogg" => "ogv",
        "audio/mp4" => "m4a",
        "audio/mpeg" => "mp3",
        _ => "mp4",
    };
    Ok(response
        .content_length()
        .filter(|size| *size > 0)
        .map(|size| VideoFileInfo {
            size,
            ext: ext.into(),
            codec: None,
        }))
}

/// 手机把整段视频存到本机，返回文件路径。下到的就是刚在播的那一份：电脑转过码时
/// `/v/` 给的是 playable.mp4，这里拿到的也是它。
///
/// 断点续传：`.part` 留着，下次从它已有的大小按 Range 接着要。下完核对大小再改名；
/// `file_path` 是本机的事，不在同步字段里，改了不会外发。
pub async fn download_video(
    db: &Db,
    video_root: &Path,
    video_id: &str,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> AppResult<PathBuf> {
    let title: String =
        sqlx::query_scalar("SELECT title FROM videos WHERE id=? AND deleted_at IS NULL")
            .bind(video_id)
            .fetch_optional(&db.pool)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("video {video_id}")))?;
    // 手机上整段下载动辄几分钟：iOS 申请后台继续跑，Android 起前台服务 + 唤醒锁，
    // 免得锁屏后系统把 App 挂起，下到一半停了。
    let _keep_alive = crate::keep_alive::hold(crate::keep_alive::Kind::Download, video_id, &title);
    let report = |done: u64, total: u64| {
        progress(done, total);
        if total > 0 {
            let fraction = done as f64 / total as f64;
            let detail = format!("下载 {}%", (fraction * 100.0).round() as i64);
            crate::keep_alive::report(video_id, "download", fraction, &detail);
        }
    };
    let source = remote_source(db, video_id).await?;
    // 电脑正在转码时 `/v/` 给的还是原片；转失败了多半也放不了。这会儿存下来，离线打开还是黑屏。
    if let Some(url) = transcode_url(&source) {
        if let Some(state) = fetch_transcode_state(&source, &url).await {
            match state.state.as_str() {
                "running" => {
                    return Err(AppError::Other(
                        "电脑正在把这个视频转成这台设备能播的格式，转完再存".into(),
                    ))
                }
                "failed" => {
                    return Err(AppError::Other(
                        "电脑上转码失败了，先在播放器里点「重试转码」，转好再存到本机".into(),
                    ))
                }
                _ => {}
            }
        }
    }
    let info = match fetch_file_info(&source).await? {
        Some(info) => info,
        None => head_file_info(&source).await?.ok_or_else(|| {
            AppError::Other("电脑上找不到这个视频的文件，可能被移走或删掉了".into())
        })?,
    };
    if info.size == 0 {
        return Err(AppError::Other("电脑上这个视频的文件是空的".into()));
    }
    let dir = video_root.join(video_id);
    tokio::fs::create_dir_all(&dir).await?;
    // 标题常常带着原文件的扩展名（「01.mp4」），再拼一次就成了 01.mp4.mp4。
    let base = Path::new(&title)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or(&title);
    let stem = crate::sync::media::safe_file_stem(base);
    let target = dir.join(format!("{stem}.{}", info.ext));
    // 已经下完了（比如上次成功但没刷新到界面）：直接算数。
    if tokio::fs::metadata(&target)
        .await
        .map(|meta| meta.len())
        .unwrap_or(0)
        == info.size
    {
        record_local_path(db, video_id, &target).await?;
        report(info.size, info.size);
        return Ok(target);
    }
    let partial = dir.join(format!("{stem}.{}.part", info.ext));
    let existing = tokio::fs::metadata(&partial)
        .await
        .map(|meta| meta.len())
        .unwrap_or(0);
    // 半截比整份还大：上次下的是另一份文件（比如电脑转完码换了源），从头来。
    let have = if existing <= info.size { existing } else { 0 };
    if have == info.size {
        // 上次停在「下完了还没改名」：直接收尾，不再多要一遍。
        tokio::fs::rename(&partial, &target).await?;
        record_local_path(db, video_id, &target).await?;
        report(info.size, info.size);
        return Ok(target);
    }

    let mut request = source.authorize(source.client.get(&source.url));
    if have > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| AppError::Other(error.to_string()))?;
    let resumed = have > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if !resumed && !response.status().is_success() {
        return Err(AppError::Other(format!(
            "电脑回了个 {}，暂时不能下载",
            response.status()
        )));
    }
    let mut written = if resumed { have } else { 0 };
    let mut file = if resumed {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&partial)
            .await?
    } else {
        tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&partial)
            .await?
    };
    report(written, info.size);
    let mut last_report = Instant::now();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                file.write_all(&chunk).await?;
                written += chunk.len() as u64;
                if last_report.elapsed() >= Duration::from_millis(150) {
                    report(written, info.size);
                    last_report = Instant::now();
                }
            }
            Ok(None) => break,
            Err(error) => {
                // 已经写进 .part 的那截留着，下次接着下。
                report(written, info.size);
                return Err(AppError::Other(format!(
                    "下载中断了（已下 {written} / {} 字节）：{error}",
                    info.size
                )));
            }
        }
    }
    if written != info.size {
        report(written, info.size);
        return Err(AppError::Other(format!(
            "下载没下完（{written} / {} 字节），再点一次会接着下",
            info.size
        )));
    }
    tokio::fs::rename(&partial, &target).await?;
    record_local_path(db, video_id, &target).await?;
    report(info.size, info.size);
    Ok(target)
}

async fn record_local_path(db: &Db, video_id: &str, path: &Path) -> AppResult<()> {
    sqlx::query("UPDATE videos SET file_path=? WHERE id=?")
        .bind(path.to_string_lossy().as_ref())
        .bind(video_id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn shared_video(dir: &std::path::Path) -> (Db, String) {
        let db = Db::connect_and_migrate(&dir.join("pc.db")).await.unwrap();
        let course =
            crate::commands::courses::create_course(&db, "c".into(), dir.to_string_lossy().into())
                .await
                .unwrap();
        let file = dir.join("01.mp4");
        std::fs::write(&file, b"0123456789abcdef").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, file, None)
            .await
            .unwrap();
        (db, video.id)
    }

    fn advert_for(port: u16, token: String, cert_sha256: String) -> Advert {
        Advert {
            addresses: vec!["127.0.0.1".into()],
            port,
            token,
            cert_sha256,
        }
    }

    /// 拼一个只带一条视频轨的最小 MP4：ftyp + moov/trak/mdia(hdlr)/minf/stbl/stsd。
    fn write_mp4_with_codec(path: &Path, codec: &[u8; 4]) {
        fn boxed(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
            let mut out = ((8 + payload.len()) as u32).to_be_bytes().to_vec();
            out.extend_from_slice(kind);
            out.extend_from_slice(payload);
            out
        }
        let mut hdlr = vec![0_u8; 8];
        hdlr.extend_from_slice(b"vide");
        let mut stsd = vec![0_u8; 8]; // version/flags + entry_count
        stsd.extend_from_slice(&16_u32.to_be_bytes());
        stsd.extend_from_slice(codec);
        let stbl = boxed(b"stbl", &boxed(b"stsd", &stsd));
        let minf = boxed(b"minf", &stbl);
        let mut mdia_payload = boxed(b"hdlr", &hdlr);
        mdia_payload.extend_from_slice(&minf);
        let moov = boxed(b"moov", &boxed(b"trak", &boxed(b"mdia", &mdia_payload)));
        let mut file = boxed(b"ftyp", &[0_u8; 16]);
        file.extend_from_slice(&moov);
        std::fs::write(path, file).unwrap();
    }

    /// 真跑一遍 ffmpeg：转出来的成品要是 H.264、进度写到 100、不留下半成品。
    /// 没打包 ffmpeg（或这台的 ffmpeg 没带 libx264）就跳过，别让这条依赖变成环境检查。
    #[tokio::test(flavor = "multi_thread")]
    async fn ffmpeg_transcode_writes_a_playable_h264_copy() {
        let Ok(ffmpeg) = crate::sidecar::resolve(&crate::sidecar::FFMPEG, None) else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.mp4");
        let generated = crate::sidecar::command(&ffmpeg)
            .args([
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=160x120:rate=10",
            ])
            .args(["-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&source)
            .status()
            .await;
        if !generated.map(|status| status.success()).unwrap_or(false) {
            return;
        }
        let target = dir.path().join("playable.mp4");
        let percent = AtomicU32::new(0);
        run_ffmpeg(&source, &target, &percent).await.unwrap();
        assert_eq!(percent.load(Ordering::Acquire), 100);
        assert!(converted_ready(&target));
        assert_eq!(
            crate::pipeline::playable::video_codec(&target),
            Some(*b"avc1")
        );
        assert!(!dir.path().join("playable.partial.mp4").exists());
    }

    #[test]
    fn transcode_progress_is_parsed_from_ffmpeg_output() {
        assert_eq!(
            parse_ffmpeg_duration("  Duration: 00:42:17.12, start: 0.000000, bitrate: 123 kb/s"),
            Some((42 * 60 + 17) * 1_000_000 + 120_000)
        );
        assert_eq!(
            parse_ffmpeg_duration("  Duration: N/A, start: 0.000000, bitrate: N/A"),
            None
        );
        assert_eq!(parse_out_time_us("out_time_us=1234567"), Some(1_234_567));
        // 老版本的 ffmpeg 只有 out_time_ms，单位同样是微秒。
        assert_eq!(parse_out_time_us("out_time_ms=1234567"), Some(1_234_567));
        assert_eq!(parse_out_time_us("out_time_us=N/A"), None);
        assert_eq!(parse_out_time_us("progress=continue"), None);
        assert_eq!(transcode_percent(30, 100), 30);
        assert_eq!(transcode_percent(150, 100), 99, "100% 只在真正落盘后写");
        assert_eq!(transcode_percent(10, 0), 0);
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

    #[test]
    fn only_addresses_another_device_could_reach_are_published() {
        let ok = |ip: &str| shareable_ipv4(ip.parse().unwrap());
        assert!(ok("10.83.186.220"));
        assert!(ok("172.20.10.2")); // iPhone 热点
        assert!(ok("192.168.1.5"));
        // TUN 代理（Clash / Surge）的假地址：以前问路由得到的就是这种，手机永远连不上。
        assert!(!ok("198.18.0.1"));
        assert!(!ok("198.19.2.3"));
        // 组网 / 运营商 NAT、回环、链路本地、组播、广播、保留段。
        assert!(!ok("100.100.1.2"));
        assert!(!ok("127.0.0.1"));
        assert!(!ok("169.254.40.189"));
        assert!(!ok("0.0.0.0"));
        assert!(!ok("224.0.0.1"));
        assert!(!ok("255.255.255.255"));
        assert!(is_tunnel("utun4", false));
        assert!(is_tunnel("wlan0", true));
        assert!(!is_tunnel("en0", false));
        assert!(!is_tunnel("wlp2s0", false));
        // Tailscale：Windows / Linux 上是普通名字的网卡，macOS 上挂在 utun 上，都要公布。
        let lan = |name: &str, p2p: bool, ip: &str| publishable(name, p2p, ip.parse().unwrap());
        assert!(lan("Tailscale", false, "100.100.1.2"));
        assert!(lan("utun5", true, "100.101.2.3"));
        assert!(lan("en0", false, "192.168.3.5"));
        assert!(!lan("utun4", true, "10.8.0.2")); // 别的 VPN
        assert!(!lan("utun6", false, "198.18.0.1"));
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
        let source = probe(std::slice::from_ref(&local), &video_id)
            .await
            .expect("找到了");
        let media = crate::media_server::start().await.unwrap();
        media.register_remote(&video_id, source.clone());
        let response = reqwest::Client::new()
            .get(media.url(&video_id))
            .header("Range", "bytes=4-7")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 206);
        assert_eq!(response.headers()["content-range"], "bytes 4-7/16");
        assert_eq!(response.bytes().await.unwrap().as_ref(), b"4567");
        assert_eq!(crate::media_server::remote_problem(&video_id), None);

        // 整段下载到本机：本地先有半截 .part，从半截接着下；下完 file_path 指过去。
        remember_source(&video_id, source.clone());
        let title: String = sqlx::query_scalar("SELECT title FROM videos WHERE id=?")
            .bind(&video_id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        let stem = crate::sync::media::safe_file_stem(
            std::path::Path::new(&title)
                .file_stem()
                .unwrap()
                .to_str()
                .unwrap(),
        );
        let phone_root = dir.path().join("phone");
        let phone_dir = phone_root.join(&video_id);
        std::fs::create_dir_all(&phone_dir).unwrap();
        std::fs::write(phone_dir.join(format!("{stem}.mp4.part")), b"0123456789").unwrap();
        let seen = std::sync::Mutex::new(Vec::new());
        let downloaded = download_video(&db, &phone_root, &video_id, &|done, _| {
            seen.lock().unwrap().push(done)
        })
        .await
        .unwrap();
        assert_eq!(
            downloaded.file_name().unwrap().to_string_lossy(),
            format!("{stem}.mp4")
        );
        assert_eq!(std::fs::read(&downloaded).unwrap(), b"0123456789abcdef");
        assert_eq!(
            seen.lock().unwrap().first(),
            Some(&10),
            "从已有的半截接着下，不从头再来"
        );
        assert!(!phone_dir.join(format!("{stem}.mp4.part")).exists());
        let stored: String = sqlx::query_scalar("SELECT file_path FROM videos WHERE id=?")
            .bind(&video_id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(stored, downloaded.to_string_lossy());

        // 手机问转码进度：还没转过是 idle；磁盘上已经有 H.264 成品就直接 done，不会再起 ffmpeg。
        let client = pinned_client(&published.cert_sha256).unwrap();
        let transcode = format!("https://127.0.0.1:{port}/t/{video_id}");
        let state: serde_json::Value = client
            .get(&transcode)
            .bearer_auth(&published.token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(state["state"], "idle");
        let (_, data_dir): (String, String) =
            sqlx::query_as("SELECT file_path, data_dir FROM videos WHERE id=?")
                .bind(&video_id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        write_mp4_with_codec(&playable_target(&data_dir), b"avc1");
        let state: serde_json::Value = client
            .post(&transcode)
            .bearer_auth(&published.token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(state["state"], "done");
        assert_eq!(state["percent"], 100);
        // 手机上本机没有文件，播放器报解码失败时问电脑：给的那份是什么编码。
        assert_eq!(phone_video_codec(&video_id).await.as_deref(), Some("avc1"));

        // 没有这个视频、口令不对、证书指纹不对：都找不到。
        assert!(probe(std::slice::from_ref(&local), "no-such-video")
            .await
            .is_none());
        let wrong_token = advert_for(port, "x".repeat(64), published.cert_sha256.clone());
        assert!(probe(&[wrong_token], &video_id).await.is_none());
        let wrong_cert = advert_for(port, published.token.clone(), "0".repeat(64));
        assert!(probe(&[wrong_cert], &video_id).await.is_none());

        // 进了回收站的不给。
        sqlx::query("UPDATE videos SET deleted_at=1 WHERE id=?")
            .bind(&video_id)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(probe(std::slice::from_ref(&local), &video_id)
            .await
            .is_none());

        // 关掉之后连不上，也不再公布；再打开沿用同一个端口和证书。
        stop();
        assert!(advert().is_none());
        assert!(probe(std::slice::from_ref(&local), &video_id)
            .await
            .is_none());
        // 电脑那头关了，手机上的转发连不上：记下原因，播放器卡住时摆给用户看。
        let response = reqwest::Client::new()
            .get(media.url(&video_id))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 502);
        let problem = crate::media_server::remote_problem(&video_id).expect("记下了转发的问题");
        assert!(problem.contains(&format!("127.0.0.1:{port}")), "{problem}");
        sqlx::query("UPDATE videos SET deleted_at=NULL WHERE id=?")
            .bind(&video_id)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(start(db.clone()).await.unwrap(), port);
        assert!(probe(std::slice::from_ref(&local), &video_id)
            .await
            .is_some());
        stop();
    }

    /// 手动测「局域网直连播放」用的电脑端：用当前代码开共享，带一门课和一个真视频，把课程数据和
    /// 局域网地址推到一个 WebDAV 上，然后一直跑着，等手机（真机 / 安卓模拟器）连同一个 WebDAV 来播。
    /// `COURSEPILOT_DAV_URL=http://127.0.0.1:18080/dav/ COURSEPILOT_DAV_USER=me COURSEPILOT_DAV_PASSWORD=secret \
    ///  COURSEPILOT_VIDEO=/path/to.mp4 COURSEPILOT_EXTRA_ADDR=10.0.2.2 cargo test --lib lan_pc_for_manual_test -- --ignored --nocapture`
    /// `COURSEPILOT_EXTRA_ADDR` 会加进公布的地址（安卓模拟器经 10.0.2.2 访问电脑）。
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "手动：给手机端测局域网直连播放用"]
    async fn lan_pc_for_manual_test() {
        let env = |key: &str| std::env::var(key).unwrap_or_else(|_| panic!("要设置 {key}"));
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("pc.db")).await.unwrap();
        let course = crate::commands::courses::create_course(&db, "局域网测试课".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, env("COURSEPILOT_VIDEO").into(), None)
            .await
            .unwrap();
        let config = crate::sync::remote::RemoteConfig {
            url: env("COURSEPILOT_DAV_URL"),
            folder: crate::sync::remote::DEFAULT_FOLDER.into(),
            user: env("COURSEPILOT_DAV_USER"),
            password: env("COURSEPILOT_DAV_PASSWORD"),
        };
        let sync = |db: Db, config: crate::sync::remote::RemoteConfig, root: std::path::PathBuf| async move {
            crate::sync::remote::run_once(&db, &config, &root.join("sync"), &root.join("videos")).await
        };
        println!("同步：{:?}", sync(db.clone(), config.clone(), dir.path().to_path_buf()).await.unwrap());
        let port = start(db.clone()).await.unwrap();
        let mut published = advert().expect("开着共享");
        if let Ok(extra) = std::env::var("COURSEPILOT_EXTRA_ADDR") {
            published.addresses.insert(0, extra);
        }
        let own = crate::sync::identity::ensure_sync_identity(&db).await.unwrap().device_id;
        let dav = config.client().unwrap();
        dav.put(
            &format!("{}{own}/{ADVERT_FILE}", crate::sync::remote::DEVICES_DIR),
            serde_json::to_vec(&published).unwrap(),
        )
        .await
        .unwrap();
        println!("电脑端就绪：端口 {port}，地址 {:?}，视频 {}（{}）", published.addresses, video.title, video.id);
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let _ = sync(db.clone(), config.clone(), dir.path().to_path_buf()).await;
        }
    }
}
