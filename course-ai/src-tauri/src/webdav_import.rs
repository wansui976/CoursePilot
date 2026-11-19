//! 从网盘（WebDAV）导入课程：浏览网盘里的文件夹，选中的视频导成一门课。
//!
//! 为什么是 WebDAV：坚果云、Nextcloud、群晖本来就支持；百度网盘、阿里云盘、夸克、115、
//! 天翼、OneDrive 这些可以用 OpenList（AList 的开源后续）挂出一个 WebDAV。登录这些网盘、
//! 跟着它们改接口的活由 OpenList 干，这里只说一种协议。
//!
//! 两种导法：
//! - **下载到本机**：排进下载队列（和链接导入共用进度、取消、重试），下完就是普通的本地视频，
//!   识别字幕、截封面都照常；
//! - **在线看**：只建视频条目（没有本地文件），播放时由本机媒体服务（127.0.0.1）边拉边转给
//!   播放器。要识别字幕时再「下载到本机」。
//!
//! 视频条目上记的是文件的完整地址（不带账号密码）。换台设备，只要也配了能访问这个地址的
//! 网盘来源（按地址前缀认），同步过去的条目照样能在线看。
//!
//! 网盘来源存在设置里，密码进系统钥匙串。同步用的那个网盘账号自动算一个来源。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::commands::settings::{get_setting, set_setting};
use crate::commands::videos::Video;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::media_server::{RemoteAuth, RemoteSource};
use crate::pipeline::download::DownloadEvent;
use crate::sync::webdav::{encode_path, WebDav};

const SETTING_SOURCES: &str = "webdav_import_sources";
/// 同步用的网盘账号在来源列表里的 id。
pub const SYNC_SOURCE_ID: &str = "sync";
/// 网盘视频在库里记成 `url` 类型：视频表的 CHECK 只认 local / url / bilibili，旧版本收到
/// 同步过来的条目也认得。是不是网盘视频，看 source_uri 能不能对上某个网盘来源。
pub const SOURCE_TYPE: &str = "url";

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "mkv", "webm", "avi", "flv", "wmv", "ts", "mpg", "mpeg", "3gp", "mp3", "m4a", "aac", "wav",
    "flac", "ogg", "opus",
];

fn secret_name(id: &str) -> String {
    format!("webdav_import_password_{id}")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredSource {
    id: String,
    name: String,
    url: String,
    user: String,
}

/// 设置页 / 导入对话框里看到的一个来源。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub name: String,
    pub url: String,
    pub user: String,
    pub has_password: bool,
    /// 是不是同步用的那个网盘账号（不能在这里改、删）。
    pub is_sync: bool,
}

/// 网盘里的一项。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowseEntry {
    pub name: String,
    /// 相对来源根目录的路径（不编码，`/` 分隔；文件夹以 `/` 结尾）。
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub is_video: bool,
    /// 文件的完整地址（文件夹为空）：下载、在线看都用它。
    pub url: String,
}

/// 要「在线看」导入的一个文件。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamItem {
    pub url: String,
    pub title: String,
}

fn normalize_base(url: &str) -> AppResult<String> {
    let url = url.trim();
    let parsed = reqwest::Url::parse(url).map_err(|_| AppError::Config(format!("网盘地址不是合法的网址：{url}")))?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err(AppError::Config("网盘地址要以 https:// 或 http:// 开头".into()));
    }
    Ok(format!("{}/", url.trim_end_matches('/')))
}

async fn stored_sources(db: &Db) -> AppResult<Vec<StoredSource>> {
    Ok(get_setting(db, SETTING_SOURCES)
        .await?
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default())
}

async fn write_sources(db: &Db, sources: &[StoredSource]) -> AppResult<()> {
    set_setting(db, SETTING_SOURCES, &serde_json::to_string(sources)?).await
}

/// 全部来源：同步用的网盘账号（配了的话）在最前面。
pub async fn list_sources(db: &Db) -> AppResult<Vec<Source>> {
    let mut sources = Vec::new();
    if let Some(config) = crate::sync::remote::saved_config(db).await? {
        sources.push(Source {
            id: SYNC_SOURCE_ID.into(),
            name: String::new(),
            url: normalize_base(&config.url).unwrap_or(config.url),
            user: config.user,
            has_password: !config.password.is_empty(),
            is_sync: true,
        });
    }
    for stored in stored_sources(db).await? {
        let has_password = crate::llm::keychain::get_secret(db, &secret_name(&stored.id))
            .await?
            .is_some_and(|password| !password.is_empty());
        sources.push(Source {
            id: stored.id,
            name: stored.name,
            url: stored.url,
            user: stored.user,
            has_password,
            is_sync: false,
        });
    }
    Ok(sources)
}

