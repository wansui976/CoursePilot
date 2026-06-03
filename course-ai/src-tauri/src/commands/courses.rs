use crate::db::Db;
use crate::error::AppResult;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
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
}
