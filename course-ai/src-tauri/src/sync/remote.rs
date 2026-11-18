//! 网盘同步：用你自己的 WebDAV 网盘（坚果云、Nextcloud、群晖……）在 Windows / 安卓 / Mac / iOS
//! 之间同步学习数据。iCloud 那条只覆盖苹果设备，这条不挑系统。
//!
//! 同步什么沿用同步内核：课程 / 文件夹 / 视频条目、笔记（含图）、片段、复习卡、学习记录、
//! 播放进度，以及字幕和 AI 生成的内容（content.rs）。视频文件另走一条：打开了「上传视频文件」
//! 的设备把文件分块传到 `sync-v1/media/`，别的设备打开没有文件的视频时下载（media.rs）。
//!
//! 批次会一直累积：攒够了就压缩成一份底稿，旧批次删掉（compact.rs）。
//!
//! 网盘里的布局（每台设备只写自己的文件夹，从不覆盖别人的，所以不会互相踩）：
//!
//! ```text
//! <用户选的文件夹>/sync-v1/devices/<设备 id>/device.json          设备名、系统、最近同步时间
//! <用户选的文件夹>/sync-v1/devices/<设备 id>/batches/000000000001.json  一批变更（信封数组）
//! <用户选的文件夹>/sync-v1/devices/<设备 id>/batches/base-000000000250.json  底稿清单（见 compact.rs）
//! <用户选的文件夹>/sync-v1/devices/<设备 id>/base/<内容哈希>.json      底稿：批次压缩后每条记录一份
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
use crate::sync::compact::{self, batch_name, batch_seq, Listing};
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
/// 自己的批次最近一次压缩到第几批；还有旧文件没删完时记一个「待清理」。
const SETTING_BASE_UPTO: &str = "remote_sync_base_upto";
const SETTING_TIDY_PENDING: &str = "remote_sync_tidy_pending";
/// 单个批次文件的大小上限。一份字幕带逐字时间能有一两 MB，别让一个批次大到几百 MB。
const BATCH_MAX_BYTES: usize = 8 * 1024 * 1024;

pub const DEFAULT_FOLDER: &str = "CoursePilot";
pub const DEVICES_DIR: &str = "sync-v1/devices/";
/// 一个批次最多装多少条变更。笔记图片的变更比较大，别让单个文件过大。
const BATCH_LIMIT: i64 = 100;
/// 一轮最多上传多少个批次（第一次开启时全量数据可能很多，分几轮传完）。
const MAX_BATCHES_PER_RUN: usize = 50;
/// 和服务器时钟允许的最大偏差。
const MAX_CLOCK_SKEW_MS: i64 = 5 * 60 * 1000;
/// 后台同步的间隔：有改动时 3 分钟一轮；连续没有改动就逐步放慢，最长 30 分钟。
/// 本机一有改动（每分钟在本地看一眼出件箱，不发请求）就在半分钟内推出去，不等这个间隔。
const MIN_INTERVAL: Duration = Duration::from_secs(180);
const MAX_INTERVAL: Duration = Duration::from_secs(1800);
const LOCAL_CHECK: Duration = Duration::from_secs(60);
const LOCAL_DEBOUNCE: Duration = Duration::from_secs(30);
/// 和服务器对时多久做一次（钟不会几分钟就歪）。
const CLOCK_CHECK_EVERY: Duration = Duration::from_secs(3600);

pub const STATUS_EVENT: &str = "remote-sync:status";
pub const MEDIA_EVENT: &str = "remote-sync:media";
pub const DOWNLOAD_EVENT: &str = "remote-sync:download";
pub const SETTING_UPLOAD_MEDIA: &str = "remote_sync_upload_media";
/// 视频上传多久检查一轮（数据同步成功后也会立刻检查）。
const MEDIA_INTERVAL: Duration = Duration::from_secs(1800);
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
/// 这次运行里对每个网盘做过的准备（建文件夹、对时、写设备信息）。空闲的一轮不必再做一遍：
/// 坚果云这类服务按请求数限频，每轮少发几个请求，3 分钟一轮也不至于被限流。
#[derive(Default)]
struct Prepared {
    dirs_ready: bool,
    clock_checked: Option<std::time::Instant>,
    device_info_written: bool,
    /// 上次写到网盘上的局域网地址（`Some(None)` = 已经删掉了；None = 这次运行还没管过）。
    lan_published: Option<Option<crate::lan_share::Advert>>,
}

fn prepared() -> &'static Mutex<std::collections::HashMap<String, Prepared>> {
    static PREPARED: OnceLock<Mutex<std::collections::HashMap<String, Prepared>>> = OnceLock::new();
    PREPARED.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn prepared_key(config: &RemoteConfig, device_id: &str) -> String {
    format!("{}\0{}\0{}\0{device_id}", config.url, config.folder, config.user)
}

