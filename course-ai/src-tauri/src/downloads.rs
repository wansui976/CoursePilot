//! 后台下载队列：用户关掉导入弹窗、切换页面后下载继续跑。
//!
//! 单次 `cmd_import_bilibili` 是「前台下载」——进度只发到某个 request_id、结果由弹窗
//! 等待。这里把下载改成后端持有的任务：入队立刻返回快照，进度推全局事件
//! `download:update`，队列页与课程列表据此显示。任务只活在本进程里：退出应用即中断
//! （暂存目录会在下次入队时留给用户手动清理，不做跨重启续传）。

use crate::commands::courses::AppState;
use crate::error::AppResult;
use crate::pipeline::download::DownloadEvent;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Semaphore;
use uuid::Uuid;

/// 同时下几个。B 站单条链路不稳，2 个是速度与稳定性的折中。
const MAX_CONCURRENT: usize = 2;
/// 一批下完后同时跑几条处理流水线。每条都要抽音频、语音识别、调大模型，
/// 一口气全起会把机器和模型接口的限流一起打满。
const BATCH_PROCESS_CONCURRENCY: usize = 2;
/// 等前面的流水线跑完时多久看一次。
const BATCH_PROCESS_POLL: std::time::Duration = std::time::Duration::from_secs(2);
pub const EVENT_UPDATE: &str = "download:update";
pub const EVENT_BATCH_DONE: &str = "download:batch-done";
/// 批量下完后排着的视频轮到、起了流水线：前端据此刷新处理队列（这时 batch-done 早就发过了）。
pub const EVENT_PROCESSING_STARTED: &str = "download:processing-started";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub id: String,
    pub batch_id: String,
    pub course_id: String,
    pub url: String,
    pub title: String,
    /// queued | downloading | merging | importing | done | failed | canceled
    ///
    /// importing：文件已下完，正在挪进课程目录、写库。这一段不能取消。
    pub status: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    /// 字节/秒
    pub speed: Option<f64>,
    /// 剩余秒数
    pub eta: Option<u64>,
    /// 视频流中途断开、正在降到这一档清晰度重下；正常进度时为空。
    /// 只给数字，提示文案由前端按界面语言写。
    pub retry_height: Option<u32>,
    pub error: Option<String>,
    pub video_id: Option<String>,
    /// 第几次尝试；断流降档重下时 +1，前端据此重置进度条。
    pub attempt: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub url: String,
    #[serde(default)]
    pub title: String,
    pub max_height: Option<u32>,
    pub sub_lang: Option<String>,
    pub subtitle_autocorrect: Option<bool>,
    /// 这一集下完后是否自动跑流水线（批量导入为 true）。
    #[serde(default)]
    pub auto_process: bool,
}

#[derive(Clone)]
struct JobSpec {
    staging: PathBuf,
    max_height: Option<u32>,
    sub_lang: Option<String>,
    subtitle_autocorrect: Option<bool>,
    auto_process: bool,
}

#[derive(Default)]
struct Inner {
    jobs: HashMap<String, DownloadJob>,
    specs: HashMap<String, JobSpec>,
    /// 展示顺序（先入队的在前）。
    order: Vec<String>,
    tasks: HashMap<String, tauri::async_runtime::JoinHandle<()>>,
    batches: HashMap<String, Vec<String>>,
}

pub struct DownloadQueue {
    inner: Mutex<Inner>,
    semaphore: Arc<Semaphore>,
    /// 「全部取消」的代次：每按一次 +1。下完后排着等处理的视频据此知道用户已经
    /// 不想要了，不再起流水线。
    cancel_epoch: AtomicU64,
}

impl Default for DownloadQueue {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT)),
            cancel_epoch: AtomicU64::new(0),
        }
    }
}

fn is_terminal(status: &str) -> bool {
    matches!(status, "done" | "failed" | "canceled")
}

fn is_mobile_os() -> bool {
    matches!(std::env::consts::OS, "android" | "ios")
}

fn emit_job(app: &AppHandle, job: &DownloadJob) {
    let _ = app.emit(EVENT_UPDATE, job);
}

impl DownloadQueue {
    /// 当前队列快照。已完成的从界面上立刻消失（视频行马上由真实视频接管），
    /// 已取消的也不再展示；失败的留着让用户看到原因。
    fn snapshot(&self) -> Vec<DownloadJob> {
        let inner = self.inner.lock().unwrap();
        inner
            .order
            .iter()
            .filter_map(|id| inner.jobs.get(id))
            .filter(|job| job.status != "done" && job.status != "canceled")
            .cloned()
            .collect()
    }

