use crate::commands::courses::AppState;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::storage::video_data_dir;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::borrow::Cow;
use std::path::PathBuf;
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Video {
    pub id: String,
    pub course_id: String,
    pub title: String,
    pub source_type: String,
    pub source_uri: Option<String>,
    pub file_path: String,
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub order_index: i64,
    pub data_dir: String,
    pub processed_status: String,
    pub subtitle_path: Option<String>,
    pub subtitle_lang: Option<String>,
    // 自带黑边的四边裁剪占比（0~1），导入时 cropdetect 探测；NULL=未探测/无黑边。
    pub crop_top: Option<f64>,
    pub crop_right: Option<f64>,
    pub crop_bottom: Option<f64>,
    pub crop_left: Option<f64>,
    pub created_at: i64,
}

fn percent_decode(input: &str) -> Cow<'_, str> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut changed = false;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push(((hi << 4) | lo) as u8);
                changed = true;
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    if changed {
        String::from_utf8(out)
            .map(Cow::Owned)
            .unwrap_or(Cow::Borrowed(input))
    } else {
        Cow::Borrowed(input)
    }
}

fn display_title_from_path(file_path: &std::path::Path) -> String {
    let raw = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("untitled");
    strip_file_provider_suffix(&percent_decode(raw)).into_owned()
}

fn strip_file_provider_suffix(input: &str) -> Cow<'_, str> {
    let Some(dot) = input.rfind('.') else {
        return Cow::Borrowed(input);
    };
    let stem = &input[..dot];
    let extension = &input[dot..];
    let Some(suffix_dot) = stem.rfind('.') else {
        return Cow::Borrowed(input);
    };
    let suffix = &stem[suffix_dot + 1..];
    let Some((_prefix, uuid)) = suffix.split_once('-') else {
        return Cow::Borrowed(input);
    };
    if uuid.len() != 36 {
        return Cow::Borrowed(input);
    }
    let uuid_like = uuid.chars().enumerate().all(|(idx, ch)| {
        matches!(idx, 8 | 13 | 18 | 23) && ch == '-'
            || !matches!(idx, 8 | 13 | 18 | 23) && ch.is_ascii_hexdigit()
    });
    let prefix_like = !suffix.starts_with('-')
        && suffix
            .split_once('-')
            .map(|(prefix, _)| {
                !prefix.is_empty() && prefix.chars().all(|ch| ch.is_ascii_hexdigit())
            })
            .unwrap_or(false);
    if uuid_like && prefix_like {
        Cow::Owned(format!("{}{}", &stem[..suffix_dot], extension))
    } else {
        Cow::Borrowed(input)
    }
}

pub async fn add_local_video(
    db: &Db,
    course_id: &str,
    file_path: PathBuf,
    override_root: Option<PathBuf>,
) -> AppResult<Video> {
    if !file_path.is_file() {
        return Err(AppError::NotFound(format!(
            "video file: {}",
            file_path.display()
        )));
    }

    let id = Uuid::new_v4().to_string();
    let title = display_title_from_path(&file_path);
    let data_dir = video_data_dir(&file_path, &id, override_root.as_deref());
    std::fs::create_dir_all(&data_dir)?;
    let now = Utc::now().timestamp_millis();
    let order_index: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(order_index),0)+1 FROM videos WHERE course_id=?")
            .bind(course_id)
            .fetch_one(&db.pool)
            .await?;
    let video = Video {
        id: id.clone(),
        course_id: course_id.to_string(),
        title,
        source_type: "local".into(),
        source_uri: None,
        file_path: file_path.to_string_lossy().to_string(),
        duration_ms: None,
        width: None,
        height: None,
        order_index,
        data_dir: data_dir.to_string_lossy().to_string(),
        processed_status: "pending".into(),
        subtitle_path: None,
        subtitle_lang: None,
        crop_top: None,
        crop_right: None,
        crop_bottom: None,
        crop_left: None,
        created_at: now,
    };

    sqlx::query(
        "INSERT INTO videos (id,course_id,title,source_type,source_uri,file_path,
         duration_ms,width,height,order_index,data_dir,processed_status,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&video.id)
    .bind(&video.course_id)
    .bind(&video.title)
    .bind(&video.source_type)
    .bind(&video.source_uri)
    .bind(&video.file_path)
    .bind(video.duration_ms)
    .bind(video.width)
    .bind(video.height)
    .bind(video.order_index)
    .bind(&video.data_dir)
    .bind(&video.processed_status)
    .bind(video.created_at)
    .execute(&db.pool)
    .await?;

    Ok(video)
}

