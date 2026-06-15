use crate::db::Db;
use crate::error::{AppError, AppResult};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::State;
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Course {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub cover_image: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub async fn create_course(db: &Db, name: String, root_path: String) -> AppResult<Course> {
    let now = Utc::now().timestamp_millis();
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO courses (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)")
        .bind(&id)
        .bind(&name)
        .bind(&root_path)
        .bind(now)
        .bind(now)
        .execute(&db.pool)
        .await?;
    Ok(Course {
        id,
        name,
        root_path,
        cover_image: None,
        created_at: now,
        updated_at: now,
    })
}

pub async fn list_courses(db: &Db) -> AppResult<Vec<Course>> {
    Ok(sqlx::query_as::<_, Course>(
        "SELECT id,name,root_path,cover_image,created_at,updated_at
         FROM courses WHERE deleted_at IS NULL ORDER BY updated_at DESC",
    )
    .fetch_all(&db.pool)
    .await?)
}

/// 删除课程：把课程的视频移入回收站（软删除），并软删除课程本身。
/// 不直接 DELETE 课程行，否则 FK 级联会把回收站里的视频一并硬删除。
pub async fn delete_course(db: &Db, id: String) -> AppResult<()> {
    let now = Utc::now().timestamp_millis();
    sqlx::query("UPDATE videos SET deleted_at=? WHERE course_id=? AND deleted_at IS NULL")
        .bind(now)
        .bind(&id)
        .execute(&db.pool)
        .await?;
    sqlx::query("UPDATE courses SET deleted_at=? WHERE id=?")
        .bind(now)
        .bind(&id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

pub async fn rename_course(db: &Db, id: String, name: String) -> AppResult<()> {
    sqlx::query("UPDATE courses SET name=?, updated_at=? WHERE id=?")
        .bind(name)
        .bind(Utc::now().timestamp_millis())
        .bind(id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct RelinkResult {
    pub total: usize,
    pub relinked: usize,
    pub ambiguous: Vec<String>,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MatchOutcome {
    Relinked(PathBuf),
    Ambiguous,
    Missing,
}

pub struct VideoKey {
    pub id: String,
    pub title: String,
    pub basename_lower: String,
}

/// 按文件名（大小写不敏感）把视频对应到扫描出的文件：
/// 唯一命中 → Relinked(新绝对路径)；命中多份 → Ambiguous；没命中 → Missing。
pub fn match_videos_to_files(
    videos: &[VideoKey],
    scanned: &[PathBuf],
) -> Vec<(String, MatchOutcome)> {
    let mut by_name: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for path in scanned {
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            by_name
                .entry(name.to_lowercase())
                .or_default()
                .push(path.clone());
        }
    }
    videos
        .iter()
        .map(|v| {
            let outcome = match by_name.get(&v.basename_lower) {
                Some(paths) if paths.len() == 1 => MatchOutcome::Relinked(paths[0].clone()),
                Some(_) => MatchOutcome::Ambiguous,
                None => MatchOutcome::Missing,
            };
            (v.id.clone(), outcome)
        })
        .collect()
}

/// 递归收集 root 下所有普通文件的绝对路径。root 不是可读目录 → 报错；
/// 子目录读不动则跳过（best-effort），不影响整体。
fn scan_files_recursive(root: &Path) -> AppResult<Vec<PathBuf>> {
    if !root.is_dir() {
        return Err(AppError::NotFound(format!(
            "不是有效目录: {}",
            root.display()
        )));
    }
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                out.push(path);
            }
        }
    }
    Ok(out)
}

/// 把课程根目录改到 new_root，并按文件名把该课程下的视频重连到新位置。
/// root_path 与命中的 file_path 在同一事务里更新。
pub async fn relink_course_root(
    db: &Db,
    course_id: &str,
    new_root: String,
) -> AppResult<RelinkResult> {
    let root = PathBuf::from(&new_root);
    let scanned = scan_files_recursive(&root)?;

    let videos: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, title, file_path FROM videos
         WHERE course_id=? AND deleted_at IS NULL",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?;

    let keys: Vec<VideoKey> = videos
        .iter()
        .map(|(id, title, fp)| VideoKey {
            id: id.clone(),
            title: title.clone(),
            basename_lower: Path::new(fp)
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_lowercase())
                .unwrap_or_default(),
        })
        .collect();

    let outcomes = match_videos_to_files(&keys, &scanned);
    let title_of: HashMap<&str, &str> =
        videos.iter().map(|(id, t, _)| (id.as_str(), t.as_str())).collect();

    let now = Utc::now().timestamp_millis();
    let mut tx = db.pool.begin().await?;
    sqlx::query("UPDATE courses SET root_path=?, updated_at=? WHERE id=?")
        .bind(&new_root)
        .bind(now)
        .bind(course_id)
        .execute(&mut *tx)
        .await?;

    let mut relinked = 0usize;
    let mut ambiguous = Vec::new();
    let mut missing = Vec::new();
    for (id, outcome) in &outcomes {
        match outcome {
            MatchOutcome::Relinked(path) => {
                sqlx::query("UPDATE videos SET file_path=? WHERE id=?")
                    .bind(path.to_string_lossy().to_string())
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                relinked += 1;
            }
            MatchOutcome::Ambiguous => {
                ambiguous.push(title_of.get(id.as_str()).copied().unwrap_or("").to_string());
            }
            MatchOutcome::Missing => {
                missing.push(title_of.get(id.as_str()).copied().unwrap_or("").to_string());
            }
        }
    }
    tx.commit().await?;

    Ok(RelinkResult {
        total: outcomes.len(),
        relinked,
        ambiguous,
        missing,
    })
}

#[tauri::command]
pub async fn cmd_relink_course_root(
    state: State<'_, AppState>,
    course_id: String,
    new_root: String,
) -> AppResult<RelinkResult> {
    relink_course_root(&state.db, &course_id, new_root).await
}

#[tauri::command]
pub async fn cmd_create_course(
    state: State<'_, AppState>,
    name: String,
    root_path: String,
) -> AppResult<Course> {
    create_course(&state.db, name, root_path).await
}

#[tauri::command]
pub async fn cmd_list_courses(state: State<'_, AppState>) -> AppResult<Vec<Course>> {
    list_courses(&state.db).await
}

#[tauri::command]
pub async fn cmd_delete_course(state: State<'_, AppState>, id: String) -> AppResult<()> {
    delete_course(&state.db, id).await
}

#[tauri::command]
pub async fn cmd_rename_course(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> AppResult<()> {
    rename_course(&state.db, id, name).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh_db() -> Db {
        let db_path = std::env::temp_dir().join(format!("course-ai-test-{}.db", Uuid::new_v4()));
        Db::connect_and_migrate(&db_path).await.unwrap()
    }

    #[tokio::test]
    async fn create_then_list_returns_one() {
        let db = fresh_db().await;
        let course = create_course(&db, "申论".into(), "/tmp/shenlun".into())
            .await
            .unwrap();
        let list = list_courses(&db).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, course.id);
        assert_eq!(list[0].name, "申论");
    }

    #[tokio::test]
    async fn delete_removes_course() {
        let db = fresh_db().await;
        let course = create_course(&db, "x".into(), "/tmp/x".into())
            .await
            .unwrap();
        delete_course(&db, course.id).await.unwrap();
        assert_eq!(list_courses(&db).await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn rename_updates_course_name() {
        let db = fresh_db().await;
        let course = create_course(&db, "旧名".into(), "/tmp/x".into())
            .await
            .unwrap();
        rename_course(&db, course.id.clone(), "新名".into())
            .await
            .unwrap();
        let list = list_courses(&db).await.unwrap();
        assert_eq!(list[0].name, "新名");
    }

    #[test]
    fn matcher_handles_unique_missing_ambiguous_and_case() {
        let videos = vec![
            VideoKey { id: "u".into(), title: "u".into(), basename_lower: "a.mp4".into() },
            VideoKey { id: "m".into(), title: "m".into(), basename_lower: "b.mp4".into() },
            VideoKey { id: "d".into(), title: "d".into(), basename_lower: "c.mp4".into() },
            VideoKey { id: "ci".into(), title: "ci".into(), basename_lower: "e.mp4".into() },
        ];
        let scanned = vec![
            PathBuf::from("/x/a.mp4"),
            PathBuf::from("/x/c.mp4"),
            PathBuf::from("/y/c.mp4"),
            PathBuf::from("/z/E.MP4"),
        ];
        let out = match_videos_to_files(&videos, &scanned);
        let get = |id: &str| out.iter().find(|(i, _)| i == id).unwrap().1.clone();
        assert_eq!(get("u"), MatchOutcome::Relinked(PathBuf::from("/x/a.mp4")));
        assert_eq!(get("m"), MatchOutcome::Missing);
        assert_eq!(get("d"), MatchOutcome::Ambiguous);
        assert_eq!(get("ci"), MatchOutcome::Relinked(PathBuf::from("/z/E.MP4")));
    }

    #[tokio::test]
    async fn relink_updates_matched_paths_and_root() {
        let db = fresh_db().await;
        let course = create_course(&db, "ml".into(), "/old".into()).await.unwrap();
        for (vid, fp) in [("v1", "/old/a.mp4"), ("v2", "/old/b.mp4")] {
            sqlx::query(
                "INSERT INTO videos (id,course_id,title,source_type,file_path,data_dir,created_at)
                 VALUES (?,?,?,?,?,?,?)",
            )
            .bind(vid)
            .bind(&course.id)
            .bind(vid)
            .bind("local")
            .bind(fp)
            .bind("/old/.courseai")
            .bind(0i64)
            .execute(&db.pool)
            .await
            .unwrap();
        }

        let tmp = tempfile::tempdir().unwrap();
        let sub = tmp.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("a.mp4"), b"x").unwrap();

        let res = relink_course_root(&db, &course.id, tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();

        assert_eq!(res.total, 2);
        assert_eq!(res.relinked, 1);
        assert_eq!(res.missing, vec!["v2".to_string()]);

        let a_path: String = sqlx::query_scalar("SELECT file_path FROM videos WHERE id='v1'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(a_path, sub.join("a.mp4").to_string_lossy());

        let root: String = sqlx::query_scalar("SELECT root_path FROM courses WHERE id=?")
            .bind(&course.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(root, tmp.path().to_string_lossy());
    }
}