    /// 把 yt-dlp 的事件折进任务。返回更新后的快照，供调用方推给前端。
    fn apply_event(&self, id: &str, event: DownloadEvent) -> Option<DownloadJob> {
        let mut inner = self.inner.lock().unwrap();
        let job = inner.jobs.get_mut(id)?;
        // 取消后子进程被杀前可能还吐出几行进度，别把任务改回「下载中」。
        if job.status == "canceled" {
            return None;
        }
        match event {
            DownloadEvent::Progress {
                downloaded,
                total,
                speed,
                eta,
            } => {
                job.status = "downloading".into();
                job.downloaded = downloaded;
                job.total = total;
                job.speed = speed;
                job.eta = eta;
                job.retry_height = None;
            }
            DownloadEvent::Merging => {
                job.status = "merging".into();
                job.downloaded = job.total.unwrap_or(job.downloaded);
                job.speed = None;
                job.eta = None;
                job.retry_height = None;
            }
            DownloadEvent::Retrying { max_height } => {
                // 这是一次全新的尝试（换低一档清晰度重下），进度归零。
                job.attempt += 1;
                job.status = "downloading".into();
                job.downloaded = 0;
                job.total = None;
                job.speed = None;
                job.eta = None;
                job.retry_height = Some(max_height);
            }
        }
        Some(job.clone())
    }

    /// 下完、入库之前：任务没被取消就转入 importing 并返回 true，此后取消是空操作；
    /// 已被取消则返回 false，下载方据此放弃入库。和取消在同一把锁下判定，两边不会
    /// 各自以为自己赢了。
    fn begin_import(&self, id: &str) -> Option<DownloadJob> {
        let mut inner = self.inner.lock().unwrap();
        let job = inner.jobs.get_mut(id)?;
        if job.status == "canceled" {
            return None;
        }
        job.status = "importing".into();
        job.downloaded = job.total.unwrap_or(job.downloaded);
        job.speed = None;
        job.eta = None;
        job.retry_height = None;
        Some(job.clone())
    }

    /// 把一个任务标成已取消，交回它的后台任务句柄与暂存目录供调用方收拾。
    /// 已结束的、以及正在入库的（中途中止会留下只登记了一半的视频）返回 None。
    #[allow(clippy::type_complexity)]
    fn mark_canceled(
        &self,
        id: &str,
    ) -> Option<(
        DownloadJob,
        Option<tauri::async_runtime::JoinHandle<()>>,
        Option<PathBuf>,
    )> {
        let mut inner = self.inner.lock().unwrap();
        let job = inner.jobs.get_mut(id)?;
        if is_terminal(&job.status) || job.status == "importing" {
            return None;
        }
        job.status = "canceled".into();
        job.retry_height = None;
        job.speed = None;
        job.eta = None;
        let snapshot = job.clone();
        let handle = inner.tasks.remove(id);
        let staging = inner.specs.get(id).map(|spec| spec.staging.clone());
        Some((snapshot, handle, staging))
    }

    fn set_status(
        &self,
        id: &str,
        status: &str,
        error: Option<String>,
        video_id: Option<String>,
    ) -> Option<DownloadJob> {
        let mut inner = self.inner.lock().unwrap();
        let job = inner.jobs.get_mut(id)?;
        // 已取消的任务不能被事后的「完成 / 失败」改回来（取消与任务收尾可能同时发生）。
        if job.status == "canceled" {
            return None;
        }
        job.status = status.into();
        if status == "done" {
            job.downloaded = job.total.unwrap_or(job.downloaded);
            job.speed = None;
            job.eta = None;
            job.retry_height = None;
        }
        job.error = error;
        job.video_id = video_id;
        Some(job.clone())
    }
}