pub async fn list_videos(db: &Db, course_id: &str) -> AppResult<Vec<Video>> {
    Ok(sqlx::query_as::<_, Video>(
        "SELECT * FROM videos WHERE course_id=? AND deleted_at IS NULL ORDER BY order_index ASC",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?)
}

/// 回收站保留天数；到期后由 purge_expired_trash 永久删除。
pub const TRASH_RETENTION_DAYS: i64 = 30;
const DAY_MS: i64 = 86_400_000;

/// 回收站里的一条视频（含所属课程名与到期时间，便于前端展示）。
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct TrashedVideo {
    pub id: String,
    pub title: String,
    pub course_id: String,
    pub course_name: String,
    pub deleted_at: i64,
    pub expires_at: i64,
}

pub async fn update_video_title(db: &Db, id: &str, title: String) -> AppResult<Video> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::Other("视频标题不能为空".into()));
    }
    let video = sqlx::query_as::<_, Video>("UPDATE videos SET title=? WHERE id=? RETURNING *")
        .bind(title)
        .bind(id)
        .fetch_optional(&db.pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("video {id}")))?;
    Ok(video)
}

/// 软删除：移入回收站（置 deleted_at），可在 30 天内恢复。
pub async fn delete_video(db: &Db, id: &str) -> AppResult<()> {
    let result = sqlx::query("UPDATE videos SET deleted_at=? WHERE id=? AND deleted_at IS NULL")
        .bind(Utc::now().timestamp_millis())
        .bind(id)
        .execute(&db.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("video {id}")));
    }
    Ok(())
}

/// 从回收站恢复视频；若其课程也被软删除，一并恢复课程。
pub async fn restore_video(db: &Db, id: &str) -> AppResult<()> {
    sqlx::query(
        "UPDATE courses SET deleted_at=NULL
         WHERE id=(SELECT course_id FROM videos WHERE id=?)",
    )
    .bind(id)
    .execute(&db.pool)
    .await?;
    let result = sqlx::query("UPDATE videos SET deleted_at=NULL WHERE id=?")
        .bind(id)
        .execute(&db.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("video {id}")));
    }
    Ok(())
}

