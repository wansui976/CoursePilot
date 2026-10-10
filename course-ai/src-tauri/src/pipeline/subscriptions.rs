//! 订阅：跟踪合集 / 播放列表 / UP 主投稿页，发现没见过的集就自动导入到课程。
//!
//! 订阅时把当下已有的集记为「见过」（想要存量的话，导入对话框本来就会批量导入），
//! 之后每次检查只认新出现的集。导入成功才记为见过——下载失败的集下次还会再试。

use crate::db::Db;
use crate::error::AppResult;
use crate::pipeline::download::PlaylistEpisode;
use std::collections::HashSet;

/// 一次检查最多导入几集：新订阅一个大合集、或者很久没开应用时，别一口气全下下来。
pub const MAX_IMPORTS_PER_CHECK: usize = 3;

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow, PartialEq)]
pub struct Subscription {
    pub id: String,
    pub course_id: String,
    pub url: String,
    pub title: String,
    pub auto_process: bool,
    pub last_checked_at: Option<i64>,
    pub last_error: Option<String>,
    pub created_at: i64,
}

pub async fn create(
    db: &Db,
    course_id: &str,
    url: &str,
    title: &str,
    baseline: &[String],
    auto_process: bool,
) -> AppResult<Subscription> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut tx = db.pool.begin().await?;
    // 同一课程重复订阅同一个地址：沿用原来那条，只补记存量。
    let existing: Option<String> =
        sqlx::query_scalar("SELECT id FROM subscriptions WHERE course_id=? AND url=?")
            .bind(course_id)
            .bind(url)
            .fetch_optional(&mut *tx)
            .await?;
    let id = match existing {
        Some(id) => id,
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO subscriptions(id,course_id,url,title,auto_process,created_at) VALUES (?,?,?,?,?,?)",
            )
            .bind(&id)
            .bind(course_id)
            .bind(url)
            .bind(title)
            .bind(auto_process)
            .bind(now)
            .execute(&mut *tx)
            .await?;
            id
        }
    };
    for episode in baseline {
        sqlx::query("INSERT OR IGNORE INTO subscription_seen(subscription_id,url) VALUES (?,?)")
            .bind(&id)
            .bind(episode)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    get(db, &id).await
}

pub async fn get(db: &Db, id: &str) -> AppResult<Subscription> {
    sqlx::query_as("SELECT * FROM subscriptions WHERE id=?")
        .bind(id)
        .fetch_optional(&db.pool)
        .await?
        .ok_or_else(|| crate::error::AppError::NotFound(format!("subscription {id}")))
}

/// 某课程的订阅；`course_id` 为 None 时列出所有未删除课程的订阅（定时检查用）。
pub async fn list(db: &Db, course_id: Option<&str>) -> AppResult<Vec<Subscription>> {
    Ok(sqlx::query_as(
        "SELECT s.* FROM subscriptions s JOIN courses c ON c.id=s.course_id
         WHERE c.deleted_at IS NULL AND (?1 IS NULL OR s.course_id=?1)
         ORDER BY s.created_at",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?)
}

pub async fn delete(db: &Db, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM subscription_seen WHERE subscription_id=?")
        .bind(id)
        .execute(&db.pool)
        .await?;
    sqlx::query("DELETE FROM subscriptions WHERE id=?")
        .bind(id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

/// 见过的集：记录在案的，加上课程里已经有的同地址视频（手动导入过的不再重复下）。
pub async fn seen_urls(db: &Db, subscription: &Subscription) -> AppResult<HashSet<String>> {
    let mut seen: HashSet<String> = sqlx::query_scalar::<_, String>(
        "SELECT url FROM subscription_seen WHERE subscription_id=?",
    )
    .bind(&subscription.id)
    .fetch_all(&db.pool)
    .await?
    .into_iter()
    .collect();
    let imported: Vec<String> = sqlx::query_scalar(
        "SELECT source_uri FROM videos WHERE course_id=? AND source_uri IS NOT NULL",
    )
    .bind(&subscription.course_id)
    .fetch_all(&db.pool)
    .await?;
    seen.extend(imported);
    Ok(seen)
}

/// 没见过的集，按列表原顺序、去重。
pub fn unseen<'a>(
    episodes: &'a [PlaylistEpisode],
    seen: &HashSet<String>,
) -> Vec<&'a PlaylistEpisode> {
    let mut picked: HashSet<&str> = HashSet::new();
    episodes
        .iter()
        .filter(|e| !seen.contains(&e.url) && picked.insert(e.url.as_str()))
        .collect()
}

pub async fn mark_seen(db: &Db, subscription_id: &str, url: &str) -> AppResult<()> {
    sqlx::query("INSERT OR IGNORE INTO subscription_seen(subscription_id,url) VALUES (?,?)")
        .bind(subscription_id)
        .bind(url)
        .execute(&db.pool)
        .await?;
    Ok(())
}

pub async fn record_check(db: &Db, subscription_id: &str, error: Option<&str>) -> AppResult<()> {
    sqlx::query("UPDATE subscriptions SET last_checked_at=?, last_error=? WHERE id=?")
        .bind(chrono::Utc::now().timestamp_millis())
        .bind(error)
        .bind(subscription_id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(url: &str) -> PlaylistEpisode {
        PlaylistEpisode {
            url: url.into(),
            title: url.into(),
            duration_ms: None,
        }
    }

    #[test]
    fn unseen_keeps_order_and_skips_seen_and_duplicates() {
        let episodes = [ep("a"), ep("b"), ep("c"), ep("b"), ep("d")];
        let seen: HashSet<String> = ["a".to_string(), "c".to_string()].into();
        let urls: Vec<&str> = unseen(&episodes, &seen)
            .iter()
            .map(|e| e.url.as_str())
            .collect();
        assert_eq!(urls, vec!["b", "d"]);
    }

    #[tokio::test]
    async fn subscriptions_track_baseline_imported_videos_and_cleanup() {
        let db = Db::connect_and_migrate(&crate::db::test_db_path("subscriptions"))
            .await
            .unwrap();
        let course = crate::commands::courses::create_course(&db, "c".into(), "/tmp/c".into())
            .await
            .unwrap();
        let sub = create(
            &db,
            &course.id,
            "https://x/list",
            "合集",
            &["u1".into(), "u2".into()],
            true,
        )
        .await
        .unwrap();
        assert!(sub.auto_process);
        // 重复订阅：同一条，补记存量。
        let again = create(
            &db,
            &course.id,
            "https://x/list",
            "合集",
            &["u3".into()],
            true,
        )
        .await
        .unwrap();
        assert_eq!(again.id, sub.id);

        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,source_uri,file_path,data_dir,created_at,order_index)
             VALUES ('v',?,'t','url','u4','/tmp/v.mp4','/tmp/d',0,0)",
        )
        .bind(&course.id)
        .execute(&db.pool)
        .await
        .unwrap();

        mark_seen(&db, &sub.id, "u5").await.unwrap();
        let seen = seen_urls(&db, &sub).await.unwrap();
        for url in ["u1", "u2", "u3", "u4", "u5"] {
            assert!(seen.contains(url), "{url}");
        }

        record_check(&db, &sub.id, Some("boom")).await.unwrap();
        let listed = list(&db, Some(&course.id)).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].last_error.as_deref(), Some("boom"));
        assert!(listed[0].last_checked_at.is_some());
        assert_eq!(list(&db, None).await.unwrap().len(), 1);

        delete(&db, &sub.id).await.unwrap();
        assert!(list(&db, None).await.unwrap().is_empty());
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM subscription_seen")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(left, 0);
    }
}