pub async fn run_once(db: &Db, config: &RemoteConfig, spool_root: &Path, video_root: &Path) -> AppResult<RunReport> {
    let dav = config.client()?;
    let identity = identity::ensure_sync_identity(db).await?;
    let device_id = identity.device_id.clone();
    let own_dir = format!("{DEVICES_DIR}{device_id}/");
    let batches_dir = format!("{own_dir}batches/");
    let key = prepared_key(config, &device_id);
    let (clock_due, dirs_ready) = {
        let mut map = prepared().lock().unwrap();
        let entry = map.entry(key.clone()).or_default();
        (entry.clock_checked.is_none_or(|at| at.elapsed() >= CLOCK_CHECK_EVERY), entry.dirs_ready)
    };
    if clock_due {
        check_clock(&dav).await?;
        prepared().lock().unwrap().entry(key.clone()).or_default().clock_checked = Some(std::time::Instant::now());
    }
    if !dirs_ready {
        dav.ensure_root().await?;
        dav.ensure_dir(&batches_dir).await?;
        prepared().lock().unwrap().entry(key.clone()).or_default().dirs_ready = true;
    }

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

    let own_cache = compact::Cache { root: &spool_root.join("own") };
    let mut report = RunReport::default();
    report.pushed = push(db, &dav, &batches_dir, &own_cache).await?;

    let incoming = spool_root.join("incoming");
    std::fs::create_dir_all(&incoming)?;
    report.pulled = pull(db, &dav, &device_id, &incoming).await?;
    let applied = apply::apply_incoming(db, &incoming, Some(video_root)).await?;
    report.applied = applied.applied;
    report.parked = applied.parked;
    report.pending = outbox::pending_count(db).await?;
    compact_own(db, &dav, &own_dir, &own_cache).await;

    // 设备信息（名字、最近同步时间）只在推了新改动、或这次运行还没写过时更新。
    let written = prepared().lock().unwrap().entry(key.clone()).or_default().device_info_written;
    if report.pushed > 0 || !written {
        let info = DeviceInfo {
            device_id: device_id.clone(),
            name: device_label(),
            platform: platform_code().into(),
            last_sync_at: chrono::Utc::now().timestamp_millis(),
        };
        dav.put(&format!("{own_dir}device.json"), serde_json::to_vec(&info)?).await?;
        prepared().lock().unwrap().entry(key.clone()).or_default().device_info_written = true;
    }
    // 测试里不碰：局域网共享是进程里全局的，并行的测试打开它会改变这里的请求数。
    if crate::lan_share::supported() && !cfg!(test) {
        publish_lan(&dav, &own_dir, &key, crate::lan_share::advert()).await;
    }
    Ok(report)
}

/// 局域网直连播放的地址写到网盘上自己的文件夹里（变了才写；关掉了就删掉）。出错只记日志，下一轮再试。
async fn publish_lan(dav: &WebDav, own_dir: &str, key: &str, desired: Option<crate::lan_share::Advert>) {
    let published = prepared().lock().unwrap().entry(key.to_string()).or_default().lan_published.clone();
    if published.as_ref() == Some(&desired) {
        return;
    }
    let path = format!("{own_dir}{}", crate::lan_share::ADVERT_FILE);
    let result = match &desired {
        Some(advert) => match serde_json::to_vec(advert) {
            Ok(bytes) => dav.put(&path, bytes).await,
            Err(error) => Err(error.into()),
        },
        None => dav.delete(&path).await,
    };
    match result {
        Ok(()) => prepared().lock().unwrap().entry(key.to_string()).or_default().lan_published = Some(desired),
        Err(error) => tracing::warn!(%error, "局域网地址没能写到网盘上"),
    }
}

/// 下一个批次序号。重装应用后本地计数归零，而别的设备按文件名记游标——新批次的名字必须
/// 比网盘上已有的都大，否则会被当成读过的跳掉。所以取本地计数和网盘上已有最大序号 + 1 的较大者。
/// 批次压缩之后旧批次删了，所以网盘上的最大序号还要算上底稿覆盖到哪。
///
/// 顺便：别的设备把这台「移除」了（留了标记），而这台其实还在用——摘掉标记，重新出现在列表里。
async fn next_seq(db: &Db, dav: &WebDav, batches_dir: &str) -> AppResult<u64> {
    let local: u64 = get_setting(db, SETTING_NEXT_SEQ).await?.and_then(|value| value.parse().ok()).unwrap_or(1);
    let listing = Listing::parse(&dav.list(batches_dir).await?.unwrap_or_default());
    if listing.retired {
        dav.delete(&format!("{batches_dir}{}", compact::RETIRED_MARKER)).await?;
    }
    Ok(local.max(listing.max_seq() + 1))
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

async fn push(db: &Db, dav: &WebDav, batches_dir: &str, cache: &compact::Cache<'_>) -> AppResult<usize> {
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
            let bytes = serde_json::to_vec(chunk)?;
            if let Err(error) = dav.put(&format!("{batches_dir}{}", batch_name(seq)), bytes.clone()).await {
                // 这一块和后面还没传的都放回出件箱；前面已经传上去的已经确认过了。
                let message = error.to_string();
                for envelope in chunks[index..].iter().flatten() {
                    let _ = outbox::release_failed(db, &envelope.record_type, &envelope.record_id, &envelope.version, &message).await;
                }
                return Err(error);
            }
            // 留一份本地副本：以后压缩自己的批次时不用再从网盘下载。留不下也不要紧。
            let _ = cache.store_batch(&batch_name(seq), &bytes);
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
        let cursor: Option<(String, bool)> =
            sqlx::query_as("SELECT last_batch, retired<>0 FROM sync_remote_cursors WHERE device_id=?")
                .bind(&device.name)
                .fetch_optional(&db.pool)
                .await?;
        let listing = compact::list(dav, &device_dir).await?;
        if let Some((_, retired)) = &cursor {
            if *retired != listing.retired {
                sqlx::query("UPDATE sync_remote_cursors SET retired=? WHERE device_id=?")
                    .bind(listing.retired)
                    .bind(&device.name)
                    .execute(&db.pool)
                    .await?;
            }
        }
        let position = cursor.as_ref().and_then(|(name, _)| batch_seq(name)).unwrap_or(0);
        // 游标落在底稿覆盖范围里、中间的批次又已经删了（新设备、或者很久没同步）：先读底稿。
        let base = listing
            .latest_manifest()
            .filter(|(upto, _)| position < *upto && !listing.has_all_between(position, *upto))
            .map(|(upto, name)| (upto, name.to_string()));
        let pending: Vec<(u64, String)> = listing
            .batches
            .range(base.as_ref().map(|(upto, _)| *upto).unwrap_or(position) + 1..)
            .map(|(seq, name)| (*seq, name.clone()))
            .collect();
        if base.is_none() && pending.is_empty() {
            // 这台设备没有新东西：不读它的设备信息，省一个请求。
            continue;
        }
        let info: Option<DeviceInfo> = match dav.get_optional(&format!("{device_dir}device.json")).await {
            Ok(Some(bytes)) => serde_json::from_slice(&bytes).ok(),
            _ => None,
        };
        if let Some((upto, manifest)) = base {
            // 底稿的某一份不见了：那台设备正好在重新压缩。这一轮先跳过它，下一轮重新列目录。
            let Some((_, parts)) = compact::read_base(dav, &device_dir, &manifest).await? else { continue };
            for (part, envelopes) in parts.iter().enumerate() {
                for (index, envelope) in envelopes.iter().enumerate() {
                    write_incoming(incoming, &format!("remote-{}-base{upto:012}-{part}-{index}", device.name), envelope)?;
                }
                pulled += envelopes.len();
            }
            save_cursor(db, &device.name, &batch_name(upto), info.as_ref()).await?;
        }
        for (_, name) in pending {
            // 读的时候被压缩删掉了：下一轮重新列目录，会改读底稿。
            let Some(bytes) = dav.get_optional(&format!("{device_dir}batches/{name}")).await? else { break };
            // 读坏了（上传还没写完、文件损坏）：停在这里，游标不往前走，下一轮再读。
            let Ok(envelopes) = serde_json::from_slice::<Vec<SyncEnvelope>>(&bytes) else {
                tracing::warn!(device = %device.name, batch = %name, "同步批次读不出来，下一轮再试");
                break;
            };
            for (index, envelope) in envelopes.iter().enumerate() {
                write_incoming(incoming, &format!("remote-{}-{}-{index}", device.name, name.trim_end_matches(".json")), envelope)?;
            }
            pulled += envelopes.len();
            // 每读完一批就记游标：信封已经落进进件目录（持久的），断在哪都能续上。
            save_cursor(db, &device.name, &name, info.as_ref()).await?;
        }
    }
    Ok(pulled)
}

