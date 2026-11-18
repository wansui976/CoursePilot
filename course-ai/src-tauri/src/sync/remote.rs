//! 网盘同步：用你自己的 WebDAV 网盘（坚果云、Nextcloud、群晖……）在 Windows / 安卓 / Mac / iOS
//! 之间同步学习数据。iCloud 那条只覆盖苹果设备，这条不挑系统。
//!
//! 同步什么沿用同步内核：课程 / 文件夹 / 视频条目、笔记（含图）、片段、复习卡、学习记录、
//! 播放进度。视频文件、字幕、AI 生成内容不同步——另一台设备上导入同一个视频文件时，
//! 会按内容指纹挂到同步过来的那一条上。
//!
//! 网盘里的布局（每台设备只写自己的文件夹，从不覆盖别人的，所以不会互相踩）：
//!
//! ```text
//! <用户选的文件夹>/sync-v1/devices/<设备 id>/device.json          设备名、系统、最近同步时间
//! <用户选的文件夹>/sync-v1/devices/<设备 id>/batches/000000000001.json  一批变更（信封数组）
//! ```
//!
//! 一轮同步：
//! 1. 对时：和服务器时钟差超过 5 分钟就不同步（合并靠墙钟比先后，钟歪了会安静地选错）；
//! 2. 推：第一次开启时把本机已有数据全部排进出件箱，之后把出件箱攒成批次上传，传完再确认；
//! 3. 拉：读别的设备新增的批次，写进进件目录（持久的队列），交给合并逻辑并进本地库。
//!
//! 投递是「至少一次」：上传成功但确认前崩溃，下次会再传一遍；读到一半断网，下次从游标续上。
//! 合并逻辑是幂等的，重复不会出错。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::commands::settings::{get_setting, set_setting};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::envelope::SyncEnvelope;
use crate::sync::webdav::WebDav;
use crate::sync::{apply, identity, outbox};

pub const SETTING_ENABLED: &str = "remote_sync_enabled";
pub const SETTING_URL: &str = "remote_sync_url";
pub const SETTING_FOLDER: &str = "remote_sync_folder";
pub const SETTING_USER: &str = "remote_sync_user";
pub const SECRET_PASSWORD: &str = "remote_sync_password";
const SETTING_NEXT_SEQ: &str = "remote_sync_next_seq";
const SETTING_LAST_SUCCESS: &str = "remote_sync_last_success";
const SETTING_LAST_ERROR: &str = "remote_sync_last_error";
/// 字幕和生成内容是后来才纳入同步的：已经开过同步的设备也要把这部分补推一次。
const SETTING_CONTENT_SNAPSHOT: &str = "remote_sync_content_snapshot";
/// 单个批次文件的大小上限。一份字幕带逐字时间能有一两 MB，别让一个批次大到几百 MB。
const BATCH_MAX_BYTES: usize = 8 * 1024 * 1024;

pub const DEFAULT_FOLDER: &str = "CoursePilot";
const DEVICES_DIR: &str = "sync-v1/devices/";
/// 一个批次最多装多少条变更。笔记图片的变更比较大，别让单个文件过大。
const BATCH_LIMIT: i64 = 100;
/// 一轮最多上传多少个批次（第一次开启时全量数据可能很多，分几轮传完）。
const MAX_BATCHES_PER_RUN: usize = 50;
/// 和服务器时钟允许的最大偏差。
const MAX_CLOCK_SKEW_MS: i64 = 5 * 60 * 1000;
/// 后台多久同步一轮。
const INTERVAL: Duration = Duration::from_secs(180);

pub const STATUS_EVENT: &str = "remote-sync:status";
pub const APPLIED_EVENT: &str = "remote-sync:applied";

#[derive(Debug, Clone)]
pub struct RemoteConfig {
    pub url: String,
    pub folder: String,
    pub user: String,
    pub password: String,
}

impl RemoteConfig {
    pub fn client(&self) -> AppResult<WebDav> {
        WebDav::new(&self.url, &self.folder, &self.user, &self.password)
    }
}

/// 读已保存的连接设置（不管开没开）。缺地址或账号时返回 None。
pub async fn saved_config(db: &Db) -> AppResult<Option<RemoteConfig>> {
    let url = get_setting(db, SETTING_URL).await?.unwrap_or_default();
    let user = get_setting(db, SETTING_USER).await?.unwrap_or_default();
    if url.trim().is_empty() || user.trim().is_empty() {
        return Ok(None);
    }
    let folder = get_setting(db, SETTING_FOLDER)
        .await?
        .filter(|folder| !folder.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_FOLDER.into());
    let password = crate::llm::keychain::get_secret(db, SECRET_PASSWORD).await?.unwrap_or_default();
    Ok(Some(RemoteConfig { url, folder, user, password }))
}

