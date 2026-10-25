//! 笔记图片：粘贴 / 拖入 / 截取视频画面后存进 note_images，笔记里只留 `note-image:<id>` 引用。
//!
//! 前端负责把图压到 [`MAX_IMAGE_BYTES`] 以内（缩尺寸、转 JPEG）；这里只做校验与存取。
//! 上限来自云同步：一条记录最多 1MB，图片以 base64 进信封，膨胀 4/3 后还要留出余量。

use crate::commands::courses::AppState;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use base64::Engine as _;
use sha2::{Digest, Sha256};
use tauri::State;

pub const MAX_IMAGE_BYTES: usize = 600 * 1024;
pub const IMAGE_REF_PREFIX: &str = "note-image:";
const ALLOWED_MIME: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct SavedNoteImage {
    pub id: String,
    /// 笔记里引用这张图用的 src。
    pub src: String,
}

/// 同一视频里的同一张图得到同一个 id；不同视频各存一份，删一个视频不会带走另一个的图。
fn image_id(video_id: &str, bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(video_id.as_bytes());
    hasher.update([0]);
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub async fn save_note_image(
    db: &Db,
    video_id: &str,
    mime: &str,
    bytes: &[u8],
    width: Option<i64>,
    height: Option<i64>,
) -> AppResult<SavedNoteImage> {
    if !ALLOWED_MIME.contains(&mime) {
        return Err(AppError::Other(format!("不支持的图片格式：{mime}")));
    }
    if bytes.is_empty() {
        return Err(AppError::Other("图片是空的".into()));
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(AppError::Other(format!(
            "图片太大（{} KB），压缩后仍超过 {} KB",
            bytes.len() / 1024,
            MAX_IMAGE_BYTES / 1024
        )));
    }
    let id = image_id(video_id, bytes);
    sqlx::query(
        "INSERT OR IGNORE INTO note_images(id,video_id,mime,data,width,height,created_at)
         VALUES (?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(video_id)
    .bind(mime)
    .bind(bytes)
    .bind(width)
    .bind(height)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db.pool)
    .await?;
    Ok(SavedNoteImage {
        src: format!("{IMAGE_REF_PREFIX}{id}"),
        id,
    })
}

pub async fn read_note_image(db: &Db, id: &str) -> AppResult<(String, Vec<u8>)> {
    sqlx::query_as("SELECT mime,data FROM note_images WHERE id=?")
        .bind(id)
        .fetch_optional(&db.pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("note image {id}")))
}

/// 导出 Markdown 时把 `](note-image:<id>)` 换成 data: URL，导出的单个 .md 文件自带图片，
/// 在 Typora / Obsidian 等编辑器里直接能看。找不到的图保留原引用。
pub async fn inline_note_images(db: &Db, markdown: &str) -> AppResult<String> {
    let needle = format!("]({IMAGE_REF_PREFIX}");
    let mut out = String::with_capacity(markdown.len());
    let mut rest = markdown;
    while let Some(start) = rest.find(&needle) {
        let id_start = start + needle.len();
        let Some(id_len) = rest[id_start..].find(')') else {
            break;
        };
        let id = &rest[id_start..id_start + id_len];
        out.push_str(&rest[..start + 2]);
        match read_note_image(db, id).await {
            Ok((mime, bytes)) => {
                out.push_str("data:");
                out.push_str(&mime);
                out.push_str(";base64,");
                out.push_str(&base64::engine::general_purpose::STANDARD.encode(bytes));
            }
            Err(AppError::NotFound(_)) => {
                out.push_str(IMAGE_REF_PREFIX);
                out.push_str(id);
            }
            Err(error) => return Err(error),
        }
        out.push(')');
        rest = &rest[id_start + id_len + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

#[tauri::command]
pub async fn cmd_save_note_image(
    state: State<'_, AppState>,
    video_id: String,
    mime: String,
    data_base64: String,
    width: Option<i64>,
    height: Option<i64>,
) -> AppResult<SavedNoteImage> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|error| AppError::Other(format!("图片数据损坏：{error}")))?;
    save_note_image(&state.db, &video_id, &mime, &bytes, width, height).await
}

// 返回 ipc::Response（原始二进制），避免 Vec<u8> 被序列化成 JSON 数字数组（见 cmd_video_cover）。
#[tauri::command]
pub async fn cmd_read_note_image(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<tauri::ipc::Response> {
    let (_mime, bytes) = read_note_image(&state.db, &id).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::videos::add_local_video;
    use tempfile::tempdir;

    async fn seed() -> (Db, tempfile::TempDir, String) {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course = create_course(&db, "c".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let file = dir.path().join("v.mp4");
        std::fs::write(&file, b"x").unwrap();
        let video = add_local_video(&db, &course.id, file, None).await.unwrap();
        (db, dir, video.id)
    }

    #[tokio::test]
    async fn same_image_is_stored_once_and_reads_back() {
        let (db, _dir, video) = seed().await;
        let first = save_note_image(&db, &video, "image/png", b"png-bytes", Some(2), Some(1))
            .await
            .unwrap();
        let second = save_note_image(&db, &video, "image/png", b"png-bytes", None, None)
            .await
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(first.src, format!("note-image:{}", first.id));
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM note_images")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        let (mime, bytes) = read_note_image(&db, &first.id).await.unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, b"png-bytes");
    }

    #[tokio::test]
    async fn rejects_oversized_or_unknown_images() {
        let (db, _dir, video) = seed().await;
        let big = vec![0_u8; MAX_IMAGE_BYTES + 1];
        assert!(save_note_image(&db, &video, "image/jpeg", &big, None, None)
            .await
            .is_err());
        assert!(
            save_note_image(&db, &video, "image/svg+xml", b"<svg/>", None, None)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn saving_an_image_queues_it_for_sync() {
        let (db, _dir, video) = seed().await;
        let saved = save_note_image(&db, &video, "image/png", b"a", None, None)
            .await
            .unwrap();
        let queued: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sync_outbox WHERE record_type='NoteImage' AND record_id=?",
        )
        .bind(&saved.id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(queued, 1);
    }

    #[tokio::test]
    async fn export_inlines_known_images_and_keeps_unknown_refs() {
        let (db, _dir, video) = seed().await;
        let saved = save_note_image(&db, &video, "image/png", b"hi", None, None)
            .await
            .unwrap();
        let md = format!("前 ![图]({}) 中 ![](note-image:missing) 后", saved.src);
        let out = inline_note_images(&db, &md).await.unwrap();
        assert_eq!(
            out,
            "前 ![图](data:image/png;base64,aGk=) 中 ![](note-image:missing) 后"
        );
    }
}