/// 新建或修改一个来源。`password` 为 None / 空时不改已存的密码。
pub async fn save_source(
    db: &Db,
    id: Option<String>,
    name: String,
    url: String,
    user: String,
    password: Option<String>,
) -> AppResult<Source> {
    if id.as_deref() == Some(SYNC_SOURCE_ID) {
        return Err(AppError::Config("同步用的网盘账号在「多设备同步」里改".into()));
    }
    let url = normalize_base(&url)?;
    let mut sources = stored_sources(db).await?;
    let id = id.filter(|id| sources.iter().any(|source| &source.id == id)).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let stored = StoredSource { id: id.clone(), name: name.trim().to_string(), url, user: user.trim().to_string() };
    match sources.iter_mut().find(|source| source.id == id) {
        Some(existing) => *existing = stored,
        None => sources.push(stored),
    }
    write_sources(db, &sources).await?;
    if let Some(password) = password.filter(|password| !password.is_empty()) {
        crate::llm::keychain::set_secret(db, &secret_name(&id), &password).await?;
    }
    list_sources(db)
        .await?
        .into_iter()
        .find(|source| source.id == id)
        .ok_or_else(|| AppError::Other("来源没存上".into()))
}

pub async fn delete_source(db: &Db, id: &str) -> AppResult<()> {
    let mut sources = stored_sources(db).await?;
    sources.retain(|source| source.id != id);
    write_sources(db, &sources).await?;
    let _ = crate::llm::keychain::delete_named_secret(db, &secret_name(id)).await;
    Ok(())
}

/// 一个来源的（根地址, 账号, 密码）。
async fn credentials(db: &Db, id: &str) -> AppResult<(String, String, String)> {
    if id == SYNC_SOURCE_ID {
        let config = crate::sync::remote::saved_config(db)
            .await?
            .ok_or_else(|| AppError::Config("还没设置同步用的网盘".into()))?;
        return Ok((normalize_base(&config.url)?, config.user, config.password));
    }
    let stored = stored_sources(db)
        .await?
        .into_iter()
        .find(|source| source.id == id)
        .ok_or_else(|| AppError::NotFound(format!("网盘来源 {id}")))?;
    let password = crate::llm::keychain::get_secret(db, &secret_name(id)).await?.unwrap_or_default();
    Ok((stored.url, stored.user, password))
}

/// 测一个（还没保存的）来源能不能连上：能列出根目录就算通。
pub async fn test(url: &str, user: &str, password: &str) -> AppResult<usize> {
    let dav = WebDav::new(&normalize_base(url)?, "", user, password)?;
    let entries = dav
        .list("")
        .await?
        .ok_or_else(|| AppError::Config("连上了，但这个地址不是一个文件夹".into()))?;
    Ok(entries.len())
}

/// 测已保存的来源（编辑时密码留空 = 用存着的那个）。
pub async fn test_saved(db: &Db, id: &str, url: Option<String>, user: Option<String>, password: Option<String>) -> AppResult<usize> {
    let (saved_url, saved_user, saved_password) = credentials(db, id).await?;
    test(
        &url.unwrap_or(saved_url),
        &user.unwrap_or(saved_user),
        &password.filter(|password| !password.is_empty()).unwrap_or(saved_password),
    )
    .await
}

fn is_video_name(name: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, extension)| VIDEO_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
}

/// 按「人看的顺序」比较文件名：数字按数值比（第 2 讲排在第 10 讲前面）。
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut left = String::new();
                while let Some(c) = a.peek().copied().filter(char::is_ascii_digit) {
                    left.push(c);
                    a.next();
                }
                let mut right = String::new();
                while let Some(c) = b.peek().copied().filter(char::is_ascii_digit) {
                    right.push(c);
                    b.next();
                }
                let (left_trim, right_trim) = (left.trim_start_matches('0'), right.trim_start_matches('0'));
                let order = left_trim.len().cmp(&right_trim.len()).then_with(|| left_trim.cmp(right_trim));
                if order != std::cmp::Ordering::Equal {
                    return order;
                }
            }
            (Some(x), Some(y)) => {
                let order = x.to_lowercase().cmp(y.to_lowercase());
                if order != std::cmp::Ordering::Equal {
                    return order;
                }
                a.next();
                b.next();
            }
        }
    }
}

