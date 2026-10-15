//! 笔记版本历史：本机留底（note_versions，由触发器写入）+ 每日启动快照里的同一篇笔记。
//!
//! 只读：恢复由前端把某个版本装回编辑器、再走正常保存完成——这样恢复本身可以撤销，
//! 覆盖前的内容也会被触发器再留一份底。

use crate::commands::courses::AppState;
use crate::db::Db;
use crate::error::AppResult;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::collections::HashSet;
use std::path::Path;
use tauri::{Manager, State};

#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct NoteVersion {
    /// `h:<id>` 本机留底；`b:<文件名>` 每日启动快照。
    pub id: String,
    /// "history" | "backup"
    pub source: &'static str,
    /// 这份内容最后被写入的时间（毫秒）；未知时为 None。
    pub edited_at: Option<i64>,
    /// 留底 / 快照的时间（毫秒）。
    pub captured_at: i64,
    /// 与 cmd_get_notes 同形：优先 Tiptap JSON，否则 markdown。
    pub content: String,
}

type NoteRow = (Option<String>, Option<String>, Option<i64>, Option<i64>);

fn pick_content(json: Option<String>, md: Option<String>) -> Option<String> {
    json.or(md).filter(|content| !content.trim().is_empty())
}

/// 启动快照文件名形如 `courseai-startup-20261013.db`，取日期当天 0 点（本地时区）。
fn snapshot_time(path: &Path) -> Option<i64> {
    use chrono::{Local, NaiveDate, TimeZone};
    let stem = path.file_stem()?.to_str()?;
    let digits = stem.rsplit('-').next()?;
    let date = NaiveDate::parse_from_str(digits.get(..8)?, "%Y%m%d").ok()?;
    let midnight = date.and_hms_opt(0, 0, 0)?;
    Some(Local.from_local_datetime(&midnight).single()?.timestamp_millis())
}

async fn read_snapshot_note(path: &Path, video_id: &str) -> Option<NoteRow> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .ok()?;
    let row: Option<NoteRow> = sqlx::query_as(
        "SELECT content_json, content_md, user_edited_at, ai_generated_at FROM notes WHERE video_id=?",
    )
    .bind(video_id)
    .fetch_optional(&pool)
    .await
    .ok()
    .flatten();
    pool.close().await;
    row
}

/// 某个视频笔记的全部历史版本，新的在前。与当前内容相同、或彼此重复的版本只留最新一份。
pub async fn list_note_versions(
    db: &Db,
    snapshot_dir: Option<&Path>,
    video_id: &str,
) -> AppResult<Vec<NoteVersion>> {
    let current: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT content_json, content_md FROM notes WHERE video_id=?")
            .bind(video_id)
            .fetch_optional(&db.pool)
            .await?;
    let mut seen: HashSet<String> = HashSet::new();
    if let Some(content) = current.and_then(|(json, md)| pick_content(json, md)) {
        seen.insert(content);
    }

    let mut versions = Vec::new();
    let history: Vec<(i64, Option<String>, Option<String>, Option<i64>, i64)> = sqlx::query_as(
        "SELECT id, content_json, content_md, edited_at, captured_at
         FROM note_versions WHERE video_id=? ORDER BY id DESC",
    )
    .bind(video_id)
    .fetch_all(&db.pool)
    .await?;
    for (id, json, md, edited_at, captured_at) in history {
        let Some(content) = pick_content(json, md) else { continue };
        if !seen.insert(content.clone()) {
            continue;
        }
        versions.push(NoteVersion {
            id: format!("h:{id}"),
            source: "history",
            edited_at: edited_at.filter(|stamp| *stamp > 0),
            captured_at,
            content,
        });
    }

    if let Some(dir) = snapshot_dir {
        let mut files: Vec<_> = std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .filter(|path| path.extension().is_some_and(|ext| ext == "db"))
                    .collect()
            })
            .unwrap_or_default();
        files.sort();
        files.reverse();
        for path in files {
            let Some((json, md, user, ai)) = read_snapshot_note(&path, video_id).await else {
                continue;
            };
            let Some(content) = pick_content(json, md) else { continue };
            if !seen.insert(content.clone()) {
                continue;
            }
            let edited_at = user.unwrap_or(0).max(ai.unwrap_or(0));
            let captured_at = snapshot_time(&path).unwrap_or(edited_at);
            versions.push(NoteVersion {
                id: format!("b:{}", path.file_name().unwrap_or_default().to_string_lossy()),
                source: "backup",
                edited_at: (edited_at > 0).then_some(edited_at),
                captured_at,
                content,
            });
        }
    }

    versions.sort_by(|a, b| b.captured_at.cmp(&a.captured_at));
    Ok(versions)
}