pub async fn is_enabled(db: &Db) -> AppResult<bool> {
    Ok(get_setting(db, SETTING_ENABLED).await?.as_deref() == Some("true"))
}

/// 这台设备在别的设备眼里叫什么。
pub fn device_label() -> String {
    let platform = if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "Mac"
    } else if cfg!(target_os = "android") {
        "安卓"
    } else if cfg!(target_os = "ios") {
        "iPhone / iPad"
    } else {
        "Linux"
    };
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|name| !name.trim().is_empty());
    match host {
        Some(host) => format!("{platform}（{host}）"),
        None => platform.to_string(),
    }
}

fn platform_code() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else {
        "linux"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceInfo {
    device_id: String,
    name: String,
    platform: String,
    last_sync_at: i64,
}

/// 网盘上看到的另一台设备。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDevice {
    pub device_id: String,
    pub name: Option<String>,
    pub platform: Option<String>,
    pub seen_at: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub pushed: usize,
    pub pulled: usize,
    pub applied: usize,
    pub parked: usize,
    /// 出件箱里还没传完的（全量首传可能要好几轮）。
    pub pending: i64,
}

/// 连接测试：能连上、账号对、时钟没歪、能建文件夹。返回网盘上已有几台设备。
pub async fn test_connection(config: &RemoteConfig) -> AppResult<usize> {
    let dav = config.client()?;
    check_clock(&dav).await?;
    dav.ensure_root().await?;
    dav.ensure_dir(DEVICES_DIR).await?;
    Ok(dav.list(DEVICES_DIR).await?.map(|entries| entries.iter().filter(|entry| entry.is_dir).count()).unwrap_or(0))
}

async fn check_clock(dav: &WebDav) -> AppResult<()> {
    if let Some(offset) = dav.clock_offset_ms().await? {
        if offset.abs() > MAX_CLOCK_SKEW_MS {
            return Err(AppError::Config(format!(
                "这台设备的时钟和服务器差了 {} 分钟。合并改动要按时间比先后，时钟不准会选错版本——先把系统时间设成自动同步再试",
                offset.abs() / 60_000
            )));
        }
    }
    Ok(())
}

/// 同步一轮。`spool_root` 是本地进件目录所在（应用数据目录下的 sync/），`video_root`
/// 是同步过来的视频条目放数据目录的地方。
pub async fn run_once(db: &Db, config: &RemoteConfig, spool_root: &Path, video_root: &Path) -> AppResult<RunReport> {
    let dav = config.client()?;
    check_clock(&dav).await?;
    let identity = identity::ensure_sync_identity(db).await?;
    let device_id = identity.device_id.clone();
    let own_dir = format!("{DEVICES_DIR}{device_id}/");
    let batches_dir = format!("{own_dir}batches/");
    dav.ensure_root().await?;
    dav.ensure_dir(&batches_dir).await?;

    // 第一次开启：本机已有的数据全部排进出件箱（出件箱只记开启同步内核之后的改动）。
    if !identity.bootstrap_complete {
        identity::enqueue_local_snapshot(db).await?;
        sqlx::query("UPDATE sync_device_state SET bootstrap_complete=1 WHERE singleton=1")
            .execute(&db.pool)
            .await?;
    }
    if get_setting(db, SETTING_CONTENT_SNAPSHOT).await?.as_deref() != Some("1") {
        crate::sync::content::enqueue_snapshot(db).await?;
        set_setting(db, SETTING_CONTENT_SNAPSHOT, "1").await?;
    }

    let mut report = RunReport::default();
    report.pushed = push(db, &dav, &batches_dir).await?;

    let incoming = spool_root.join("incoming");
    std::fs::create_dir_all(&incoming)?;
    report.pulled = pull(db, &dav, &device_id, &incoming).await?;
    let applied = apply::apply_incoming(db, &incoming, Some(video_root)).await?;
    report.applied = applied.applied;
    report.parked = applied.parked;
    report.pending = outbox::pending_count(db).await?;

    let info = DeviceInfo {
        device_id: device_id.clone(),
        name: device_label(),
        platform: platform_code().into(),
        last_sync_at: chrono::Utc::now().timestamp_millis(),
    };
    dav.put(&format!("{own_dir}device.json"), serde_json::to_vec(&info)?).await?;
    Ok(report)
}

