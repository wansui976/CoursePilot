use crate::commands::courses::AppState;
use crate::commands::videos::Video;
use crate::error::{AppError, AppResult};
use crate::pipeline::silence::{self, SkipOptions, SkipRange};
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tauri::State;

const MAX_CONCURRENT_SILENCE_SCANS: usize = 1;

struct ScanLock {
    gate: tokio::sync::Mutex<()>,
    /// 只在这一批仍持有 `Arc<ScanLock>` 的并发请求之间共享。全部请求结束后弱引用失效，
    /// 下一次用户主动重试会拿到新的锁，不会被旧错误永久挡住。
    failure: Mutex<Option<String>>,
}

impl ScanLock {
    fn new() -> Self {
        Self {
            gate: tokio::sync::Mutex::new(()),
            failure: Mutex::new(None),
        }
    }

    fn failure(&self) -> Option<String> {
        self.failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn remember_failure(&self, error: &AppError) {
        *self
            .failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error.to_string());
    }
}

/// 同一视频的首次静音扫描只允许跑一份。前端 StrictMode 重挂载或多个播放器同时请求时，
/// 后到的请求等待首个请求落库，再复用结果，避免重复启动 ffmpeg 抢 CPU / 磁盘。
static SILENCE_SCAN_LOCKS: OnceLock<Mutex<HashMap<String, Weak<ScanLock>>>> = OnceLock::new();
/// 即使请求的是不同视频，也只让一份 ffmpeg 静音扫描运行。用户快速切课时，旧 IPC 不会
/// 随 React Query 卸载而取消；全局限流避免多个解码进程与正在播放的视频争 CPU / 磁盘。
static SILENCE_SCAN_SLOTS: OnceLock<tokio::sync::Semaphore> = OnceLock::new();

fn scan_slots() -> &'static tokio::sync::Semaphore {
    SILENCE_SCAN_SLOTS.get_or_init(|| tokio::sync::Semaphore::new(MAX_CONCURRENT_SILENCE_SCANS))
}

fn scan_lock(video_id: &str) -> Arc<ScanLock> {
    let locks = SILENCE_SCAN_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(video_id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(ScanLock::new());
    locks.insert(video_id.to_string(), Arc::downgrade(&lock));
    lock
}

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

/// 只有课件分析确实完成后，空的 `slides` 才能解释为“没有检测到课件页”。
/// 自动流水线以 slides job=done 为完成证据；手动提取不写 job，因此已有页也算完成。
async fn slide_analysis_complete(state: &AppState, video_id: &str) -> AppResult<bool> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT
           EXISTS(SELECT 1 FROM slides WHERE video_id=?)
           OR EXISTS(
             SELECT 1 FROM processing_jobs
             WHERE video_id=? AND stage='slides' AND status='done'
           )",
    )
    .bind(video_id)
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

async fn ensure_silences_scanned_with<F, Fut>(
    state: &AppState,
    video_id: &str,
    detect: F,
) -> AppResult<()>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = AppResult<Vec<silence::Silence>>>,
{
    // Register this caller before the first await so requests polled in the same
    // batch cannot race through the database check and create separate locks.
    let lock = scan_lock(video_id);
    if already_scanned(state, video_id).await? {
        return Ok(());
    }

    let _guard = lock.gate.lock().await;
    // 另一个请求可能在等待期间已经完成并落库，锁内必须再查一次。
    if already_scanned(state, video_id).await? {
        return Ok(());
    }

    // 首个请求失败时，已经排队的请求共享同一个错误，不能接力重复跑 ffmpeg。
    // `ScanLock` 只由当前批次强持有；批次结束后下一次调用会创建新锁并正常重试。
    if let Some(error) = lock.failure() {
        return Err(AppError::Other(error));
    }

    let result = async {
        let _slot = scan_slots()
            .acquire()
            .await
            .expect("silence scan semaphore is never closed");
        let ranges = detect().await?;
        store_silences(state, video_id, &ranges).await
    }
    .await;
    if let Err(error) = &result {
        lock.remember_failure(error);
    }
    result
}