#[tauri::command]
pub async fn cmd_list_note_versions(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Vec<NoteVersion>> {
    let snapshot_dir = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("backups").join("startup"));
    list_note_versions(&state.db, snapshot_dir.as_deref(), &video_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn setup() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db")).await.unwrap();
        let course = crate::commands::courses::create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at,order_index)
             VALUES ('v',?,'视频','local','/tmp/v.mp4','/tmp/data',0,0)",
        )
        .bind(&course.id)
        .execute(&db.pool)
        .await
        .unwrap();
        (dir, db)
    }

    async fn save(db: &Db, content: &str) {
        sqlx::query(
            "INSERT INTO notes(video_id,content_json,user_edited_at) VALUES ('v',?,1)
             ON CONFLICT(video_id) DO UPDATE SET content_json=excluded.content_json",
        )
        .bind(content)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    fn long(text: &str) -> String {
        text.repeat(80)
    }

    #[tokio::test]
    async fn emptying_a_note_keeps_the_previous_content() {
        let (_dir, db) = setup().await;
        save(&db, &long("梯度下降")).await;
        save(&db, "{}").await;

        let versions = list_note_versions(&db, None, "v").await.unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].content, long("梯度下降"));
        assert_eq!(versions[0].source, "history");
    }

    #[tokio::test]
    async fn small_edits_within_ten_minutes_are_throttled() {
        let (_dir, db) = setup().await;
        save(&db, &long("一")).await;
        save(&db, &format!("{}二", long("一"))).await; // 首次覆盖：留底
        save(&db, &format!("{}三", long("一"))).await; // 10 分钟内的小改：不留
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM note_versions")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count, 1);

        // 但「砍掉一大半」不受节流限制。
        save(&db, "短").await;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM note_versions")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn ai_regeneration_always_keeps_the_replaced_note() {
        let (_dir, db) = setup().await;
        save(&db, &long("手写")).await;
        save(&db, &format!("{}改", long("手写"))).await; // 首次覆盖：留底，开始 10 分钟节流
        sqlx::query("UPDATE notes SET content_md=?, ai_generated_at=5, content_json=NULL WHERE video_id='v'")
            .bind(long("AI 新写的更长的笔记"))
            .execute(&db.pool)
            .await
            .unwrap();

        let versions = list_note_versions(&db, None, "v").await.unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].content, format!("{}改", long("手写")));
    }

    #[tokio::test]
    async fn keeps_at_most_fifty_versions_per_note() {
        let (_dir, db) = setup().await;
        save(&db, &long("起")).await;
        for i in 0..60 {
            // 每次都砍到不足一半再恢复，强制留底。
            save(&db, "x").await;
            save(&db, &long(&format!("版本{i}"))).await;
        }
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM note_versions")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count, 50);
    }

    #[tokio::test]
    async fn includes_snapshot_versions_and_skips_duplicates() {
        let (dir, db) = setup().await;
        save(&db, &long("快照里的笔记")).await;

        let snapshots = dir.path().join("startup");
        std::fs::create_dir_all(&snapshots).unwrap();
        crate::backup::create_database_backup(&db, &snapshots.join("courseai-startup-20261013.db"))
            .await
            .unwrap();
        crate::backup::create_database_backup(&db, &snapshots.join("courseai-startup-20261012.db"))
            .await
            .unwrap();

        save(&db, "{}").await;

        let versions = list_note_versions(&db, Some(&snapshots), "v").await.unwrap();
        // 留底与两份快照内容相同，只保留一份（最新的那条）。
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].content, long("快照里的笔记"));
    }
}