/// 下一个批次序号。重装应用后本地计数归零，而别的设备按文件名记游标——新批次的名字必须
/// 比网盘上已有的都大，否则会被当成读过的跳掉。所以取本地计数和网盘上已有最大序号 + 1 的较大者。
async fn next_seq(db: &Db, dav: &WebDav, batches_dir: &str) -> AppResult<u64> {
    let local: u64 = get_setting(db, SETTING_NEXT_SEQ).await?.and_then(|value| value.parse().ok()).unwrap_or(1);
    let remote = dav
        .list(batches_dir)
        .await?
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| entry.name.strip_suffix(".json")?.parse::<u64>().ok())
        .max()
        .map(|max| max + 1)
        .unwrap_or(1);
    Ok(local.max(remote))
}

/// 按体积把一批变更切成几个文件：每个不超过 BATCH_MAX_BYTES（单条就超的自己一个文件）。
fn split_by_size(envelopes: &[SyncEnvelope]) -> AppResult<Vec<Vec<SyncEnvelope>>> {
    let mut chunks: Vec<Vec<SyncEnvelope>> = Vec::new();
    let mut size = 0usize;
    for envelope in envelopes {
        let bytes = serde_json::to_vec(envelope)?.len() + 1;
        if chunks.is_empty() || (size + bytes > BATCH_MAX_BYTES && !chunks.last().unwrap().is_empty()) {
            chunks.push(Vec::new());
            size = 0;
        }
        chunks.last_mut().unwrap().push(envelope.clone());
        size += bytes;
    }
    Ok(chunks)
}

fn batch_name(seq: u64) -> String {
    format!("{seq:012}.json")
}

async fn push(db: &Db, dav: &WebDav, batches_dir: &str) -> AppResult<usize> {
    if outbox::pending_count(db).await? == 0 {
        return Ok(0);
    }
    let mut seq = next_seq(db, dav, batches_dir).await?;
    let mut pushed = 0;
    for _ in 0..MAX_BATCHES_PER_RUN {
        let envelopes = outbox::materialize_batch(db, BATCH_LIMIT).await?;
        if envelopes.is_empty() {
            break;
        }
        let chunks = split_by_size(&envelopes)?;
        for (index, chunk) in chunks.iter().enumerate() {
            if let Err(error) = dav.put(&format!("{batches_dir}{}", batch_name(seq)), serde_json::to_vec(chunk)?).await {
                // 这一块和后面还没传的都放回出件箱；前面已经传上去的已经确认过了。
                let message = error.to_string();
                for envelope in chunks[index..].iter().flatten() {
                    let _ = outbox::release_failed(db, &envelope.record_type, &envelope.record_id, &envelope.version, &message).await;
                }
                return Err(error);
            }
            seq += 1;
            set_setting(db, SETTING_NEXT_SEQ, &seq.to_string()).await?;
            for envelope in chunk {
                let cleared =
                    outbox::acknowledge(db, &envelope.record_type, &envelope.record_id, &envelope.version, None).await?;
                // 笔记要记下「和对端达成一致」时的内容，之后两边都改才能判成并发、保留双方。
                if cleared && envelope.record_type == "Note" {
                    apply::record_acked_note_basis(db, &envelope.record_id, envelope.updated_at).await?;
                }
            }
            pushed += chunk.len();
        }
    }
    Ok(pushed)
}