async fn planned_skips(state: &AppState, video_id: &str) -> AppResult<Vec<SkipRange>> {
    let silences: Vec<silence::Silence> = sqlx::query_as(
        "SELECT start_ms,end_ms FROM video_silences WHERE video_id=? ORDER BY start_ms",
    )
    .bind(video_id)
    .fetch_all(&state.db.pool)
    .await?;
    // 不缓存最终计划：课件重新提取后，下一次请求必须立刻使用最新换页时刻。
    let page_starts: Vec<i64> =
        sqlx::query_scalar("SELECT start_ms FROM slides WHERE video_id=? ORDER BY start_ms")
            .bind(video_id)
            .fetch_all(&state.db.pool)
            .await?;
    Ok(silence::plan_skips(
        &silences,
        &page_starts,
        SkipOptions::default(),
    ))
}

/// 播放时该跳过的停顿区间。第一次问某个视频时扫一遍音轨（只解码音频，很快），
/// 之后直接读库。换页时刻会把静音段切开——老师沉默着写板书时画面在动，那截不能跳。
#[tauri::command]
pub async fn cmd_video_skips(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Vec<SkipRange>> {
    let video = load_video(&state, &video_id).await?;
    // slides 为空既可能是“视频没有课件”，也可能只是提取尚未开始/仍在运行。
    // 没有完成证据时宁可暂不跳，也不能把整段静音误判为静止画面。
    if !slide_analysis_complete(&state, &video_id).await? {
        return Ok(Vec::new());
    }

    ensure_silences_scanned_with(&state, &video_id, || async {
        silence::detect_silences(
            Path::new(&video.file_path),
            video.duration_ms,
            silence::DEFAULT_NOISE_DB,
            silence::DEFAULT_MIN_SILENCE_MS,
        )
        .await
    })
    .await?;
    planned_skips(&state, &video_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::videos::add_local_video;
    use crate::db::Db;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::tempdir;

    async fn test_state_and_video() -> (tempfile::TempDir, AppState, Video) {
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
        (dir, state, video)
    }

    #[tokio::test]
    async fn stored_silences_survive_a_rescan_and_mark_the_video_as_scanned() {
        let (_dir, state, video) = test_state_and_video().await;

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

    #[tokio::test]
    async fn empty_slides_need_a_completed_analysis_before_they_are_trusted() {
        let (_dir, state, video) = test_state_and_video().await;
        assert!(!slide_analysis_complete(&state, &video.id).await.unwrap());

        crate::jobs::ensure_jobs(&state.db, &video.id)
            .await
            .unwrap();
        sqlx::query("UPDATE processing_jobs SET status='done' WHERE video_id=? AND stage='slides'")
            .bind(&video.id)
            .execute(&state.db.pool)
            .await
            .unwrap();

        // 提取完成但确实没有页时，done 终态让“空结果”不再与“尚未分析”混淆。
        assert!(slide_analysis_complete(&state, &video.id).await.unwrap());
    }

    #[tokio::test]
    async fn an_existing_manual_slide_is_also_completion_evidence() {
        let (_dir, state, video) = test_state_and_video().await;
        sqlx::query(
            "INSERT INTO slides(video_id,image_path,start_ms,end_ms,page_no) VALUES (?,?,?,?,?)",
        )
        .bind(&video.id)
        .bind("slide.jpg")
        .bind(0_i64)
        .bind(None::<i64>)
        .bind(0_i64)
        .execute(&state.db.pool)
        .await
        .unwrap();

        assert!(slide_analysis_complete(&state, &video.id).await.unwrap());
    }

    #[tokio::test]
    async fn concurrent_first_requests_share_one_scan() {
        let (_dir, state, video) = test_state_and_video().await;
        let calls = Arc::new(AtomicUsize::new(0));
        let first_calls = calls.clone();
        let second_calls = calls.clone();

        let first = ensure_silences_scanned_with(&state, &video.id, || async move {
            first_calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            Ok(vec![(1_000, 5_000)])
        });
        let second = ensure_silences_scanned_with(&state, &video.id, || async move {
            second_calls.fetch_add(1, Ordering::SeqCst);
            Ok(vec![(2_000, 6_000)])
        });
        let (first_result, second_result) = tokio::join!(first, second);

        first_result.unwrap();
        second_result.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let rows: Vec<silence::Silence> = sqlx::query_as(
            "SELECT start_ms,end_ms FROM video_silences WHERE video_id=? ORDER BY start_ms",
        )
        .bind(&video.id)
        .fetch_all(&state.db.pool)
        .await
        .unwrap();
        assert_eq!(rows, vec![(1_000, 5_000)]);
    }

    #[tokio::test]
    async fn scans_for_different_videos_respect_the_process_wide_limit() {
        let (dir, state, first_video) = test_state_and_video().await;
        let second_path = dir.path().join("v2.mp4");
        std::fs::write(&second_path, b"x").unwrap();
        let second_video = add_local_video(&state.db, &first_video.course_id, second_path, None)
            .await
            .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let running = Arc::new(AtomicUsize::new(0));
        let max_running = Arc::new(AtomicUsize::new(0));

        let first_calls = calls.clone();
        let first_running = running.clone();
        let first_max = max_running.clone();
        let first = ensure_silences_scanned_with(&state, &first_video.id, || async move {
            first_calls.fetch_add(1, Ordering::SeqCst);
            let active = first_running.fetch_add(1, Ordering::SeqCst) + 1;
            first_max.fetch_max(active, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            first_running.fetch_sub(1, Ordering::SeqCst);
            Ok(vec![(1_000, 5_000)])
        });

        let second_calls = calls.clone();
        let second_running = running.clone();
        let second_max = max_running.clone();
        let second = ensure_silences_scanned_with(&state, &second_video.id, || async move {
            second_calls.fetch_add(1, Ordering::SeqCst);
            let active = second_running.fetch_add(1, Ordering::SeqCst) + 1;
            second_max.fetch_max(active, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            second_running.fetch_sub(1, Ordering::SeqCst);
            Ok(vec![(2_000, 6_000)])
        });

        let (first_result, second_result) = tokio::join!(first, second);
        first_result.unwrap();
        second_result.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(max_running.load(Ordering::SeqCst), 1);
        assert_eq!(running.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn concurrent_failures_are_shared_but_a_later_call_can_retry() {
        let (_dir, state, video) = test_state_and_video().await;
        let calls = Arc::new(AtomicUsize::new(0));
        let first_calls = calls.clone();
        let second_calls = calls.clone();

        let first = ensure_silences_scanned_with(&state, &video.id, || async move {
            first_calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            AppResult::<Vec<silence::Silence>>::Err(AppError::Pipeline("scan failed".into()))
        });
        let second = ensure_silences_scanned_with(&state, &video.id, || async move {
            second_calls.fetch_add(1, Ordering::SeqCst);
            AppResult::<Vec<silence::Silence>>::Err(AppError::Pipeline("duplicate scan ran".into()))
        });
        let (first_result, second_result) = tokio::join!(first, second);

        let first_error = first_result.unwrap_err().to_string();
        let second_error = second_result.unwrap_err().to_string();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(second_error, first_error);

        // 当前并发批次的 Arc 都释放后，新调用拿到新锁，可由用户立即主动重试。
        let retry_calls = calls.clone();
        ensure_silences_scanned_with(&state, &video.id, || async move {
            retry_calls.fetch_add(1, Ordering::SeqCst);
            Ok(vec![(3_000, 7_000)])
        })
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(already_scanned(&state, &video.id).await.unwrap());
    }

    #[tokio::test]
    async fn updated_slides_replan_the_cached_silences() {
        let (_dir, state, video) = test_state_and_video().await;
        store_silences(&state, &video.id, &[(10_000, 30_000)])
            .await
            .unwrap();
        let initial = planned_skips(&state, &video.id).await.unwrap();
        assert_eq!(
            initial,
            vec![SkipRange {
                start_ms: 10_400,
                end_ms: 29_750,
            }]
        );

        sqlx::query(
            "INSERT INTO slides(video_id,image_path,start_ms,end_ms,page_no) VALUES (?,?,?,?,?)",
        )
        .bind(&video.id)
        .bind("slide.jpg")
        .bind(14_000_i64)
        .bind(None::<i64>)
        .bind(0_i64)
        .execute(&state.db.pool)
        .await
        .unwrap();

        assert_eq!(
            planned_skips(&state, &video.id).await.unwrap(),
            vec![SkipRange {
                start_ms: 14_400,
                end_ms: 29_750,
            }]
        );
    }
}
