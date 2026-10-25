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
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Semaphore;
use uuid::Uuid;

/// 同时下几个。B 站单条链路不稳，2 个是速度与稳定性的折中。
const MAX_CONCURRENT: usize = 2;
pub const EVENT_UPDATE: &str = "download:update";
pub const EVENT_BATCH_DONE: &str = "download:batch-done";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub id: String,
    pub batch_id: String,
    pub course_id: String,
    pub url: String,
    pub title: String,
    /// queued | downloading | merging | done | failed | canceled
    pub status: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    /// 字节/秒
    pub speed: Option<f64>,
    /// 剩余秒数
    pub eta: Option<u64>,
    /// 断流降档之类的临时提示；正常进度时为空。
    pub message: Option<String>,
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
}

impl Default for DownloadQueue {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT)),
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
                job.message = None;
            }
            DownloadEvent::Merging => {
                job.status = "merging".into();
                job.downloaded = job.total.unwrap_or(job.downloaded);
                job.speed = None;
                job.eta = None;
                job.message = None;
            }
            DownloadEvent::Retrying { max_height } => {
                // 这是一次全新的尝试（换低一档清晰度重下），进度归零。
                job.attempt += 1;
                job.status = "downloading".into();
                job.downloaded = 0;
                job.total = None;
                job.speed = None;
                job.eta = None;
                job.message = Some(format!("视频流中途断开，正在降到 {max_height}P 重新下载…"));
            }
        }
        Some(job.clone())
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
        job.status = status.into();
        if status == "done" {
            job.downloaded = job.total.unwrap_or(job.downloaded);
            job.speed = None;
            job.eta = None;
            job.message = None;
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

    // 全部下完再统一处理。某个视频起流水线失败不该影响其他视频。
    for video_id in videos {
        if let Err(error) = crate::pipeline::cmd_process_video(app.clone(), video_id.clone()).await
        {
            tracing::warn!("start processing downloaded video {video_id} failed: {error}");
        }
    }
    if let Some(course_id) = course_id {
        let _ = app.emit(
            EVENT_BATCH_DONE,
            serde_json::json!({ "courseId": course_id }),
        );
    }
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
                message: None,
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
    let queue = app.state::<DownloadQueue>();
    let (job, handle, staging) = {
        let mut inner = queue.inner.lock().unwrap();
        let Some(job) = inner.jobs.get_mut(&id) else {
            return Ok(());
        };
        if is_terminal(&job.status) {
            return Ok(());
        }
        job.status = "canceled".into();
        job.message = None;
        job.speed = None;
        job.eta = None;
        let snapshot = job.clone();
        let handle = inner.tasks.remove(&id);
        let staging = inner.specs.get(&id).map(|spec| spec.staging.clone());
        (snapshot, handle, staging)
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
            message: None,
            error: None,
            video_id: None,
            attempt: 1,
        }
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
        assert!(updated.message.unwrap().contains("720P"));
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