/// 自己的批次攒够了就压缩一次；上次没删完的旧文件接着删。出错只记日志——压缩不影响这一轮同步本身。
async fn compact_own(db: &Db, dav: &WebDav, own_dir: &str, cache: &compact::Cache<'_>) {
    let setting = |key| async move { get_setting(db, key).await.ok().flatten().and_then(|value| value.parse::<u64>().ok()) };
    let last_pushed = setting(SETTING_NEXT_SEQ).await.unwrap_or(1).saturating_sub(1);
    let base_upto = setting(SETTING_BASE_UPTO).await.unwrap_or(0);
    let tidy_pending = setting(SETTING_TIDY_PENDING).await.unwrap_or(0) > 0;
    if last_pushed.saturating_sub(base_upto) < compact::COMPACT_AFTER && !tidy_pending {
        return;
    }
    match compact::compact(dav, own_dir, Some(cache)).await {
        Ok(outcome) => {
            tracing::info!(?outcome, "压缩了网盘上的同步批次");
            let _ = set_setting(db, SETTING_BASE_UPTO, &outcome.base_upto.max(base_upto).to_string()).await;
            let _ = set_setting(db, SETTING_TIDY_PENDING, if outcome.remaining > 0 { "1" } else { "0" }).await;
        }
        Err(error) => tracing::warn!(%error, "压缩网盘上的同步批次失败，下一轮再试"),
    }
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

/// 「移除」网盘上的另一台设备：把它的批次全部折进底稿（它写过的数据留着，新设备照样能拿到），
/// 删掉它的设备信息，留一个标记让所有设备都不再列出它。那台设备要是其实还在用，
/// 下次推送时会自己摘掉标记、重新出现。
pub async fn retire_device(db: &Db, config: &RemoteConfig, device_id: &str) -> AppResult<()> {
    let own = identity::ensure_sync_identity(db).await?.device_id;
    if device_id == own {
        return Err(AppError::Config("不能移除这台设备自己".into()));
    }
    if device_id.is_empty() || !device_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(AppError::Config("设备 id 不对".into()));
    }
    let dav = config.client()?;
    let device_dir = format!("{DEVICES_DIR}{device_id}/");
    // 旧文件一次最多删一百个，删不完接着删（移除是用户点的，不必等下一轮）。
    for _ in 0..20 {
        if compact::compact(&dav, &device_dir, None).await?.remaining == 0 {
            break;
        }
    }
    let marker = serde_json::json!({ "retiredAt": chrono::Utc::now().timestamp_millis(), "by": own });
    dav.put(&format!("{device_dir}batches/{}", compact::RETIRED_MARKER), serde_json::to_vec(&marker)?).await?;
    dav.delete(&format!("{device_dir}device.json")).await?;
    sqlx::query("UPDATE sync_remote_cursors SET retired=1 WHERE device_id=?")
        .bind(device_id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

pub async fn known_devices(db: &Db) -> AppResult<Vec<RemoteDevice>> {
    let rows: Vec<(String, Option<String>, Option<String>, i64)> = sqlx::query_as(
        "SELECT device_id, device_name, platform, seen_at FROM sync_remote_cursors WHERE retired=0 ORDER BY seen_at DESC",
    )
    .fetch_all(&db.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(device_id, name, platform, seen_at)| RemoteDevice { device_id, name, platform, seen_at })
        .collect())
}

// ---------------------------------------------------------------------------
// 视频文件

/// 本机有文件、还没上传的视频逐个传到网盘。返回这一轮传完了几个。
/// `progress(视频 id, 标题, 已传, 总共)`；`keep_going()` 为 false 时在块与块之间停下。
pub async fn upload_pass(
    db: &Db,
    config: &RemoteConfig,
    progress: &(dyn Fn(&str, &str, u64, u64) + Send + Sync),
    keep_going: &(dyn Fn() -> bool + Send + Sync),
) -> AppResult<usize> {
    let dav = config.client()?;
    let videos: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, title, file_path FROM videos WHERE deleted_at IS NULL AND file_path <> '' ORDER BY created_at",
    )
    .fetch_all(&db.pool)
    .await?;
    // 网盘上已经有哪些视频的文件夹：没有文件夹的肯定没传过，有的再看清单。少发请求（坚果云限频）。
    let present: std::collections::HashSet<String> = dav
        .list(crate::sync::media::MEDIA_DIR)
        .await?
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| entry.is_dir)
        .map(|entry| entry.name)
        .collect();
    let mut uploaded = 0;
    for (video_id, title, file_path) in videos {
        if !keep_going() {
            break;
        }
        if !Path::new(&file_path).is_file() {
            continue;
        }
        let fingerprint = crate::sync::media::ensure_fingerprint(db, &video_id, &file_path).await?;
        if present.contains(&fingerprint) && UPLOADED.lock().unwrap().contains(&fingerprint) {
            continue;
        }
        let report = |sent: u64, total: u64| progress(&video_id, &title, sent, total);
        let done = crate::sync::media::upload(&dav, &fingerprint, Path::new(&file_path), &report, keep_going).await?;
        UPLOADED.lock().unwrap().insert(fingerprint);
        if done {
            uploaded += 1;
        }
    }
    if keep_going() {
        if let Err(error) = collect_media_garbage(db, &dav, &present).await {
            tracing::warn!(%error, "清理网盘上没人用的视频文件失败，下次再试");
        }
    }
    Ok(uploaded)
}