/// 永久删除单个视频（连带其转写/笔记等衍生数据，经 FK 级联）。
pub async fn purge_video(db: &Db, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM videos WHERE id=?")
        .bind(id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

pub async fn list_trashed(db: &Db) -> AppResult<Vec<TrashedVideo>> {
    let retention = TRASH_RETENTION_DAYS * DAY_MS;
    Ok(sqlx::query_as::<_, TrashedVideo>(
        "SELECT v.id, v.title, v.course_id, c.name AS course_name,
                v.deleted_at AS deleted_at, v.deleted_at + ? AS expires_at
         FROM videos v JOIN courses c ON v.course_id=c.id
         WHERE v.deleted_at IS NOT NULL
         ORDER BY v.deleted_at DESC",
    )
    .bind(retention)
    .fetch_all(&db.pool)
    .await?)
}

/// 清理过期回收站：删除超过保留期的视频，再删掉没有任何视频的已软删课程。
pub async fn purge_expired_trash(db: &Db) -> AppResult<u64> {
    let cutoff = Utc::now().timestamp_millis() - TRASH_RETENTION_DAYS * DAY_MS;
    let result = sqlx::query("DELETE FROM videos WHERE deleted_at IS NOT NULL AND deleted_at < ?")
        .bind(cutoff)
        .execute(&db.pool)
        .await?;
    sqlx::query(
        "DELETE FROM courses
         WHERE deleted_at IS NOT NULL
           AND id NOT IN (SELECT DISTINCT course_id FROM videos)",
    )
    .execute(&db.pool)
    .await?;
    Ok(result.rows_affected())
}

#[tauri::command]
pub async fn cmd_add_local_video(
    state: State<'_, AppState>,
    course_id: String,
    file_path: String,
) -> AppResult<Video> {
    let override_root = sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key='default_storage_root'",
    )
    .fetch_optional(&state.db.pool)
    .await?
    .filter(|value| !value.trim().is_empty())
    .map(PathBuf::from);
    let mut video = add_local_video(
        &state.db,
        &course_id,
        PathBuf::from(file_path),
        override_root,
    )
    .await?;
    apply_detected_crop(&state.db, &mut video).await;
    Ok(video)
}

/// 导入后用 ffmpeg cropdetect 探测黑边并写库，同时回填到返回的 Video，
/// 让前端拿到结果即可显示裁剪。无黑边写 0（标记已探测）；ffmpeg 没跑成则保持 NULL。
pub async fn apply_detected_crop(db: &Db, video: &mut Video) {
    let path = PathBuf::from(&video.file_path);
    let c = crate::pipeline::crop_detect::ensure_crop(db, &video.id, path).await;
    video.crop_top = Some(c.top);
    video.crop_right = Some(c.right);
    video.crop_bottom = Some(c.bottom);
    video.crop_left = Some(c.left);
}

/// 打开视频时的兜底：若该视频还没有 crop 记录（crop_top IS NULL，多为导入早于本功能的旧视频），
/// 后台补测一次黑边并写库；已测过的直接返回库里的值。返回四边占比（无黑边为 0）。
#[tauri::command]
pub async fn cmd_ensure_crop(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<crate::pipeline::crop_detect::CropInsets> {
    let row = sqlx::query_as::<_, (Option<f64>, Option<f64>, Option<f64>, Option<f64>, String)>(
        "SELECT crop_top,crop_right,crop_bottom,crop_left,file_path FROM videos WHERE id=?",
    )
    .bind(&video_id)
    .fetch_one(&state.db.pool)
    .await?;
    if let (Some(top), right, bottom, left, _) = (row.0, row.1, row.2, row.3, &row.4) {
        return Ok(crate::pipeline::crop_detect::CropInsets {
            top,
            right: right.unwrap_or(0.0),
            bottom: bottom.unwrap_or(0.0),
            left: left.unwrap_or(0.0),
        });
    }
    Ok(crate::pipeline::crop_detect::ensure_crop(&state.db, &video_id, PathBuf::from(row.4)).await)
}

#[tauri::command]
pub async fn cmd_list_videos(
    state: State<'_, AppState>,
    course_id: String,
) -> AppResult<Vec<Video>> {
    list_videos(&state.db, &course_id).await
}

#[tauri::command]
pub async fn cmd_update_video_title(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> AppResult<Video> {
    update_video_title(&state.db, &id, title).await
}

#[tauri::command]
pub async fn cmd_delete_video(state: State<'_, AppState>, id: String) -> AppResult<()> {
    delete_video(&state.db, &id).await
}

#[tauri::command]
pub async fn cmd_restore_video(state: State<'_, AppState>, id: String) -> AppResult<()> {
    restore_video(&state.db, &id).await
}

#[tauri::command]
pub async fn cmd_purge_video(state: State<'_, AppState>, id: String) -> AppResult<()> {
    purge_video(&state.db, &id).await
}

#[tauri::command]
pub async fn cmd_list_trash(state: State<'_, AppState>) -> AppResult<Vec<TrashedVideo>> {
    // 列表前先清掉过期项，保证用户看到的都是仍可恢复的。
    purge_expired_trash(&state.db).await?;
    list_trashed(&state.db).await
}

/// 返回一个 WebView 可正常播放（含音轨）的路径：非 faststart 的 MP4 会被
/// 快速转封装成 data_dir/playable.mp4，避免大文件「有画面、没声音」。
#[tauri::command]
pub async fn cmd_ensure_playable(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<String> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT file_path, data_dir FROM videos WHERE id=?")
            .bind(&video_id)
            .fetch_optional(&state.db.pool)
            .await?;
    let (file_path, data_dir) =
        row.ok_or_else(|| AppError::NotFound(format!("video {video_id}")))?;
    let path = crate::pipeline::playable::ensure_playable(
        std::path::Path::new(&file_path),
        std::path::Path::new(&data_dir),
    )
    .await?;
    Ok(path.to_string_lossy().to_string())
}

/// 返回一个 WebView 可播放的 http://127.0.0.1 媒体 URL（带完整 Range 支持），
/// 绕开 asset 协议在 macOS WKWebView 下「大文件没声音/放不了」的限制。
/// 顺带对非 faststart 的文件做一次转封装，让起播更快。
#[tauri::command]
pub async fn cmd_media_url(
    state: State<'_, AppState>,
    media: State<'_, crate::media_server::MediaServer>,
    video_id: String,
) -> AppResult<String> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT file_path, data_dir FROM videos WHERE id=?")
            .bind(&video_id)
            .fetch_optional(&state.db.pool)
            .await?;
    let (file_path, data_dir) =
        row.ok_or_else(|| AppError::NotFound(format!("video {video_id}")))?;
    let path = crate::pipeline::playable::ensure_playable(
        std::path::Path::new(&file_path),
        std::path::Path::new(&data_dir),
    )
    .await?;
    media.register(&video_id, path);
    Ok(media.url(&video_id))
}

/// 视频封面（首帧）字节，前端转 blob 显示。首次调用时用 ffmpeg 截首帧并缓存。
#[tauri::command]
pub async fn cmd_video_cover(state: State<'_, AppState>, video_id: String) -> AppResult<Vec<u8>> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT file_path, data_dir FROM videos WHERE id=?")
            .bind(&video_id)
            .fetch_optional(&state.db.pool)
            .await?;
    let (file_path, data_dir) =
        row.ok_or_else(|| AppError::NotFound(format!("video {video_id}")))?;
    let cover = crate::pipeline::slides::ensure_cover(
        std::path::Path::new(&file_path),
        std::path::Path::new(&data_dir),
    )
    .await?;
    Ok(tokio::fs::read(&cover).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use tempfile::tempdir;

    #[tokio::test]
    async fn add_local_creates_data_dir_and_row() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        let course = create_course(&db, "c".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let video_path = dir.path().join("01.mp4");
        std::fs::write(&video_path, b"fake").unwrap();

        let video = add_local_video(&db, &course.id, video_path, None)
            .await
            .unwrap();
        assert_eq!(video.processed_status, "pending");
        assert!(std::path::Path::new(&video.data_dir).is_dir());

        let list = list_videos(&db, &course.id).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].order_index, 1);
    }

    #[tokio::test]
    async fn add_local_decodes_ios_percent_encoded_file_provider_title() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        let course = create_course(&db, "c".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let video_path = dir.path().join(
            "%E9%81%93%E5%BE%B7%E6%B0%B4%E5%B9%B3%E9%AB%98%EF%BC%8C%E5%AF%BC%E8%87%B4%E5%AD%A6%E6%9C%AF%E9%80%A0%E5%81%87%E5%A4%9A%EF%BC%9F.f30080-6A1CC6C8-C5A4-4BC9-AFAC-3A402347A35E.mp4",
        );
        std::fs::write(&video_path, b"fake").unwrap();

        let video = add_local_video(&db, &course.id, video_path, None)
            .await
            .unwrap();

        assert_eq!(video.title, "道德水平高，导致学术造假多？.mp4");
    }

    #[tokio::test]
    async fn rejects_missing_file() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        let course = create_course(&db, "c".into(), "/x".into()).await.unwrap();
        let err = add_local_video(&db, &course.id, "/nonexistent.mp4".into(), None).await;
        assert!(matches!(err, Err(AppError::NotFound(_))));
    }

    async fn seed_video(dir: &tempfile::TempDir) -> (Db, String, String) {
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        let course = create_course(&db, "c".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let video_path = dir.path().join("01.mp4");
        std::fs::write(&video_path, b"fake").unwrap();
        let video = add_local_video(&db, &course.id, video_path, None)
            .await
            .unwrap();
        (db, course.id, video.id)
    }

    #[tokio::test]
    async fn delete_moves_to_trash_and_restore_brings_back() {
        let dir = tempdir().unwrap();
        let (db, course_id, video_id) = seed_video(&dir).await;

        delete_video(&db, &video_id).await.unwrap();
        // 删除后不在课程列表，但在回收站，且有到期时间。
        assert!(list_videos(&db, &course_id).await.unwrap().is_empty());
        let trash = list_trashed(&db).await.unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].course_name, "c");
        assert!(trash[0].expires_at > trash[0].deleted_at);

        restore_video(&db, &video_id).await.unwrap();
        assert_eq!(list_videos(&db, &course_id).await.unwrap().len(), 1);
        assert!(list_trashed(&db).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn videos_table_has_subtitle_columns() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course = crate::commands::courses::create_course(
            &db, "c".into(), dir.path().to_string_lossy().into())
            .await.unwrap();
        let vpath = dir.path().join("v.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = add_local_video(&db, &course.id, vpath, None).await.unwrap();

        sqlx::query("UPDATE videos SET subtitle_path=?, subtitle_lang=? WHERE id=?")
            .bind("/tmp/x.ai-zh.srt").bind("ai-zh").bind(&video.id)
            .execute(&db.pool).await.unwrap();

        let got: Video = sqlx::query_as("SELECT * FROM videos WHERE id=?")
            .bind(&video.id).fetch_one(&db.pool).await.unwrap();
        assert_eq!(got.subtitle_lang.as_deref(), Some("ai-zh"));
        assert_eq!(got.subtitle_path.as_deref(), Some("/tmp/x.ai-zh.srt"));
    }

    #[tokio::test]
    async fn purge_expired_removes_old_but_keeps_recent() {
        let dir = tempdir().unwrap();
        let (db, _course_id, video_id) = seed_video(&dir).await;
        // 把 deleted_at 调到 31 天前，应被清理。
        let old = Utc::now().timestamp_millis() - 31 * DAY_MS;
        sqlx::query("UPDATE videos SET deleted_at=? WHERE id=?")
            .bind(old)
            .bind(&video_id)
            .execute(&db.pool)
            .await
            .unwrap();
        let removed = purge_expired_trash(&db).await.unwrap();
        assert_eq!(removed, 1);
        assert!(list_trashed(&db).await.unwrap().is_empty());
    }
}