fn cleanup_staging(staging: PathBuf) {
    tauri::async_runtime::spawn(async move {
        // abort 之后子进程才被 kill；留一点时间让 yt-dlp 把手上的句柄放掉。
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        for _ in 0..5 {
            if std::fs::remove_dir_all(&staging).is_ok() || !staging.exists() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    });
}

async fn run_job(app: AppHandle, job_id: String) {
    // 排队等待配额：状态保持 queued，用户在队列页能看到「排队中」。
    let semaphore = app.state::<DownloadQueue>().semaphore.clone();
    let Ok(_permit) = semaphore.acquire().await else {
        return;
    };
    let (job, spec) = {
        let queue = app.state::<DownloadQueue>();
        let inner = queue.inner.lock().unwrap();
        (
            inner.jobs.get(&job_id).cloned(),
            inner.specs.get(&job_id).cloned(),
        )
    };
    // 排队期间被取消/移除。
    let (Some(job), Some(spec)) = (job, spec) else {
        return;
    };
    if job.status != "queued" {
        return;
    }

    if let Some(updated) =
        app.state::<DownloadQueue>()
            .set_status(&job_id, "downloading", None, None)
    {
        emit_job(&app, &updated);
    }

    let state = app.state::<AppState>();
    let progress_app = app.clone();
    let progress_id = job_id.clone();
    let on_event = move |event: DownloadEvent| {
        let queue = progress_app.state::<DownloadQueue>();
        if let Some(updated) = queue.apply_event(&progress_id, event) {
            emit_job(&progress_app, &updated);
        }
    };
    let import_app = app.clone();
    let import_id = job_id.clone();
    let begin_import = move || match import_app.state::<DownloadQueue>().begin_import(&import_id) {
        Some(updated) => {
            emit_job(&import_app, &updated);
            true
        }
        None => false,
    };
    let result = crate::commands::tools::import_url_with(
        app.clone(),
        &state,
        job.course_id.clone(),
        job.url.clone(),
        spec.max_height,
        spec.sub_lang.clone(),
        spec.subtitle_autocorrect,
        Some(spec.staging.clone()),
        &on_event,
        &begin_import,
    )
    .await;

    let batch_id = job.batch_id.clone();
    match result {
        Ok(video) => {
            if let Some(updated) =
                app.state::<DownloadQueue>()
                    .set_status(&job_id, "done", None, Some(video.id))
            {
                emit_job(&app, &updated);
            }
        }
        Err(error) => {
            let message = error.to_string();
            if let Some(updated) =
                app.state::<DownloadQueue>()
                    .set_status(&job_id, "failed", Some(message), None)
            {
                emit_job(&app, &updated);
            }
        }
    }
    app.state::<DownloadQueue>()
        .inner
        .lock()
        .unwrap()
        .tasks
        .remove(&job_id);
    finish_batch(&app, &batch_id).await;
}

/// 一批全部结束（成功/失败/取消都算）后：
/// 1) 把完成的从队列里移除（视频已经入库）；
/// 2) 给需要自动处理的视频起流水线；
/// 3) 通知前端刷新视频列表与处理队列。
async fn finish_batch(app: &AppHandle, batch_id: &str) {
    let (course_id, videos) = {
        let queue = app.state::<DownloadQueue>();
        let mut inner = queue.inner.lock().unwrap();
        let Some(members) = inner.batches.get(batch_id).cloned() else {
            return;
        };
        let settled = members.iter().all(|id| {
            inner
                .jobs
                .get(id)
                .map(|job| is_terminal(&job.status))
                .unwrap_or(true)
        });
        if !settled {
            return;
        }
        let videos: Vec<String> = members
            .iter()
            .filter_map(|id| inner.jobs.get(id))
            .filter(|job| job.status == "done")
            .filter(|job| {
                inner
                    .specs
                    .get(&job.id)
                    .map(|spec| spec.auto_process)
                    .unwrap_or(false)
            })
            .filter_map(|job| job.video_id.clone())
            .collect();
        let course_id = members
            .iter()
            .find_map(|id| inner.jobs.get(id).map(|job| job.course_id.clone()));
        for id in &members {
            let removable = inner
                .jobs
                .get(id)
                .map(|job| job.status == "done" || job.status == "canceled")
                .unwrap_or(true);
            if removable {
                inner.jobs.remove(id);
                inner.specs.remove(id);
            }
        }
        let Inner {
            jobs,
            order,
            batches,
            ..
        } = &mut *inner;
        order.retain(|id| jobs.contains_key(id));
        batches.remove(batch_id);
        (course_id, videos)
    };

    // 全部下完再处理，但不一口气全起（见 spawn_batch_processing）。
    spawn_batch_processing(app.clone(), videos);
    if let Some(course_id) = course_id {
        let _ = app.emit(
            EVENT_BATCH_DONE,
            serde_json::json!({ "courseId": course_id }),
        );
    }
}

/// 依次给一批刚下完的视频起处理流水线，同时最多跑 BATCH_PROCESS_CONCURRENCY 条，
/// 跑完一条再起下一条。用户「全部取消」后不再起新的，并停掉这里起的、还在跑的。
fn spawn_batch_processing(app: AppHandle, videos: Vec<String>) {
    if videos.is_empty() {
        return;
    }
    let epoch = app
        .state::<DownloadQueue>()
        .cancel_epoch
        .load(Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let canceled = |app: &AppHandle| {
            app.state::<DownloadQueue>()
                .cancel_epoch
                .load(Ordering::SeqCst)
                != epoch
        };
        let mut running: Vec<String> = Vec::new();
        for video_id in videos {
            loop {
                if canceled(&app) {
                    for id in running {
                        let _ = crate::pipeline::cancel_processing(&app, &id).await;
                    }
                    return;
                }
                running.retain(|id| crate::pipeline::is_processing(&app, id));
                if running.len() < BATCH_PROCESS_CONCURRENCY {
                    break;
                }
                tokio::time::sleep(BATCH_PROCESS_POLL).await;
            }
            if !awaiting_processing(&app, &video_id).await {
                continue;
            }
            // 某个视频起流水线失败不该影响其他视频。
            match crate::pipeline::cmd_process_video(app.clone(), video_id.clone()).await {
                Ok(()) => {
                    let _ = app.emit(
                        EVENT_PROCESSING_STARTED,
                        serde_json::json!({ "videoId": video_id }),
                    );
                    running.push(video_id);
                }
                Err(error) => {
                    tracing::warn!("start processing downloaded video {video_id} failed: {error}")
                }
            }
        }
    });
}