async fn pull(db: &Db, dav: &WebDav, own_device: &str, incoming: &Path) -> AppResult<usize> {
    let devices = dav.list(DEVICES_DIR).await?.unwrap_or_default();
    let mut pulled = 0;
    for device in devices.iter().filter(|entry| entry.is_dir && entry.name != own_device) {
        let device_dir = format!("{DEVICES_DIR}{}/", device.name);
        let cursor: Option<String> =
            sqlx::query_scalar("SELECT last_batch FROM sync_remote_cursors WHERE device_id=?")
                .bind(&device.name)
                .fetch_optional(&db.pool)
                .await?;
        let info: Option<DeviceInfo> = match dav.get(&format!("{device_dir}device.json")).await {
            Ok(bytes) => serde_json::from_slice(&bytes).ok(),
            Err(_) => None,
        };
        let mut batches: Vec<String> = dav
            .list(&format!("{device_dir}batches/"))
            .await?
            .unwrap_or_default()
            .into_iter()
            .filter(|entry| !entry.is_dir && entry.name.ends_with(".json"))
            .map(|entry| entry.name)
            .filter(|name| cursor.as_deref().is_none_or(|cursor| name.as_str() > cursor))
            .collect();
        batches.sort();
        let mut last = cursor.clone();
        for name in batches {
            let bytes = dav.get(&format!("{device_dir}batches/{name}")).await?;
            // 读坏了（上传还没写完、文件损坏）：停在这里，游标不往前走，下一轮再读。
            let Ok(envelopes) = serde_json::from_slice::<Vec<SyncEnvelope>>(&bytes) else {
                tracing::warn!(device = %device.name, batch = %name, "同步批次读不出来，下一轮再试");
                break;
            };
            for (index, envelope) in envelopes.iter().enumerate() {
                write_incoming(incoming, &format!("remote-{}-{}-{index}", device.name, name.trim_end_matches(".json")), envelope)?;
            }
            pulled += envelopes.len();
            last = Some(name.clone());
            // 每读完一批就记游标：信封已经落进进件目录（持久的），断在哪都能续上。
            save_cursor(db, &device.name, &name, info.as_ref()).await?;
        }
        if last == cursor {
            if let Some(cursor) = cursor {
                save_cursor(db, &device.name, &cursor, info.as_ref()).await?;
            }
        }
    }
    Ok(pulled)
}

fn write_incoming(dir: &Path, stem: &str, envelope: &SyncEnvelope) -> AppResult<()> {
    let destination = dir.join(format!("{stem}.json"));
    let temporary = dir.join(format!(".{stem}.tmp"));
    std::fs::write(&temporary, serde_json::to_vec(envelope)?)?;
    std::fs::rename(&temporary, &destination)?;
    Ok(())
}

async fn save_cursor(db: &Db, device_id: &str, batch: &str, info: Option<&DeviceInfo>) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO sync_remote_cursors(device_id,last_batch,device_name,platform,seen_at) VALUES (?,?,?,?,?)
         ON CONFLICT(device_id) DO UPDATE SET last_batch=excluded.last_batch,
           device_name=COALESCE(excluded.device_name, sync_remote_cursors.device_name),
           platform=COALESCE(excluded.platform, sync_remote_cursors.platform),
           seen_at=excluded.seen_at",
    )
    .bind(device_id)
    .bind(batch)
    .bind(info.map(|info| info.name.clone()))
    .bind(info.map(|info| info.platform.clone()))
    .bind(info.map(|info| info.last_sync_at).unwrap_or_else(|| chrono::Utc::now().timestamp_millis()))
    .execute(&db.pool)
    .await?;
    Ok(())
}

pub async fn known_devices(db: &Db) -> AppResult<Vec<RemoteDevice>> {
    let rows: Vec<(String, Option<String>, Option<String>, i64)> = sqlx::query_as(
        "SELECT device_id, device_name, platform, seen_at FROM sync_remote_cursors ORDER BY seen_at DESC",
    )
    .fetch_all(&db.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(device_id, name, platform, seen_at)| RemoteDevice { device_id, name, platform, seen_at })
        .collect())
}

// ---------------------------------------------------------------------------
// 后台调度

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    pub running: bool,
    pub last_success_at: Option<i64>,
    pub last_error: Option<String>,
    pub last_report: Option<RunReport>,
}

struct Engine {
    app: tauri::AppHandle,
    db: Db,
    wake: tokio::sync::Notify,
    lock: tokio::sync::Mutex<()>,
    state: Mutex<RunState>,
}

static ENGINE: OnceLock<Arc<Engine>> = OnceLock::new();

/// 应用启动时调用一次。没开同步时后台线程只是定时看一眼设置。
pub fn init(app: tauri::AppHandle, db: Db) {
    let engine = ENGINE
        .get_or_init(|| {
            Arc::new(Engine {
                app,
                db,
                wake: tokio::sync::Notify::new(),
                lock: tokio::sync::Mutex::new(()),
                state: Mutex::new(RunState::default()),
            })
        })
        .clone();
    tauri::async_runtime::spawn(async move {
        engine.restore_state().await;
        // 启动后稍等一下再同步，别和启动时的其它工作抢。
        tokio::time::sleep(Duration::from_secs(8)).await;
        loop {
            let _ = engine.run_if_enabled().await;
            tokio::select! {
                _ = engine.wake.notified() => {}
                _ = tokio::time::sleep(INTERVAL) => {}
            }
        }
    });
}

/// 让后台尽快同步一轮（回到前台、刚改完设置）。
pub fn nudge() {
    if let Some(engine) = ENGINE.get() {
        engine.wake.notify_one();
    }
}