/// 列一个文件夹：文件夹在前，其余按文件名的自然顺序。
pub async fn browse(db: &Db, source_id: &str, path: &str) -> AppResult<Vec<BrowseEntry>> {
    let (base, user, password) = credentials(db, source_id).await?;
    let dav = WebDav::new(&base, "", &user, &password)?;
    let dir = path.trim_matches('/');
    let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
    let entries = dav
        .list(&encode_path(&prefix))
        .await?
        .ok_or_else(|| AppError::NotFound(format!("网盘上没有这个文件夹：{path}")))?;
    let mut items: Vec<BrowseEntry> = entries
        .into_iter()
        .filter(|entry| !entry.name.starts_with('.'))
        .map(|entry| {
            let relative = format!("{prefix}{}{}", entry.name, if entry.is_dir { "/" } else { "" });
            BrowseEntry {
                is_video: !entry.is_dir && is_video_name(&entry.name),
                url: if entry.is_dir { String::new() } else { dav.url(&encode_path(&relative)) },
                name: entry.name,
                path: relative,
                is_dir: entry.is_dir,
                size: entry.size,
            }
        })
        .collect();
    items.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| natural_cmp(&a.name, &b.name)));
    Ok(items)
}

/// 哪个来源能访问这个地址（按根地址前缀认，最长的优先）。返回（账号, 密码）。
pub async fn source_for_url(db: &Db, url: &str) -> AppResult<Option<(String, String)>> {
    let mut best: Option<(usize, String, String)> = None;
    for source in list_sources(db).await? {
        if url.starts_with(&source.url) && best.as_ref().is_none_or(|(length, _, _)| source.url.len() > *length) {
            let (_, user, password) = credentials(db, &source.id).await?;
            best = Some((source.url.len(), user, password));
        }
    }
    Ok(best.map(|(_, user, password)| (user, password)))
}

fn file_name_of(url: &str) -> String {
    let last = url.trim_end_matches('/').rsplit('/').next().unwrap_or("video");
    let name = crate::sync::webdav::percent_decode(last);
    // 文件名里别带路径分隔符这类东西。
    let cleaned: String = name.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '\0') { '_' } else { c }).collect();
    if cleaned.trim().is_empty() {
        "video.mp4".into()
    } else {
        cleaned
    }
}

/// 课程目录里没被占用的文件名（同名就加「(2)」「(3)」）。
fn free_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, extension) = name.rsplit_once('.').map(|(s, e)| (s.to_string(), format!(".{e}"))).unwrap_or((name.to_string(), String::new()));
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){extension}")))
        .find(|path| !path.exists())
        .expect("总能找到空位")
}