/// 排着的视频轮到时是否还需要起流水线：等待期间用户可能已经手动点了「开始处理」
/// （再起一遍会把跑了一半的重来），或者把视频删了。
async fn awaiting_processing(app: &AppHandle, video_id: &str) -> bool {
    if crate::pipeline::is_processing(app, video_id) {
        return false;
    }
    let db = app.state::<AppState>().db.clone();
    let status: Option<String> =
        sqlx::query_scalar("SELECT processed_status FROM videos WHERE id=? AND deleted_at IS NULL")
            .bind(video_id)
            .fetch_optional(&db.pool)
            .await
            .ok()
            .flatten();
    status.as_deref() == Some("pending")
}

/// 入队一批下载，立刻返回任务快照；真正的下载在后台跑。
#[tauri::command]
pub async fn cmd_enqueue_downloads(
    app: AppHandle,
    state: State<'_, AppState>,
    course_id: String,
    items: Vec<DownloadRequest>,
) -> AppResult<Vec<DownloadJob>> {
    if items.is_empty() {
        return Ok(Vec::new());
    }
    if is_mobile_os() {
        return Err(crate::error::AppError::Config(
            "移动端暂不支持 B 站 / 网络视频下载，请先在桌面端导入后同步到移动端".into(),
        ));
    }
    let root_path: String =
        sqlx::query_scalar("SELECT root_path FROM courses WHERE id=? AND deleted_at IS NULL")
            .bind(&course_id)
            .fetch_optional(&state.db.pool)
            .await?
            .ok_or_else(|| crate::error::AppError::NotFound(format!("course {course_id}")))?;

    let batch_id = Uuid::new_v4().to_string();
    let queue = app.state::<DownloadQueue>();
    let mut created = Vec::new();
    {
        let mut inner = queue.inner.lock().unwrap();
        for item in items {
            let id = Uuid::new_v4().to_string();
            let staging = PathBuf::from(&root_path).join(".courseai-import").join(&id);
            let title = if item.title.trim().is_empty() {
                item.url.clone()
            } else {
                item.title.trim().to_string()
            };
            let job = DownloadJob {
                id: id.clone(),
                batch_id: batch_id.clone(),
                course_id: course_id.clone(),
                url: item.url,
                title,
                status: "queued".into(),
                downloaded: 0,
                total: None,
                speed: None,
                eta: None,
                retry_height: None,
                error: None,
                video_id: None,
                attempt: 1,
            };
            inner.jobs.insert(id.clone(), job.clone());
            inner.specs.insert(
                id.clone(),
                JobSpec {
                    staging,
                    max_height: item.max_height,
                    sub_lang: item.sub_lang,
                    subtitle_autocorrect: item.subtitle_autocorrect,
                    auto_process: item.auto_process,
                },
            );
            inner.order.push(id.clone());
            inner
                .batches
                .entry(batch_id.clone())
                .or_default()
                .push(id.clone());
            created.push(job);
        }
    }

    for job in &created {
        emit_job(&app, job);
    }
    for job in &created {
        let job_id = job.id.clone();
        let task_app = app.clone();
        let handle = tauri::async_runtime::spawn(async move {
            run_job(task_app, job_id).await;
        });
        let queue = app.state::<DownloadQueue>();
        let mut inner = queue.inner.lock().unwrap();
        // 任务可能已经瞬间结束并自行清掉了记录：别把过期的 handle 塞回去。
        let still_active = inner
            .jobs
            .get(&job.id)
            .map(|job| !is_terminal(&job.status))
            .unwrap_or(false);
        if still_active {
            inner.tasks.insert(job.id.clone(), handle);
        }
    }
    Ok(created)
}