const SETTING_MEDIA_ORPHANS: &str = "remote_sync_media_orphans";
/// 网盘上的视频文件连续多久没有任何视频条目引用才删（另一台设备刚上传、条目还没同步过来时别误删）。
const MEDIA_ORPHAN_GRACE_MS: i64 = 7 * 24 * 3600 * 1000;

/// 删掉网盘上没有任何视频条目（含回收站里的）再引用的视频文件。只在这台设备最近一小时内
/// 同步成功过时做：本地库要是好几天没同步，就不知道别的设备新加了哪些视频。
async fn collect_media_garbage(db: &Db, dav: &WebDav, present: &std::collections::HashSet<String>) -> AppResult<usize> {
    let now = chrono::Utc::now().timestamp_millis();
    let last_success: i64 = get_setting(db, SETTING_LAST_SUCCESS).await?.and_then(|value| value.parse().ok()).unwrap_or(0);
    if now - last_success > 3600 * 1000 {
        return Ok(0);
    }
    let referenced: std::collections::HashSet<String> =
        sqlx::query_scalar("SELECT content_fingerprint FROM videos WHERE content_fingerprint IS NOT NULL AND content_fingerprint<>''")
            .fetch_all(&db.pool)
            .await?
            .into_iter()
            .collect();
    let mut orphans: std::collections::BTreeMap<String, i64> = get_setting(db, SETTING_MEDIA_ORPHANS)
        .await?
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default();
    let unreferenced = |name: &String| {
        name.len() == 64 && name.bytes().all(|byte| byte.is_ascii_hexdigit()) && !referenced.contains(name)
    };
    orphans.retain(|name, _| present.contains(name) && unreferenced(name));
    let mut removed = 0;
    for name in present.iter().filter(|name| unreferenced(name)) {
        let since = *orphans.entry(name.clone()).or_insert(now);
        if now - since >= MEDIA_ORPHAN_GRACE_MS {
            dav.delete(&format!("{}{name}/", crate::sync::media::MEDIA_DIR)).await?;
            orphans.remove(name);
            UPLOADED.lock().unwrap().remove(name);
            removed += 1;
        }
    }
    set_setting(db, SETTING_MEDIA_ORPHANS, &serde_json::to_string(&orphans)?).await?;
    Ok(removed)
}

/// 已经确认在网盘上的视频（本次运行内的缓存，省得每一轮都去问一遍清单）。
static UPLOADED: Mutex<std::collections::BTreeSet<String>> = Mutex::new(std::collections::BTreeSet::new());

/// 网盘上有没有这个视频的文件（有的话多大）。
pub async fn remote_media_size(db: &Db, config: &RemoteConfig, video_id: &str) -> AppResult<Option<u64>> {
    let fingerprint: Option<String> = sqlx::query_scalar("SELECT content_fingerprint FROM videos WHERE id=?")
        .bind(video_id)
        .fetch_optional(&db.pool)
        .await?
        .flatten();
    let Some(fingerprint) = fingerprint.filter(|value| !value.is_empty()) else { return Ok(None) };
    let dav = config.client()?;
    Ok(crate::sync::media::remote_manifest(&dav, &fingerprint).await?.map(|manifest| manifest.size))
}

/// 把网盘上的视频下到本机，挂到这个视频条目上，返回文件路径。
pub async fn download_video(
    db: &Db,
    config: &RemoteConfig,
    video_root: &Path,
    video_id: &str,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> AppResult<PathBuf> {
    let (title, fingerprint): (String, Option<String>) =
        sqlx::query_as("SELECT title, content_fingerprint FROM videos WHERE id=? AND deleted_at IS NULL")
            .bind(video_id)
            .fetch_optional(&db.pool)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("video {video_id}")))?;
    let fingerprint = fingerprint
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Other("有这个视频文件的设备还没把它传到网盘（在那台设备上打开「上传视频文件」）".into()))?;
    let dav = config.client()?;
    let target_dir = video_root.join(video_id);
    let path = crate::sync::media::download(
        &dav,
        &fingerprint,
        &target_dir,
        &crate::sync::media::safe_file_stem(&title),
        progress,
    )
    .await?;
    // file_path 是本机的事，不在同步的字段里，改它不会外发。
    sqlx::query("UPDATE videos SET file_path=? WHERE id=?")
        .bind(path.to_string_lossy().as_ref())
        .bind(video_id)
        .execute(&db.pool)
        .await?;
    Ok(path)
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

/// 视频上传的进度（设置页显示）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    pub uploading: Option<MediaProgress>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProgress {
    pub video_id: String,
    pub title: String,
    pub sent: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub video_id: String,
    pub received: u64,
    pub total: u64,
    pub done: bool,
    pub error: Option<String>,
}