/// 立刻同步一轮并等结果（「立即同步」按钮）。
pub async fn run_now() -> AppResult<RunReport> {
    let engine = ENGINE.get().cloned().ok_or_else(|| AppError::Other("同步还没准备好".into()))?;
    engine.run().await
}

pub fn state() -> RunState {
    ENGINE.get().map(|engine| engine.state.lock().unwrap().clone()).unwrap_or_default()
}

impl Engine {
    async fn restore_state(&self) {
        let last_success_at = get_setting(&self.db, SETTING_LAST_SUCCESS).await.ok().flatten().and_then(|v| v.parse().ok());
        let last_error = get_setting(&self.db, SETTING_LAST_ERROR).await.ok().flatten().filter(|v| !v.is_empty());
        let mut state = self.state.lock().unwrap();
        state.last_success_at = last_success_at;
        state.last_error = last_error;
    }

    fn emit(&self) {
        let snapshot = self.state.lock().unwrap().clone();
        self.app.emit(STATUS_EVENT, snapshot).ok();
    }

    async fn run_if_enabled(&self) -> AppResult<()> {
        if !is_enabled(&self.db).await? {
            return Ok(());
        }
        self.run().await.map(|_| ())
    }

    async fn run(&self) -> AppResult<RunReport> {
        let _guard = self.lock.lock().await;
        let config = saved_config(&self.db)
            .await?
            .ok_or_else(|| AppError::Config("还没填网盘地址和账号".into()))?;
        let app_data = self.app.path().app_data_dir().map_err(|error| AppError::Config(error.to_string()))?;
        let spool_root: PathBuf = app_data.join("sync");
        let video_root = app_data.join("synced-videos");
        self.state.lock().unwrap().running = true;
        self.emit();
        let result = run_once(&self.db, &config, &spool_root, &video_root).await;
        let now = chrono::Utc::now().timestamp_millis();
        {
            let mut state = self.state.lock().unwrap();
            state.running = false;
            match &result {
                Ok(report) => {
                    state.last_success_at = Some(now);
                    state.last_error = None;
                    state.last_report = Some(report.clone());
                }
                Err(error) => state.last_error = Some(error.to_string()),
            }
        }
        match &result {
            Ok(report) => {
                let _ = set_setting(&self.db, SETTING_LAST_SUCCESS, &now.to_string()).await;
                let _ = set_setting(&self.db, SETTING_LAST_ERROR, "").await;
                if report.applied > 0 {
                    self.app.emit(APPLIED_EVENT, report.applied).ok();
                }
                // 首次全量一轮传不完：接着传，不等下一个周期。
                if report.pending > 0 && report.pushed > 0 {
                    self.wake.notify_one();
                }
            }
            Err(error) => {
                tracing::warn!(%error, "网盘同步失败");
                let _ = set_setting(&self.db, SETTING_LAST_ERROR, &error.to_string()).await;
            }
        }
        self.emit();
        result
    }
}

#[cfg(test)]
pub(crate) mod test_server {
    //! 测试用的内存 WebDAV 服务器：只实现同步用到的 PROPFIND / MKCOL / PUT / GET。
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[derive(Default)]
    pub struct Store {
        pub files: BTreeMap<String, Vec<u8>>,
        pub dirs: BTreeSet<String>,
        /// 服务器时钟相对真实时间的偏移（毫秒），用来测「时钟歪了」。
        pub clock_offset_ms: i64,
    }