/// 取消一个下载（排队中或下载中）。已结束的任务是空操作。
#[tauri::command]
pub async fn cmd_cancel_download(app: AppHandle, id: String) -> AppResult<()> {
    let Some((job, handle, staging)) = app.state::<DownloadQueue>().mark_canceled(&id) else {
        return Ok(());
    };
    emit_job(&app, &job);
    if let Some(handle) = handle {
        handle.abort();
    }
    if let Some(staging) = staging {
        cleanup_staging(staging);
    }
    finish_batch(&app, &job.batch_id).await;
    Ok(())
}

/// 全部取消：取消所有排队中 / 下载中的任务，并且不再给任何一批起处理流水线——
/// 包括已经下完、正排着等处理的视频。逐个调 `cmd_cancel_download` 做不到这一点：
/// 最后一个任务被取消时整批算「结束」，反而会把已下完的那些送去处理。
#[tauri::command]
pub async fn cmd_cancel_all_downloads(app: AppHandle) -> AppResult<()> {
    let queue = app.state::<DownloadQueue>();
    queue.cancel_epoch.fetch_add(1, Ordering::SeqCst);
    let ids: Vec<String> = {
        let mut inner = queue.inner.lock().unwrap();
        for spec in inner.specs.values_mut() {
            spec.auto_process = false;
        }
        inner.order.clone()
    };
    let mut batches: Vec<String> = Vec::new();
    for id in ids {
        let Some((job, handle, staging)) = queue.mark_canceled(&id) else {
            continue;
        };
        emit_job(&app, &job);
        if let Some(handle) = handle {
            handle.abort();
        }
        if let Some(staging) = staging {
            cleanup_staging(staging);
        }
        if !batches.contains(&job.batch_id) {
            batches.push(job.batch_id);
        }
    }
    for batch_id in batches {
        finish_batch(&app, &batch_id).await;
    }
    Ok(())
}

/// 从队列里移除一条已结束（失败）的记录。
#[tauri::command]
pub async fn cmd_remove_download(app: AppHandle, id: String) -> AppResult<()> {
    let queue = app.state::<DownloadQueue>();
    let mut inner = queue.inner.lock().unwrap();
    let terminal = inner
        .jobs
        .get(&id)
        .map(|job| is_terminal(&job.status))
        .unwrap_or(true);
    if !terminal {
        return Ok(());
    }
    inner.jobs.remove(&id);
    inner.specs.remove(&id);
    inner.tasks.remove(&id);
    inner.order.retain(|job_id| job_id != &id);
    for members in inner.batches.values_mut() {
        members.retain(|job_id| job_id != &id);
    }
    Ok(())
}