struct Engine {
    app: tauri::AppHandle,
    db: Db,
    wake: tokio::sync::Notify,
    lock: tokio::sync::Mutex<()>,
    state: Mutex<RunState>,
    media_wake: tokio::sync::Notify,
    media_state: Mutex<MediaState>,
    downloading: Mutex<std::collections::HashSet<String>>,
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
                media_wake: tokio::sync::Notify::new(),
                media_state: Mutex::new(MediaState::default()),
                downloading: Mutex::new(std::collections::HashSet::new()),
            })
        })
        .clone();
    let media = engine.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            media.upload_media_if_enabled().await;
            tokio::select! {
                _ = media.media_wake.notified() => {}
                _ = tokio::time::sleep(MEDIA_INTERVAL) => {}
            }
        }
    });
    tauri::async_runtime::spawn(async move {
        engine.restore_state().await;
        // 启动后稍等一下再同步，别和启动时的其它工作抢。
        tokio::time::sleep(Duration::from_secs(8)).await;
        let mut interval = MIN_INTERVAL;
        loop {
            let busy = match engine.run_if_enabled().await {
                Ok(Some(report)) => report.pushed > 0 || report.pulled > 0 || report.applied > 0,
                // 没开同步、或者出错：照常放慢，别在出错时反复打服务器。
                _ => false,
            };
            interval = next_interval(interval, busy);
            // 这一轮之后出件箱里还剩多少（推失败、或者没开同步）：只有比这多了才算本机有新改动，
            // 免得断网时每分半钟就去撞一次服务器。
            let baseline = outbox::pending_count(&engine.db).await.unwrap_or(0);
            tokio::select! {
                _ = engine.wake.notified() => interval = MIN_INTERVAL,
                _ = tokio::time::sleep(interval) => {}
                _ = engine.local_change(baseline) => interval = MIN_INTERVAL,
            }
        }
    });
}

