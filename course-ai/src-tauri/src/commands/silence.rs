use crate::commands::courses::AppState;
use crate::commands::videos::Video;
use crate::error::{AppError, AppResult};
use crate::pipeline::silence::{self, SkipOptions, SkipRange};
use std::path::Path;
use tauri::State;

async fn load_video(state: &AppState, video_id: &str) -> AppResult<Video> {
    sqlx::query_as("SELECT * FROM videos WHERE id=? AND deleted_at IS NULL")
        .bind(video_id)
        .fetch_optional(&state.db.pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("video {video_id}")))
}

/// 该视频是否已经扫过静音。扫过但一段静音都没有也算扫过，否则每次播放都会重扫。
async fn already_scanned(state: &AppState, video_id: &str) -> AppResult<bool> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM video_silence_scans WHERE video_id=?)",
    )
    .bind(video_id)
    .fetch_one(&state.db.pool)
    .await?)
}

async fn store_silences(
    state: &AppState,
    video_id: &str,
    ranges: &[silence::Silence],
) -> AppResult<()> {
    let mut tx = state.db.pool.begin().await?;
    sqlx::query("DELETE FROM video_silences WHERE video_id=?")
        .bind(video_id)
        .execute(&mut *tx)
        .await?;
    for (start, end) in ranges {
        sqlx::query("INSERT INTO video_silences(video_id,start_ms,end_ms) VALUES (?,?,?)")
            .bind(video_id)
            .bind(start)
            .bind(end)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query(
        "INSERT INTO video_silence_scans(video_id,scanned_at) VALUES (?,?)
         ON CONFLICT(video_id) DO UPDATE SET scanned_at=excluded.scanned_at",
    )
    .bind(video_id)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// 播放时该跳过的停顿区间。第一次问某个视频时扫一遍音轨（只解码音频，很快），
/// 之后直接读库。换页时刻会把静音段切开——老师沉默着写板书时画面在动，那截不能跳。
#[tauri::command]
pub async fn cmd_video_skips(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Vec<SkipRange>> {
    let video = load_video(&state, &video_id).await?;
    if !already_scanned(&state, &video_id).await? {
        let ranges = silence::detect_silences(
            Path::new(&video.file_path),
            video.duration_ms,
            silence::DEFAULT_NOISE_DB,
            silence::DEFAULT_MIN_SILENCE_MS,
        )
        .await?;
        store_silences(&state, &video_id, &ranges).await?;
    }
    let silences: Vec<silence::Silence> = sqlx::query_as(
        "SELECT start_ms,end_ms FROM video_silences WHERE video_id=? ORDER BY start_ms",
    )
    .bind(&video_id)
    .fetch_all(&state.db.pool)
    .await?;
    let page_starts: Vec<i64> =
        sqlx::query_scalar("SELECT start_ms FROM slides WHERE video_id=? ORDER BY start_ms")
            .bind(&video_id)
            .fetch_all(&state.db.pool)
            .await?;
    Ok(silence::plan_skips(
        &silences,
        &page_starts,
        SkipOptions::default(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::videos::add_local_video;
    use crate::db::Db;
    use tempfile::tempdir;

    #[tokio::test]
    async fn stored_silences_survive_a_rescan_and_mark_the_video_as_scanned() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        let state = AppState::new(db);
        let course = create_course(&state.db, "c".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let video_path = dir.path().join("v.mp4");
        std::fs::write(&video_path, b"x").unwrap();
        let video = add_local_video(&state.db, &course.id, video_path, None)
            .await
            .unwrap();

        assert!(!already_scanned(&state, &video.id).await.unwrap());
        // 一段静音都没有也要记成「扫过」，否则每次播放都白扫一遍音轨。
        store_silences(&state, &video.id, &[]).await.unwrap();
        assert!(already_scanned(&state, &video.id).await.unwrap());

        store_silences(&state, &video.id, &[(1_000, 5_000)])
            .await
            .unwrap();
        store_silences(&state, &video.id, &[(2_000, 6_000)])
            .await
            .unwrap();
        let rows: Vec<(i64, i64)> =
            sqlx::query_as("SELECT start_ms,end_ms FROM video_silences WHERE video_id=?")
                .bind(&video.id)
                .fetch_all(&state.db.pool)
                .await
                .unwrap();
        // 重扫是替换而不是追加，否则同一段停顿会越积越多。
        assert_eq!(rows, vec![(2_000, 6_000)]);
    }
}