/// 下载队列里的一集：从网盘下到 `staging`，下完挪进 `out_dir`。进度格式和链接导入一样。
/// `begin_import` 返回 false 表示任务已被取消。
pub async fn download(
    db: &Db,
    url: &str,
    out_dir: &Path,
    staging: &Path,
    on_event: &(dyn Fn(DownloadEvent) + Send + Sync),
    begin_import: &(dyn Fn() -> bool + Send + Sync),
) -> AppResult<PathBuf> {
    let (user, password) = source_for_url(db, url)
        .await?
        .ok_or_else(|| AppError::Config("找不到能访问这个地址的网盘来源（是不是删掉了？）".into()))?;
    std::fs::create_dir_all(staging)?;
    std::fs::create_dir_all(out_dir)?;
    let name = file_name_of(url);
    let partial = staging.join(format!("{name}.part"));
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| AppError::Other(error.to_string()))?;
    // 断了接着下：已经下了的部分用 Range 续上（服务器不支持 Range 就从头来）。
    let mut downloaded = std::fs::metadata(&partial).map(|meta| meta.len()).unwrap_or(0);
    let mut request = client.get(url).basic_auth(&user, Some(&password));
    if downloaded > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={downloaded}-"));
    }
    let mut response = request.send().await.map_err(|error| AppError::Other(format!("连不上网盘：{error}")))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(AppError::Config("网盘拒绝了：账号或密码不对，或者没有这个文件的权限".into()));
    }
    if !status.is_success() {
        return Err(AppError::Other(format!("从网盘下载失败：HTTP {status}")));
    }
    if status != reqwest::StatusCode::PARTIAL_CONTENT {
        downloaded = 0;
    }
    let total = response.content_length().map(|length| length + downloaded);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(downloaded > 0)
        .truncate(downloaded == 0)
        .open(&partial)?;
    let started = Instant::now();
    let started_at = downloaded;
    let mut last_report = Instant::now() - Duration::from_secs(1);
    use std::io::Write as _;
    while let Some(chunk) = response.chunk().await.map_err(|error| AppError::Other(format!("下载中断：{error}")))? {
        file.write_all(&chunk)?;
        downloaded += chunk.len() as u64;
        if last_report.elapsed() >= Duration::from_millis(400) {
            last_report = Instant::now();
            let seconds = started.elapsed().as_secs_f64().max(0.001);
            let speed = (downloaded - started_at) as f64 / seconds;
            let eta = total.filter(|_| speed > 0.0).map(|total| ((total.saturating_sub(downloaded)) as f64 / speed) as u64);
            on_event(DownloadEvent::Progress { downloaded, total, speed: Some(speed), eta });
        }
    }
    file.flush()?;
    drop(file);
    on_event(DownloadEvent::Progress { downloaded, total: Some(downloaded), speed: None, eta: Some(0) });
    if !begin_import() {
        let _ = std::fs::remove_dir_all(staging);
        return Err(AppError::Other("已取消".into()));
    }
    let destination = free_path(out_dir, &name);
    if std::fs::rename(&partial, &destination).is_err() {
        // 跨盘：复制再删。
        std::fs::copy(&partial, &destination)?;
        let _ = std::fs::remove_file(&partial);
    }
    let _ = std::fs::remove_dir_all(staging);
    Ok(destination)
}

/// 「在线看」导入：只建视频条目，不下文件。同一门课里已经有这个地址的跳过。返回新建了几条。
pub async fn import_streaming(db: &Db, video_root: &Path, course_id: &str, items: &[StreamItem]) -> AppResult<Vec<String>> {
    let mut tx = db.pool.begin_with("BEGIN IMMEDIATE").await?;
    let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM courses WHERE id=? AND deleted_at IS NULL)")
        .bind(course_id)
        .fetch_one(&mut *tx)
        .await?;
    if !active {
        return Err(AppError::NotFound(format!("course {course_id}")));
    }
    let mut order: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(order_index),0) FROM videos WHERE course_id=?")
        .bind(course_id)
        .fetch_one(&mut *tx)
        .await?;
    let now = chrono::Utc::now().timestamp_millis();
    let mut created = Vec::new();
    for item in items {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM videos WHERE course_id=? AND source_uri=? AND deleted_at IS NULL)",
        )
        .bind(course_id)
        .bind(&item.url)
        .fetch_one(&mut *tx)
        .await?;
        if exists {
            continue;
        }
        order += 1;
        let id = uuid::Uuid::new_v4().to_string();
        let data_dir = video_root.join(&id);
        std::fs::create_dir_all(&data_dir)?;
        let title = if item.title.trim().is_empty() { file_name_of(&item.url) } else { item.title.trim().to_string() };
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,source_uri,file_path,order_index,data_dir,created_at)
             VALUES (?,?,?,?,?,'',?,?,?)",
        )
        .bind(&id)
        .bind(course_id)
        .bind(&title)
        .bind(SOURCE_TYPE)
        .bind(&item.url)
        .bind(order)
        .bind(data_dir.to_string_lossy().as_ref())
        .bind(now)
        .execute(&mut *tx)
        .await?;
        created.push(id);
    }
    tx.commit().await?;
    Ok(created)
}