/// 下一轮等多久：这一轮有东西进出就回到最短间隔，否则翻倍，封顶 30 分钟。
fn next_interval(current: Duration, busy: bool) -> Duration {
    if busy {
        MIN_INTERVAL
    } else {
        (current * 2).min(MAX_INTERVAL)
    }
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

/// 移除网盘上的另一台设备（设置页的「移除」）。和后台同步互斥，免得一边压缩一边读。
pub async fn retire_now(device_id: &str) -> AppResult<()> {
    let engine = ENGINE.get().cloned().ok_or_else(|| AppError::Other("同步还没准备好".into()))?;
    let _guard = engine.lock.lock().await;
    let config = saved_config(&engine.db)
        .await?
        .ok_or_else(|| AppError::Config("还没填网盘地址和账号".into()))?;
    retire_device(&engine.db, &config, device_id).await
}

pub fn media_state() -> MediaState {
    ENGINE.get().map(|engine| engine.media_state.lock().unwrap().clone()).unwrap_or_default()
}

/// 关掉视频上传时置 false：正在传的那个视频传完当前这一块就停。
static UPLOAD_ALLOWED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

pub fn stop_media_upload() {
    UPLOAD_ALLOWED.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// 设置改了（开 / 关视频上传）：上传任务马上看一眼。
pub fn nudge_media() {
    if let Some(engine) = ENGINE.get() {
        engine.media_wake.notify_one();
    }
}

/// 下载一个视频（设置页 / 播放器的「从网盘下载」）。进度走 DOWNLOAD_EVENT。
pub async fn download_now(video_id: &str) -> AppResult<PathBuf> {
    let engine = ENGINE.get().cloned().ok_or_else(|| AppError::Other("同步还没准备好".into()))?;
    if !engine.downloading.lock().unwrap().insert(video_id.to_string()) {
        return Err(AppError::Other("这个视频正在下载".into()));
    }
    let result = engine.download(video_id).await;
    engine.downloading.lock().unwrap().remove(video_id);
    let event = DownloadProgress {
        video_id: video_id.to_string(),
        received: 0,
        total: 0,
        done: true,
        error: result.as_ref().err().map(|error| error.to_string()),
    };
    engine.app.emit(DOWNLOAD_EVENT, event).ok();
    result
}

pub fn state() -> RunState {
    ENGINE.get().map(|engine| engine.state.lock().unwrap().clone()).unwrap_or_default()
}

impl Engine {
    async fn download(&self, video_id: &str) -> AppResult<PathBuf> {
        let config = saved_config(&self.db)
            .await?
            .ok_or_else(|| AppError::Config("还没填网盘地址和账号".into()))?;
        let app_data = self.app.path().app_data_dir().map_err(|error| AppError::Config(error.to_string()))?;
        let app = self.app.clone();
        let id = video_id.to_string();
        let report = move |received: u64, total: u64| {
            app.emit(DOWNLOAD_EVENT, DownloadProgress { video_id: id.clone(), received, total, done: false, error: None }).ok();
        };
        download_video(&self.db, &config, &app_data.join("synced-videos"), video_id, &report).await
    }

    async fn upload_media_if_enabled(&self) {
        let enabled = is_enabled(&self.db).await.unwrap_or(false)
            && get_setting(&self.db, SETTING_UPLOAD_MEDIA).await.ok().flatten().as_deref() == Some("true");
        if !enabled {
            return;
        }
        let Ok(Some(config)) = saved_config(&self.db).await else { return };
        let db = self.db.clone();
        UPLOAD_ALLOWED.store(true, std::sync::atomic::Ordering::SeqCst);
        let keep_going = || UPLOAD_ALLOWED.load(std::sync::atomic::Ordering::SeqCst);
        let report = |video_id: &str, title: &str, sent: u64, total: u64| {
            self.media_state.lock().unwrap().uploading =
                Some(MediaProgress { video_id: video_id.into(), title: title.into(), sent, total });
            self.app.emit(MEDIA_EVENT, self.media_state.lock().unwrap().clone()).ok();
        };
        let result = upload_pass(&db, &config, &report, &keep_going).await;
        {
            let mut state = self.media_state.lock().unwrap();
            state.uploading = None;
            state.last_error = result.as_ref().err().map(|error| error.to_string());
        }
        self.app.emit(MEDIA_EVENT, self.media_state.lock().unwrap().clone()).ok();
    }

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

    async fn run_if_enabled(&self) -> AppResult<Option<RunReport>> {
        if !is_enabled(&self.db).await? {
            return Ok(None);
        }
        self.run().await.map(Some)
    }

    /// 等到本机有新的待上传改动（只查本地出件箱，不发网络请求），再等半分钟把连着的几下改动攒一起。
    async fn local_change(&self, baseline: i64) {
        loop {
            tokio::time::sleep(LOCAL_CHECK).await;
            let enabled = is_enabled(&self.db).await.unwrap_or(false);
            if enabled && outbox::pending_count(&self.db).await.unwrap_or(0) > baseline {
                tokio::time::sleep(LOCAL_DEBOUNCE).await;
                return;
            }
        }
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
                // 推了改动（可能有新导入的视频）才叫上传任务看一眼网盘；空闲的一轮不去列视频文件夹。
                if report.pushed > 0 {
                    self.media_wake.notify_one();
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
        /// 收到的请求（方法 + 路径），用来数一轮同步发了几个请求。
        pub requests: Vec<String>,
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
                    let destination = head
                        .lines()
                        .find_map(|line| line.to_ascii_lowercase().starts_with("destination:").then(|| line[12..].trim().to_string()))
                        .and_then(|url| reqwest::Url::parse(&url).ok())
                        .map(|url| url.path().to_string());
                    let (status, response_body) = {
                        let mut store = store.lock().unwrap();
                        store.requests.push(format!("{method} {path}"));
                        if method == "MOVE" {
                            match (store.files.remove(&path), destination) {
                                (Some(bytes), Some(to)) => {
                                    store.files.insert(to, bytes);
                                    ("201 Created", Vec::new())
                                }
                                _ => ("404 Not Found", Vec::new()),
                            }
                        } else {
                            handle(&mut store, &method, &path, body)
                        }
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
            "DELETE" => {
                let dir = if path.ends_with('/') { path.to_string() } else { format!("{path}/") };
                if store.files.remove(path).is_some() {
                    ("204 No Content", Vec::new())
                } else if store.dirs.contains(&dir) {
                    store.dirs.retain(|d| !d.starts_with(&dir));
                    store.files.retain(|f, _| !f.starts_with(&dir));
                    ("204 No Content", Vec::new())
                } else {
                    ("404 Not Found", Vec::new())
                }
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
                for (file, bytes) in store.files.iter().filter(|(f, _)| parent(f) == dir) {
                    xml.push_str(&format!("<d:response><d:href>{file}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>{}</d:getcontentlength></d:prop></d:propstat></d:response>", bytes.len()));
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
        // 字幕到了，这条视频在手机上就是「已处理」，不会被再排去识别一遍。
        let status: String = sqlx::query_scalar("SELECT processed_status FROM videos WHERE id=?").bind(&video.id).fetch_one(&phone.db.pool).await.unwrap();
        assert_eq!(status, "done");

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

    #[tokio::test]
    async fn a_video_file_goes_up_from_the_pc_and_down_to_the_phone() {
        let (url, store) = test_server::start().await;
        let config = config(&url);
        let pc = Device::new("pc").await;
        let phone = Device::new("phone").await;
        let course = crate::commands::courses::create_course(&pc.db, "申论".into(), pc.dir.path().to_string_lossy().into()).await.unwrap();
        let file = pc.dir.path().join("01 概括.mp4");
        let content: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&file, &content).unwrap();
        let video = crate::commands::videos::add_local_video(&pc.db, &course.id, file, None).await.unwrap();
        pc.sync(&config).await.unwrap();
        phone.sync(&config).await.unwrap();

        // 手机上还没有指纹（电脑没传过）：说清楚要先在电脑上传。
        let error = download_video(&phone.db, &config, &phone.dir.path().join("synced-videos"), &video.id, &|_, _| {})
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("上传"), "{error}");

        let sent = std::sync::Mutex::new(Vec::new());
        let report = |_: &str, _: &str, done: u64, total: u64| sent.lock().unwrap().push((done, total));
        assert_eq!(upload_pass(&pc.db, &config, &report, &|| true).await.unwrap(), 1);
        assert_eq!(sent.lock().unwrap().last(), Some(&(300_000, 300_000)));
        assert!(store.lock().unwrap().files.keys().any(|path| path.ends_with("/manifest.json")));
        assert!(!store.lock().unwrap().files.keys().any(|path| path.ends_with(".uploading")), "临时名都改成了正式名");
        // 再来一轮：已经在网盘上了，不重传。
        assert_eq!(upload_pass(&pc.db, &config, &report, &|| true).await.unwrap(), 0);

        // 指纹随视频条目同步到手机，手机按它下载。
        pc.sync(&config).await.unwrap();
        phone.sync(&config).await.unwrap();
        assert_eq!(remote_media_size(&phone.db, &config, &video.id).await.unwrap(), Some(300_000));
        let path = download_video(&phone.db, &config, &phone.dir.path().join("synced-videos"), &video.id, &|_, _| {})
            .await
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), content);
        assert_eq!(path.extension().and_then(|ext| ext.to_str()), Some("mp4"));
        let file_path: String = sqlx::query_scalar("SELECT file_path FROM videos WHERE id=?").bind(&video.id).fetch_one(&phone.db.pool).await.unwrap();
        assert_eq!(file_path, path.to_string_lossy());
        // 挂上文件是本机的事，不往外发。
        assert_eq!(crate::sync::outbox::pending_count(&phone.db).await.unwrap(), 0);
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

    #[test]
    fn idle_rounds_back_off_to_thirty_minutes_and_activity_resets_it() {
        let mut interval = MIN_INTERVAL;
        let mut seen = Vec::new();
        for _ in 0..6 {
            interval = next_interval(interval, false);
            seen.push(interval.as_secs() / 60);
        }
        assert_eq!(seen, [6, 12, 24, 30, 30, 30]);
        assert_eq!(next_interval(MAX_INTERVAL, true), MIN_INTERVAL);
    }

    #[tokio::test]
    async fn an_idle_round_only_lists_the_drive() {
        let (url, store) = test_server::start().await;
        let config = config(&url);
        let pc = Device::new("pc").await;
        let phone = Device::new("phone").await;
        crate::commands::courses::create_course(&pc.db, "a".into(), "/tmp".into()).await.unwrap();
        pc.sync(&config).await.unwrap();
        phone.sync(&config).await.unwrap();
        pc.sync(&config).await.unwrap();

        store.lock().unwrap().requests.clear();
        let report = pc.sync(&config).await.unwrap();
        assert_eq!((report.pushed, report.pulled), (0, 0));
        let requests = store.lock().unwrap().requests.clone();
        assert!(requests.iter().all(|request| request.starts_with("PROPFIND")), "{requests:?}");
        assert_eq!(requests.len(), 2, "列设备 + 列另一台设备的批次：{requests:?}");
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

    fn remote_files(store: &Arc<Mutex<test_server::Store>>, device: &str) -> Vec<String> {
        store
            .lock()
            .unwrap()
            .files
            .keys()
            .filter_map(|path| path.split_once(&format!("/devices/{device}/")).map(|(_, rest)| rest.to_string()))
            .collect()
    }

    async fn course_names(db: &Db) -> Vec<String> {
        sqlx::query_scalar("SELECT name FROM courses WHERE deleted_at IS NULL ORDER BY name").fetch_all(&db.pool).await.unwrap()
    }

    async fn device_id(db: &Db) -> String {
        identity::ensure_sync_identity(db).await.unwrap().device_id
    }

    /// 测试里攒 3 批就压缩（正式是 100 批）。
    async fn push_rounds(device: &Device, config: &RemoteConfig, names: &[&str]) {
        for name in names {
            crate::commands::courses::create_course(&device.db, (*name).into(), "/tmp".into()).await.unwrap();
            device.sync(config).await.unwrap();
        }
    }

    #[tokio::test]
    async fn old_batches_are_folded_into_a_base_and_new_devices_still_get_everything() {
        let (url, store) = test_server::start().await;
        let config = config(&url);
        let pc = Device::new("pc").await;
        let phone = Device::new("phone").await;
        let pc_id = device_id(&pc.db).await;

        // 手机读过第一批，之后一直没同步。
        push_rounds(&pc, &config, &["a"]).await;
        phone.sync(&config).await.unwrap();
        push_rounds(&pc, &config, &["b", "c"]).await;
        // 又改了一次 a（和应用里改名一样，更新时间跟着变）：底稿里 a 只留最新的一份。
        tokio::time::sleep(Duration::from_millis(5)).await;
        sqlx::query("UPDATE courses SET name='a2', updated_at=? WHERE name='a'")
            .bind(chrono::Utc::now().timestamp_millis())
            .execute(&pc.db.pool)
            .await
            .unwrap();
        pc.sync(&config).await.unwrap();

        let files = remote_files(&store, &pc_id);
        assert!(files.iter().any(|f| f.starts_with("batches/base-")), "压缩出了底稿：{files:?}");
        let remaining: Vec<u64> = files.iter().filter_map(|f| compact::batch_seq(f.strip_prefix("batches/")?)).collect();
        assert_eq!(remaining, [4], "折进底稿（1~3）的批次删了，之后的那批留着：{files:?}");
        let cached: Vec<String> = std::fs::read_dir(pc.dir.path().join("sync/own/batches"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(cached, ["000000000004.json"], "本地的批次副本也只留底稿之后的");

        // 新设备：从底稿拿到全部。
        let tablet = Device::new("tablet").await;
        tablet.sync(&config).await.unwrap();
        assert_eq!(course_names(&tablet.db).await, ["a2", "b", "c"]);
        // 落后的手机：中间的批次没了，改读底稿。
        phone.sync(&config).await.unwrap();
        assert_eq!(course_names(&phone.db).await, ["a2", "b", "c"]);

        // 压缩之后接着推的批次，序号接在底稿后面；别的设备照常读。
        push_rounds(&pc, &config, &["d"]).await;
        set_setting(&pc.db, SETTING_NEXT_SEQ, "1").await.unwrap(); // 模拟重装：本地序号丢了
        push_rounds(&pc, &config, &["e"]).await;
        phone.sync(&config).await.unwrap();
        tablet.sync(&config).await.unwrap();
        assert_eq!(course_names(&phone.db).await, ["a2", "b", "c", "d", "e"]);
        assert_eq!(course_names(&tablet.db).await, ["a2", "b", "c", "d", "e"]);
    }

    #[tokio::test]
    async fn compacting_again_only_uploads_the_parts_that_changed() {
        let (url, store) = test_server::start().await;
        let config = config(&url);
        let pc = Device::new("pc").await;
        let pc_id = device_id(&pc.db).await;
        push_rounds(&pc, &config, &["a", "b", "c"]).await;
        let first: Vec<String> = remote_files(&store, &pc_id).into_iter().filter(|f| f.starts_with("base/")).collect();
        assert!(!first.is_empty());

        store.lock().unwrap().requests.clear();
        push_rounds(&pc, &config, &["d", "e", "f"]).await;
        let puts: Vec<String> = store
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter_map(|request| request.strip_prefix("PUT ")?.rsplit_once("/base/").map(|(_, name)| format!("base/{name}")))
            .collect();
        assert!(!puts.is_empty(), "第二次压缩传了新的份");
        assert!(puts.iter().all(|part| !first.contains(part)), "网盘上已有的份不重传：{puts:?} vs {first:?}");
        // 网盘上留下的份正好是最新清单里列的那些（不再引用的旧份删了）。
        let files = remote_files(&store, &pc_id);
        let manifest_path = files.iter().filter(|f| f.starts_with("batches/base-")).max().unwrap().clone();
        let manifest: compact::Manifest = serde_json::from_slice(
            &store.lock().unwrap().files.iter().find(|(path, _)| path.ends_with(&manifest_path)).unwrap().1.clone(),
        )
        .unwrap();
        let mut on_drive: Vec<String> = files.iter().filter_map(|f| f.strip_prefix("base/").map(str::to_string)).collect();
        let mut listed = manifest.parts.clone();
        on_drive.sort();
        listed.sort();
        assert_eq!(on_drive, listed);
        let tablet = Device::new("tablet").await;
        tablet.sync(&config).await.unwrap();
        assert_eq!(course_names(&tablet.db).await, ["a", "b", "c", "d", "e", "f"]);
    }

    #[tokio::test]
    async fn a_retired_device_disappears_but_its_data_stays_and_it_can_come_back() {
        let (url, store) = test_server::start().await;
        let config = config(&url);
        let pc = Device::new("pc").await;
        let old_phone = Device::new("phone").await;
        let phone_id = device_id(&old_phone.db).await;
        push_rounds(&old_phone, &config, &["只在旧手机上建的课"]).await;
        pc.sync(&config).await.unwrap();
        assert_eq!(known_devices(&pc.db).await.unwrap().len(), 1);

        retire_device(&pc.db, &config, &phone_id).await.unwrap();
        assert!(known_devices(&pc.db).await.unwrap().is_empty());
        let files = remote_files(&store, &phone_id);
        assert!(!files.contains(&"device.json".to_string()), "{files:?}");
        assert!(files.iter().any(|f| f.starts_with("batches/base-")), "批次折进了底稿：{files:?}");
        assert!(retire_device(&pc.db, &config, &device_id(&pc.db).await).await.is_err(), "不能移除自己");

        // 新设备照样拿到旧手机写过的数据，而且不把它列出来。
        let tablet = Device::new("tablet").await;
        tablet.sync(&config).await.unwrap();
        tablet.sync(&config).await.unwrap();
        assert_eq!(course_names(&tablet.db).await, ["只在旧手机上建的课"]);
        let listed: Vec<String> = known_devices(&tablet.db).await.unwrap().into_iter().map(|d| d.device_id).collect();
        assert!(!listed.contains(&phone_id), "{listed:?}");

        // 旧手机其实还在用：下次推送时摘掉标记，重新出现。
        push_rounds(&old_phone, &config, &["又一门"]).await;
        assert!(!remote_files(&store, &phone_id).iter().any(|f| f.ends_with(compact::RETIRED_MARKER)));
        pc.sync(&config).await.unwrap();
        let listed: Vec<String> = known_devices(&pc.db).await.unwrap().into_iter().map(|d| d.device_id).collect();
        assert_eq!(listed, [phone_id]);
        assert_eq!(course_names(&pc.db).await, ["又一门", "只在旧手机上建的课"]);
    }

    #[tokio::test]
    async fn video_files_nobody_references_are_removed_after_a_week() {
        let (url, store) = test_server::start().await;
        let config = config(&url);
        let pc = Device::new("pc").await;
        pc.sync(&config).await.unwrap();
        let dav = config.client().unwrap();
        let orphan = "a".repeat(64);
        let used = "b".repeat(64);
        for name in [&orphan, &used] {
            dav.ensure_dir(&format!("{}{name}/", crate::sync::media::MEDIA_DIR)).await.unwrap();
            dav.put(&format!("{}{name}/manifest.json", crate::sync::media::MEDIA_DIR), b"{}".to_vec()).await.unwrap();
        }
        let course = crate::commands::courses::create_course(&pc.db, "c".into(), "/tmp".into()).await.unwrap();
        let file = pc.dir.path().join("v.mp4");
        std::fs::write(&file, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&pc.db, &course.id, file, None).await.unwrap();
        sqlx::query("UPDATE videos SET content_fingerprint=? WHERE id=?").bind(&used).bind(&video.id).execute(&pc.db.pool).await.unwrap();
        set_setting(&pc.db, SETTING_LAST_SUCCESS, &chrono::Utc::now().timestamp_millis().to_string()).await.unwrap();
        let present: std::collections::HashSet<String> = [orphan.clone(), used.clone()].into();
        let exists = |name: &str| store.lock().unwrap().files.keys().any(|path| path.contains(name));

        // 第一次看到没人引用：只记下来，不删。
        assert_eq!(collect_media_garbage(&pc.db, &dav, &present).await.unwrap(), 0);
        assert!(exists(&orphan));
        // 过了一周还是没人引用：删掉。有人引用的不动。
        let week_ago = chrono::Utc::now().timestamp_millis() - MEDIA_ORPHAN_GRACE_MS - 1;
        set_setting(&pc.db, SETTING_MEDIA_ORPHANS, &serde_json::json!({ orphan.clone(): week_ago }).to_string()).await.unwrap();
        assert_eq!(collect_media_garbage(&pc.db, &dav, &present).await.unwrap(), 1);
        assert!(!exists(&orphan));
        assert!(exists(&used));

        // 本机很久没同步成功：不知道别的设备新加了什么，不删。
        set_setting(&pc.db, SETTING_LAST_SUCCESS, "0").await.unwrap();
        sqlx::query("UPDATE videos SET content_fingerprint=NULL").execute(&pc.db.pool).await.unwrap();
        set_setting(&pc.db, SETTING_MEDIA_ORPHANS, &serde_json::json!({ used.clone(): week_ago }).to_string()).await.unwrap();
        assert_eq!(collect_media_garbage(&pc.db, &dav, &present).await.unwrap(), 0);
        assert!(exists(&used));
    }

    #[tokio::test]
    async fn the_lan_address_is_published_only_when_it_changes_and_removed_when_sharing_stops() {
        let (url, store) = test_server::start().await;
        let config = config(&url);
        let pc = Device::new("pc").await;
        pc.sync(&config).await.unwrap();
        let pc_id = device_id(&pc.db).await;
        let dav = config.client().unwrap();
        let own_dir = format!("{DEVICES_DIR}{pc_id}/");
        let key = prepared_key(&config, &pc_id);
        let advert = crate::lan_share::Advert {
            addresses: vec!["192.168.1.5".into()],
            port: 47321,
            token: "t".repeat(64),
            cert_sha256: "c".repeat(64),
        };
        let lan_puts = || store.lock().unwrap().requests.iter().filter(|r| r.ends_with("/lan.json")).count();

        publish_lan(&dav, &own_dir, &key, Some(advert.clone())).await;
        assert!(remote_files(&store, &pc_id).contains(&"lan.json".to_string()));
        publish_lan(&dav, &own_dir, &key, Some(advert.clone())).await;
        assert_eq!(lan_puts(), 1, "没变就不再写");
        let moved = crate::lan_share::Advert { addresses: vec!["192.168.1.9".into()], ..advert };
        publish_lan(&dav, &own_dir, &key, Some(moved)).await;
        assert_eq!(lan_puts(), 2, "地址变了重写");
        publish_lan(&dav, &own_dir, &key, None).await;
        assert!(!remote_files(&store, &pc_id).contains(&"lan.json".to_string()), "关掉共享后删掉");
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