/// 当前下载队列（含排队、下载中、失败；不含已完成/已取消）。
#[tauri::command]
pub async fn cmd_list_downloads(app: AppHandle) -> AppResult<Vec<DownloadJob>> {
    Ok(app.state::<DownloadQueue>().snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_job(id: &str) -> DownloadJob {
        DownloadJob {
            id: id.into(),
            batch_id: "b1".into(),
            course_id: "c1".into(),
            url: "u".into(),
            title: "t".into(),
            status: "queued".into(),
            downloaded: 0,
            total: None,
            speed: None,
            eta: None,
            retry_height: None,
            error: None,
            video_id: None,
            attempt: 1,
        }
    }

    fn queue_with(job: DownloadJob) -> DownloadQueue {
        let queue = DownloadQueue::default();
        queue.inner.lock().unwrap().jobs.insert(job.id.clone(), job);
        queue
    }

    #[test]
    fn a_job_canceled_before_import_is_never_imported() {
        let queue = queue_with(sample_job("j1"));
        assert!(queue.mark_canceled("j1").is_some());
        // 下载方随后到达入库关口：必须放弃，不能把视频登记进库。
        assert!(queue.begin_import("j1").is_none());
        // 收尾时的「失败 / 完成」也不能把已取消改回去。
        assert!(queue
            .set_status("j1", "failed", Some("下载已取消".into()), None)
            .is_none());
        assert!(queue
            .set_status("j1", "done", None, Some("v1".into()))
            .is_none());
        assert_eq!(queue.inner.lock().unwrap().jobs["j1"].status, "canceled");
    }

    #[test]
    fn a_job_that_started_importing_can_no_longer_be_canceled() {
        let queue = queue_with(sample_job("j1"));
        let importing = queue.begin_import("j1").unwrap();
        assert_eq!(importing.status, "importing");
        assert!(queue.mark_canceled("j1").is_none());
        let done = queue
            .set_status("j1", "done", None, Some("v1".into()))
            .unwrap();
        assert_eq!(done.status, "done");
    }

    #[test]
    fn late_progress_does_not_revive_a_canceled_job() {
        let queue = queue_with(sample_job("j1"));
        queue.mark_canceled("j1");
        assert!(queue
            .apply_event(
                "j1",
                DownloadEvent::Progress {
                    downloaded: 1,
                    total: Some(2),
                    speed: None,
                    eta: None,
                },
            )
            .is_none());
    }

    #[test]
    fn progress_is_folded_into_the_job() {
        let queue = DownloadQueue::default();
        queue
            .inner
            .lock()
            .unwrap()
            .jobs
            .insert("j1".into(), sample_job("j1"));
        let updated = queue
            .apply_event(
                "j1",
                DownloadEvent::Progress {
                    downloaded: 25,
                    total: Some(100),
                    speed: Some(10.0),
                    eta: Some(7),
                },
            )
            .unwrap();
        assert_eq!(updated.status, "downloading");
        assert_eq!(updated.downloaded, 25);
        assert_eq!(updated.total, Some(100));
        assert_eq!(updated.speed, Some(10.0));
        assert_eq!(updated.eta, Some(7));
    }

    #[test]
    fn a_retry_restarts_the_attempt_and_clears_progress() {
        let queue = DownloadQueue::default();
        queue
            .inner
            .lock()
            .unwrap()
            .jobs
            .insert("j1".into(), sample_job("j1"));
        queue.apply_event(
            "j1",
            DownloadEvent::Progress {
                downloaded: 90,
                total: Some(100),
                speed: None,
                eta: None,
            },
        );
        let updated = queue
            .apply_event("j1", DownloadEvent::Retrying { max_height: 720 })
            .unwrap();
        assert_eq!(updated.attempt, 2);
        assert_eq!(updated.downloaded, 0);
        assert_eq!(updated.total, None);
        assert_eq!(updated.retry_height, Some(720));
    }

    #[test]
    fn merging_marks_the_job_and_finishes_the_progress() {
        let queue = DownloadQueue::default();
        queue
            .inner
            .lock()
            .unwrap()
            .jobs
            .insert("j1".into(), sample_job("j1"));
        queue.apply_event(
            "j1",
            DownloadEvent::Progress {
                downloaded: 100,
                total: Some(100),
                speed: Some(1.0),
                eta: Some(0),
            },
        );
        let updated = queue.apply_event("j1", DownloadEvent::Merging).unwrap();
        assert_eq!(updated.status, "merging");
        assert_eq!(updated.downloaded, 100);
        assert_eq!(updated.speed, None);
    }

    #[test]
    fn finished_and_canceled_jobs_disappear_from_the_snapshot() {
        let queue = DownloadQueue::default();
        {
            let mut inner = queue.inner.lock().unwrap();
            for (id, status) in [("a", "downloading"), ("b", "done"), ("c", "canceled")] {
                let mut job = sample_job(id);
                job.status = status.into();
                inner.jobs.insert(id.into(), job);
                inner.order.push(id.into());
            }
        }
        let ids: Vec<String> = queue.snapshot().into_iter().map(|job| job.id).collect();
        assert_eq!(ids, vec!["a"]);
    }
}