    pub async fn start() -> (String, Arc<Mutex<Store>>) {
        let store = Arc::new(Mutex::new(Store::default()));
        store.lock().unwrap().dirs.insert("/dav/".into());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let shared = store.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let store = shared.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 65536];
                    let (head, body) = loop {
                        let n = socket.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        let Some(split) = buf.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                        let head = String::from_utf8_lossy(&buf[..split]).to_string();
                        let length = head
                            .lines()
                            .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        if buf.len() >= split + 4 + length {
                            break (head, buf[split + 4..split + 4 + length].to_vec());
                        }
                    };
                    let mut parts = head.lines().next().unwrap_or("").split_whitespace();
                    let method = parts.next().unwrap_or("").to_string();
                    let path = parts.next().unwrap_or("").to_string();
                    let (status, response_body) = {
                        let mut store = store.lock().unwrap();
                        handle(&mut store, &method, &path, body)
                    };
                    let offset = store.lock().unwrap().clock_offset_ms;
                    let date = (chrono::Utc::now() + chrono::Duration::milliseconds(offset)).to_rfc2822().replace("+0000", "GMT");
                    let response = format!(
                        "HTTP/1.1 {status}\r\nDate: {date}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        response_body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.write_all(&response_body).await;
                });
            }
        });
        (format!("http://{addr}/dav/"), store)
    }

    fn parent(path: &str) -> String {
        let trimmed = path.trim_end_matches('/');
        match trimmed.rfind('/') {
            Some(index) => trimmed[..=index].to_string(),
            None => "/".into(),
        }
    }

    fn handle(store: &mut Store, method: &str, path: &str, body: Vec<u8>) -> (&'static str, Vec<u8>) {
        match method {
            "MKCOL" => {
                let dir = if path.ends_with('/') { path.to_string() } else { format!("{path}/") };
                if store.dirs.contains(&dir) {
                    ("405 Method Not Allowed", Vec::new())
                } else if !store.dirs.contains(&parent(&dir)) {
                    ("409 Conflict", Vec::new())
                } else {
                    store.dirs.insert(dir);
                    ("201 Created", Vec::new())
                }
            }
            "PUT" => {
                if !store.dirs.contains(&parent(path)) {
                    return ("409 Conflict", Vec::new());
                }
                store.files.insert(path.to_string(), body);
                ("201 Created", Vec::new())
            }
            "GET" => match store.files.get(path) {
                Some(bytes) => ("200 OK", bytes.clone()),
                None => ("404 Not Found", Vec::new()),
            },
            "PROPFIND" => {
                let dir = if path.ends_with('/') { path.to_string() } else { format!("{path}/") };
                if !store.dirs.contains(&dir) {
                    return ("404 Not Found", Vec::new());
                }
                let mut xml = String::from(r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">"#);
                xml.push_str(&format!("<d:response><d:href>{dir}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>"));
                for child in store.dirs.iter().filter(|d| *d != &dir && parent(d) == dir) {
                    xml.push_str(&format!("<d:response><d:href>{child}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>"));
                }
                for file in store.files.keys().filter(|f| parent(f) == dir) {
                    xml.push_str(&format!("<d:response><d:href>{file}</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response>"));
                }
                xml.push_str("</d:multistatus>");
                ("207 Multi-Status", xml.into_bytes())
            }
            _ => ("405 Method Not Allowed", Vec::new()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Device {
        db: Db,
        dir: tempfile::TempDir,
    }

    impl Device {
        async fn new(name: &str) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let db = Db::connect_and_migrate(&dir.path().join(format!("{name}.db"))).await.unwrap();
            Self { db, dir }
        }

        async fn sync(&self, config: &RemoteConfig) -> AppResult<RunReport> {
            run_once(&self.db, config, &self.dir.path().join("sync"), &self.dir.path().join("synced-videos")).await
        }
    }

    fn config(url: &str) -> RemoteConfig {
        RemoteConfig { url: url.into(), folder: "学习/CoursePilot".into(), user: "u".into(), password: "p".into() }
    }

    async fn progress(db: &Db, video_id: &str) -> Option<i64> {
        sqlx::query_scalar("SELECT position_ms FROM video_progress WHERE video_id=?")
            .bind(video_id)
            .fetch_optional(&db.pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_pc_and_a_phone_sync_courses_videos_and_progress_both_ways() {
        let (url, store) = test_server::start().await;
        let config = config(&url);
        let pc = Device::new("pc").await;
        let phone = Device::new("phone").await;

        // 电脑上已有的课程、视频和进度（开同步之前就有的）。
        let course = crate::commands::courses::create_course(&pc.db, "申论".into(), pc.dir.path().to_string_lossy().into()).await.unwrap();
        let file = pc.dir.path().join("01.mp4");
        std::fs::write(&file, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&pc.db, &course.id, file, None).await.unwrap();
        crate::commands::stats::save_video_progress(&pc.db, &video.id, 61_000, Some(600_000)).await.unwrap();

        let report = pc.sync(&config).await.unwrap();
        assert!(report.pushed >= 3, "{report:?}");
        assert_eq!(report.pending, 0);
        assert!(store.lock().unwrap().files.keys().any(|path| path.contains("/batches/000000000001.json")));

        // 手机第一次同步：课程、视频条目（无媒体文件的占位）、进度都过来了。
        let report = phone.sync(&config).await.unwrap();
        assert!(report.applied >= 3, "{report:?}");
        let title: String = sqlx::query_scalar("SELECT title FROM videos WHERE id=?").bind(&video.id).fetch_one(&phone.db.pool).await.unwrap();
        assert_eq!(title, video.title);
        let file_path: String = sqlx::query_scalar("SELECT file_path FROM videos WHERE id=?").bind(&video.id).fetch_one(&phone.db.pool).await.unwrap();
        assert_eq!(file_path, "", "手机上没有这个视频文件，是占位");
        assert_eq!(progress(&phone.db, &video.id).await, Some(61_000));
        assert_eq!(known_devices(&phone.db).await.unwrap().len(), 1);

        // 手机上接着看，进度回到电脑。合并时不往回发（回声抑制），电脑那边也不重复收自己的。
        tokio::time::sleep(Duration::from_millis(5)).await;
        crate::commands::stats::save_video_progress(&phone.db, &video.id, 300_000, Some(600_000)).await.unwrap();
        let report = phone.sync(&config).await.unwrap();
        assert_eq!(report.pushed, 1, "{report:?}");
        pc.sync(&config).await.unwrap();
        assert_eq!(progress(&pc.db, &video.id).await, Some(300_000));

        // 再同步一轮什么都不变：没有新的推送，也没有重复的合并。
        let again = pc.sync(&config).await.unwrap();
        assert_eq!((again.pushed, again.pulled), (0, 0), "{again:?}");
        let again = phone.sync(&config).await.unwrap();
        assert_eq!((again.pushed, again.pulled), (0, 0), "{again:?}");
    }

    #[tokio::test]
    async fn transcripts_and_generated_content_follow_the_video_to_the_phone() {
        let (url, _store) = test_server::start().await;
        let config = config(&url);
        let pc = Device::new("pc").await;
        let phone = Device::new("phone").await;
        let course = crate::commands::courses::create_course(&pc.db, "申论".into(), pc.dir.path().to_string_lossy().into()).await.unwrap();
        let file = pc.dir.path().join("01.mp4");
        std::fs::write(&file, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&pc.db, &course.id, file, None).await.unwrap();
        let exec = |sql: &'static str| {
            let db = pc.db.clone();
            let id = video.id.clone();
            async move { sqlx::query(sql).bind(id).execute(&db.pool).await.unwrap(); }
        };
        for i in 0..3 {
            sqlx::query("INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text,words_json) VALUES (?,?,?,?,?,?)")
                .bind(&video.id).bind(i).bind(i * 1000).bind(i * 1000 + 900).bind(format!("第{i}句")).bind(Some("[]"))
                .execute(&pc.db.pool).await.unwrap();
        }
        exec("INSERT INTO summaries(video_id,content_md,generated_at) VALUES (?,'摘要 v1',1)").await;
        exec("INSERT INTO chapters(video_id,title,summary,start_ms,end_ms,order_index) VALUES (?,'开头','引入',0,900,0)").await;
        exec("INSERT INTO quizzes(video_id,questions_json,generated_at) VALUES (?,'[1,2]',1)").await;
        exec("INSERT INTO ai_artifact_sources(video_id,artifact,fingerprint,generated_at) VALUES (?,'summary','fp-1',1)").await;
        sqlx::query("INSERT INTO concepts(id,course_id,name,created_at,explanation) VALUES ('k1',?,'概括题',1,'讲解')")
            .bind(&course.id).execute(&pc.db.pool).await.unwrap();
        sqlx::query("INSERT INTO concept_occurrences(concept_id,video_id,start_ms) VALUES ('k1',?,1000)")
            .bind(&video.id).execute(&pc.db.pool).await.unwrap();

        pc.sync(&config).await.unwrap();
        let report = phone.sync(&config).await.unwrap();
        assert_eq!(report.parked, 0, "{report:?}");

        let segments: Vec<String> = sqlx::query_scalar("SELECT text FROM transcripts WHERE video_id=? ORDER BY segment_idx")
            .bind(&video.id).fetch_all(&phone.db.pool).await.unwrap();
        assert_eq!(segments, ["第0句", "第1句", "第2句"]);
        let summary: String = sqlx::query_scalar("SELECT content_md FROM summaries WHERE video_id=?").bind(&video.id).fetch_one(&phone.db.pool).await.unwrap();
        assert_eq!(summary, "摘要 v1");
        let fingerprint: String = sqlx::query_scalar("SELECT fingerprint FROM ai_artifact_sources WHERE video_id=? AND artifact='summary'")
            .bind(&video.id).fetch_one(&phone.db.pool).await.unwrap();
        assert_eq!(fingerprint, "fp-1", "过期判断靠的指纹一起过来");
        let chapters: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chapters WHERE video_id=?").bind(&video.id).fetch_one(&phone.db.pool).await.unwrap();
        assert_eq!(chapters, 1);
        let quiz: String = sqlx::query_scalar("SELECT questions_json FROM quizzes WHERE video_id=?").bind(&video.id).fetch_one(&phone.db.pool).await.unwrap();
        assert_eq!(quiz, "[1,2]");
        let occurrence: i64 = sqlx::query_scalar("SELECT start_ms FROM concept_occurrences WHERE concept_id='k1' AND video_id=?")
            .bind(&video.id).fetch_one(&phone.db.pool).await.unwrap();
        assert_eq!(occurrence, 1000, "知识点 id 不变，出处指向同一个视频");
        // 合并进来的内容不会再被当成本机改动发回去。
        assert_eq!(crate::sync::outbox::pending_count(&phone.db).await.unwrap(), 0);

        // 手机上重新生成摘要，回到电脑；电脑那边的字幕不受影响。
        tokio::time::sleep(Duration::from_millis(5)).await;
        sqlx::query("UPDATE summaries SET content_md='摘要 v2', generated_at=2 WHERE video_id=?")
            .bind(&video.id).execute(&phone.db.pool).await.unwrap();
        phone.sync(&config).await.unwrap();
        pc.sync(&config).await.unwrap();
        let summary: String = sqlx::query_scalar("SELECT content_md FROM summaries WHERE video_id=?").bind(&video.id).fetch_one(&pc.db.pool).await.unwrap();
        assert_eq!(summary, "摘要 v2");
        let segments: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcripts WHERE video_id=?").bind(&video.id).fetch_one(&pc.db.pool).await.unwrap();
        assert_eq!(segments, 3);
    }

    #[test]
    fn large_batches_are_split_into_files_under_the_size_limit() {
        let big = "字".repeat(3 * 1024 * 1024 / 3);
        let envelope = |id: &str| SyncEnvelope::new(
            "Transcript".into(),
            id.into(),
            crate::sync::envelope::SyncOperation::Save,
            crate::sync::envelope::SyncVersion { counter: 1, device: "d".into() },
            1,
            serde_json::json!({"segments": [[0, 0, 1, big]]}),
        );
        let chunks = split_by_size(&[envelope("a"), envelope("b"), envelope("c"), envelope("d")]).unwrap();
        assert!(chunks.len() >= 2, "{}", chunks.len());
        assert_eq!(chunks.iter().map(Vec::len).sum::<usize>(), 4);
        for chunk in &chunks {
            assert!(serde_json::to_vec(chunk).unwrap().len() <= BATCH_MAX_BYTES + 3 * 1024 * 1024 + 64);
        }
    }

    #[tokio::test]
    async fn a_reinstalled_device_keeps_numbering_after_its_existing_batches() {
        let (url, store) = test_server::start().await;
        let config = config(&url);
        let device = Device::new("pc").await;
        crate::commands::courses::create_course(&device.db, "a".into(), "/tmp".into()).await.unwrap();
        device.sync(&config).await.unwrap();
        // 模拟重装：本地序号丢了。
        set_setting(&device.db, SETTING_NEXT_SEQ, "1").await.unwrap();
        crate::commands::courses::create_course(&device.db, "b".into(), "/tmp".into()).await.unwrap();
        device.sync(&config).await.unwrap();
        let batches: Vec<String> = store.lock().unwrap().files.keys().filter(|path| path.contains("/batches/")).cloned().collect();
        assert!(batches.iter().any(|path| path.ends_with("000000000002.json")), "{batches:?}");
        assert_eq!(batches.len(), 2, "没有覆盖已有的批次：{batches:?}");
    }

    #[tokio::test]
    async fn a_skewed_clock_stops_the_sync_with_an_explanation() {
        let (url, store) = test_server::start().await;
        store.lock().unwrap().clock_offset_ms = 20 * 60 * 1000;
        let device = Device::new("pc").await;
        let error = device.sync(&config(&url)).await.unwrap_err().to_string();
        assert!(error.contains("时钟"), "{error}");
        assert!(store.lock().unwrap().files.is_empty(), "时钟不对时什么都不写");
    }

    #[tokio::test]
    async fn the_connection_test_creates_the_folder_and_counts_devices() {
        let (url, _store) = test_server::start().await;
        assert_eq!(test_connection(&config(&url)).await.unwrap(), 0);
    }
}