/// 在线看的视频：返回给本机媒体服务转发用的来源。不是网盘视频、本机已经有文件、
/// 或者没有能访问它的来源时返回 None。
pub async fn stream_source(db: &Db, video_id: &str) -> AppResult<Option<RemoteSource>> {
    let row: Option<(String, Option<String>, String)> =
        sqlx::query_as("SELECT source_type, source_uri, file_path FROM videos WHERE id=? AND deleted_at IS NULL")
            .bind(video_id)
            .fetch_optional(&db.pool)
            .await?;
    let Some((source_type, Some(url), file_path)) = row else { return Ok(None) };
    if source_type != SOURCE_TYPE || !file_path.is_empty() {
        return Ok(None);
    }
    let Some((user, password)) = source_for_url(db, &url).await? else { return Ok(None) };
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| AppError::Other(error.to_string()))?;
    Ok(Some(RemoteSource { url, auth: RemoteAuth::Basic { user, password }, client }))
}

/// 在线看的视频下载到本机：下完挂上文件，之后就和本地视频一样（能识别字幕、截封面）。
pub async fn download_streamed(
    db: &Db,
    video_id: &str,
    out_dir: &Path,
    on_event: &(dyn Fn(DownloadEvent) + Send + Sync),
) -> AppResult<Video> {
    let (url, data_dir): (Option<String>, String) =
        sqlx::query_as("SELECT source_uri, data_dir FROM videos WHERE id=? AND deleted_at IS NULL AND source_type=?")
            .bind(video_id)
            .bind(SOURCE_TYPE)
            .fetch_optional(&db.pool)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("video {video_id}")))?;
    let url = url.ok_or_else(|| AppError::NotFound("这个视频没有网盘地址".into()))?;
    let staging = Path::new(&data_dir).join(".download");
    let path = download(db, &url, out_dir, &staging, on_event, &|| true).await?;
    sqlx::query("UPDATE videos SET file_path=?, app_owned_file=1 WHERE id=?")
        .bind(path.to_string_lossy().as_ref())
        .bind(video_id)
        .execute(&db.pool)
        .await?;
    Ok(sqlx::query_as::<_, Video>("SELECT * FROM videos WHERE id=?").bind(video_id).fetch_one(&db.pool).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::remote::test_server;

    #[test]
    fn lessons_sort_the_way_people_number_them() {
        let mut names = vec!["第10讲.mp4", "第2讲.mp4", "附录.pdf", "第1讲.mp4", "第09讲.mp4"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, ["第1讲.mp4", "第2讲.mp4", "第09讲.mp4", "第10讲.mp4", "附录.pdf"]);
        assert!(is_video_name("01 概括.MP4"));
        assert!(!is_video_name("讲义.pdf"));
    }

    /// 网盘上放好一门课：申论 2027/第1讲.mp4、第10讲.mp4、第2讲.mp4、讲义.pdf、子文件夹。
    async fn drive_with_a_course() -> (String, std::sync::Arc<std::sync::Mutex<test_server::Store>>) {
        let (url, store) = test_server::start().await;
        let dav = WebDav::new(&url, "", "u", "p").unwrap();
        dav.ensure_dir(&encode_path("申论 2027/附加/")).await.unwrap();
        for (name, bytes) in [("第1讲.mp4", b"one".to_vec()), ("第10讲.mp4", b"ten".to_vec()), ("第2讲.mp4", b"two".to_vec()), ("讲义.pdf", b"pdf".to_vec())] {
            dav.put(&encode_path(&format!("申论 2027/{name}")), bytes).await.unwrap();
        }
        (url, store)
    }

    async fn db_with_source(dir: &Path, url: &str) -> (Db, Source) {
        let db = Db::connect_and_migrate(&dir.join("t.db")).await.unwrap();
        let source = save_source(&db, None, "家里的 NAS".into(), url.into(), "u".into(), Some("p".into())).await.unwrap();
        (db, source)
    }

    #[tokio::test]
    async fn browsing_lists_folders_first_then_lessons_in_order_with_chinese_names() {
        let (url, _store) = drive_with_a_course().await;
        let dir = tempfile::tempdir().unwrap();
        let (db, source) = db_with_source(dir.path(), &url).await;
        assert!(source.has_password);
        let root = browse(&db, &source.id, "").await.unwrap();
        assert_eq!(root.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["申论 2027"]);
        let course = browse(&db, &source.id, &root[0].path).await.unwrap();
        let names: Vec<&str> = course.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["附加", "第1讲.mp4", "第2讲.mp4", "第10讲.mp4", "讲义.pdf"]);
        assert!(course[1].is_video && !course[4].is_video);
        assert_eq!(course[1].path, "申论 2027/第1讲.mp4");
        assert!(course[1].url.ends_with("/%E7%94%B3%E8%AE%BA%202027/%E7%AC%AC1%E8%AE%B2.mp4"), "{}", course[1].url);
        assert!(test_saved(&db, &source.id, None, None, None).await.is_ok());
    }

    #[tokio::test]
    async fn downloading_a_lesson_puts_the_file_in_the_course_folder_with_its_own_name() {
        let (url, _store) = drive_with_a_course().await;
        let dir = tempfile::tempdir().unwrap();
        let (db, source) = db_with_source(dir.path(), &url).await;
        let lesson = browse(&db, &source.id, "申论 2027/").await.unwrap().into_iter().find(|e| e.name == "第2讲.mp4").unwrap();
        let out = dir.path().join("课程");
        let events = std::sync::Mutex::new(0);
        let path = download(&db, &lesson.url, &out, &dir.path().join("staging"), &|_| *events.lock().unwrap() += 1, &|| true)
            .await
            .unwrap();
        assert_eq!(path, out.join("第2讲.mp4"));
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert!(*events.lock().unwrap() > 0, "报了进度");
        assert!(!dir.path().join("staging").exists(), "半成品目录清掉了");
        // 再下一次同名的：不覆盖，另起名字。
        let again = download(&db, &lesson.url, &out, &dir.path().join("staging"), &|_| {}, &|| true).await.unwrap();
        assert_eq!(again, out.join("第2讲 (2).mp4"));
        // 取消了：不挪进课程目录。
        let cancelled = download(&db, &lesson.url, &out, &dir.path().join("staging"), &|_| {}, &|| false).await;
        assert!(cancelled.is_err());
        assert!(!out.join("第2讲 (3).mp4").exists());
        // 删掉来源后找不到凭据：说清楚。
        delete_source(&db, &source.id).await.unwrap();
        let error = download(&db, &lesson.url, &out, &dir.path().join("staging"), &|_| {}, &|| true).await.unwrap_err();
        assert!(error.to_string().contains("网盘来源"), "{error}");
    }

    #[tokio::test]
    async fn streamed_lessons_play_through_the_local_media_server_and_can_be_downloaded_later() {
        let (url, _store) = drive_with_a_course().await;
        let dir = tempfile::tempdir().unwrap();
        let (db, source) = db_with_source(dir.path(), &url).await;
        let course = crate::commands::courses::create_course(&db, "申论".into(), dir.path().to_string_lossy().into()).await.unwrap();
        let lessons: Vec<StreamItem> = browse(&db, &source.id, "申论 2027/")
            .await
            .unwrap()
            .into_iter()
            .filter(|e| e.is_video)
            .map(|e| StreamItem { title: e.name.trim_end_matches(".mp4").to_string(), url: e.url })
            .collect();
        let video_root = dir.path().join("remote-videos");
        let created = import_streaming(&db, &video_root, &course.id, &lessons).await.unwrap();
        assert_eq!(created.len(), 3);
        assert!(import_streaming(&db, &video_root, &course.id, &lessons).await.unwrap().is_empty(), "重复导入跳过");
        let videos = crate::commands::videos::list_videos(&db, &course.id).await.unwrap();
        let titles: Vec<&str> = videos.iter().map(|v| v.title.as_str()).collect();
        assert_eq!(titles, ["第1讲", "第2讲", "第10讲"]);
        assert!(videos.iter().all(|v| v.file_path.is_empty() && v.source_type == SOURCE_TYPE));

        // 播放：本机媒体服务带着账号密码去网盘拉。
        let second = &videos[1];
        let remote = stream_source(&db, &second.id).await.unwrap().expect("能在线看");
        let media = crate::media_server::start().await.unwrap();
        media.register_remote(&second.id, remote);
        let body = reqwest::get(media.url(&second.id)).await.unwrap().bytes().await.unwrap();
        assert_eq!(body.as_ref(), b"two");

        // 下载到本机：挂上文件，之后不再走在线播放。
        let local = download_streamed(&db, &second.id, &dir.path().join("课程"), &|_| {}).await.unwrap();
        assert_eq!(std::fs::read(&local.file_path).unwrap(), b"two");
        assert!(stream_source(&db, &second.id).await.unwrap().is_none());
    }

    /// 对真实的 WebDAV 服务器（OpenList、坚果云、群晖……）走一遍：浏览、在线播放（含 Range）、下载。
    /// 默认不跑。用法：
    /// `COURSEPILOT_DAV_URL=http://127.0.0.1:5244/dav/ COURSEPILOT_DAV_USER=me COURSEPILOT_DAV_PASSWORD=… \
    ///  cargo test --lib real_webdav_server -- --ignored --nocapture`
    /// 服务器上要有一个含视频的文件夹（找到的第一个）。
    #[tokio::test]
    #[ignore]
    async fn real_webdav_server_browse_stream_and_download() {
        let env = |key: &str| std::env::var(key).unwrap_or_else(|_| panic!("要设置 {key}"));
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db")).await.unwrap();
        let source = save_source(&db, None, "real".into(), env("COURSEPILOT_DAV_URL"), env("COURSEPILOT_DAV_USER"), Some(env("COURSEPILOT_DAV_PASSWORD")))
            .await
            .unwrap();
        println!("连接测试：根目录 {} 项", test_saved(&db, &source.id, None, None, None).await.unwrap());

        // 广度优先找第一个含视频的文件夹。
        let mut queue = vec![String::new()];
        let (folder, entries) = loop {
            let path = queue.remove(0);
            let entries = browse(&db, &source.id, &path).await.unwrap();
            println!("{:?}: {:?}", if path.is_empty() { "/" } else { &path }, entries.iter().map(|e| &e.name).collect::<Vec<_>>());
            if entries.iter().any(|e| e.is_video) {
                break (path, entries);
            }
            queue.extend(entries.iter().filter(|e| e.is_dir).map(|e| e.path.clone()));
            assert!(!queue.is_empty(), "服务器上没找到视频");
        };
        let lessons: Vec<StreamItem> =
            entries.iter().filter(|e| e.is_video).map(|e| StreamItem { url: e.url.clone(), title: e.name.clone() }).collect();
        println!("{folder} 里的视频（按顺序）：{:?}", lessons.iter().map(|l| &l.title).collect::<Vec<_>>());

        let course = crate::commands::courses::create_course(&db, "c".into(), dir.path().to_string_lossy().into()).await.unwrap();
        import_streaming(&db, &dir.path().join("remote"), &course.id, &lessons[..1]).await.unwrap();
        let video = crate::commands::videos::list_videos(&db, &course.id).await.unwrap().remove(0);
        let media = crate::media_server::start().await.unwrap();
        media.register_remote(&video.id, stream_source(&db, &video.id).await.unwrap().expect("能在线看"));
        let response = reqwest::Client::new().get(media.url(&video.id)).header("Range", "bytes=100-199").send().await.unwrap();
        println!("在线播放 Range：{} {:?}", response.status(), response.headers().get("content-range"));
        assert_eq!(response.status(), 206, "服务器要支持 Range，拖进度条才快");
        assert_eq!(response.bytes().await.unwrap().len(), 100);

        let started = std::time::Instant::now();
        let local = download_streamed(&db, &video.id, &dir.path().join("course"), &|_| {}).await.unwrap();
        let size = std::fs::metadata(&local.file_path).unwrap().len();
        println!("下载到本机：{} （{size} 字节，{:?}）", local.file_path, started.elapsed());
        assert_eq!(Some(size), entries.iter().find(|e| e.url == lessons[0].url).and_then(|e| e.size));
    }

    #[tokio::test]
    async fn the_sync_account_is_a_source_that_cannot_be_edited_here() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db")).await.unwrap();
        assert!(list_sources(&db).await.unwrap().is_empty());
        set_setting(&db, crate::sync::remote::SETTING_URL, "https://dav.jianguoyun.com/dav").await.unwrap();
        set_setting(&db, crate::sync::remote::SETTING_USER, "me").await.unwrap();
        let sources = list_sources(&db).await.unwrap();
        assert_eq!(sources.len(), 1);
        assert!(sources[0].is_sync);
        assert_eq!(sources[0].url, "https://dav.jianguoyun.com/dav/");
        assert!(save_source(&db, Some(SYNC_SOURCE_ID.into()), "x".into(), "https://a/".into(), "u".into(), None).await.is_err());
    }
}
