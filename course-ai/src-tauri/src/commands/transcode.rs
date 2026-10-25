//! 移动端把「WebView 解不了编码」的视频就地转成 H.264。
//!
//! 为什么要有这个：dav1d 实测在 A12X 上解 1080p 能到 200 fps，而 AVFoundation 在
//! M4 / A17 Pro 之前的机型根本没有 AV1 解码器 —— WKWebView 拿到 av01 就是一块黑屏，
//! 字幕和 AI 总结却照常（它们只走音轨）。转一遍换成 H.264，播放器就不用改。
//!
//! 只在 iOS 生效：Android 的 WebView 是 Chromium，自带 AV1 软解，不需要。

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize)]
pub struct TranscodeStatus {
    /// idle / running / done / failed
    pub state: String,
    /// 0–100，running 时是当前进度
    pub percent: u32,
}

impl TranscodeStatus {
    fn idle() -> Self {
        Self {
            state: "idle".into(),
            percent: 0,
        }
    }
}

/// 转码任务表：video_id → 进度。进程内单例，跟着 AppState 走。
#[derive(Default)]
pub struct TranscodeJobs {
    inner: Mutex<HashMap<String, Arc<AtomicU32>>>,
    failed: Mutex<HashMap<String, String>>,
    /// 同时只转一条：多条一起转会各自解 1080p 再编码，A12X 上直接把内存和队列打满。
    gate: std::sync::Arc<std::sync::Mutex<()>>,
}

impl TranscodeJobs {
    fn gate(&self) -> std::sync::Arc<std::sync::Mutex<()>> {
        self.gate.clone()
    }
}

impl TranscodeJobs {
    pub fn status(&self, video_id: &str) -> TranscodeStatus {
        if self.failed.lock().unwrap().contains_key(video_id) {
            return TranscodeStatus {
                state: "failed".into(),
                percent: 0,
            };
        }
        match self.inner.lock().unwrap().get(video_id) {
            Some(progress) => {
                let percent = progress.load(Ordering::Relaxed);
                TranscodeStatus {
                    state: if percent >= 100 { "done".into() } else { "running".into() },
                    percent,
                }
            }
            None => TranscodeStatus::idle(),
        }
    }

    fn begin(&self, video_id: &str) -> Arc<AtomicU32> {
        let progress = Arc::new(AtomicU32::new(1));
        self.failed.lock().unwrap().remove(video_id);
        self.inner
            .lock()
            .unwrap()
            .insert(video_id.to_string(), progress.clone());
        progress
    }

    fn finish(&self, video_id: &str, progress: Arc<AtomicU32>, error: Option<String>) {
        match error {
            Some(message) => {
                progress.store(0, Ordering::Relaxed);
                self.inner.lock().unwrap().remove(video_id);
                self.failed
                    .lock()
                    .unwrap()
                    .insert(video_id.to_string(), message);
            }
            None => progress.store(100, Ordering::Relaxed),
        }
    }

    pub fn is_running(&self, video_id: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .get(video_id)
            .map(|progress| progress.load(Ordering::Relaxed) < 100)
            .unwrap_or(false)
    }
}

#[cfg(target_os = "ios")]
mod ffi {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int};
    use std::sync::OnceLock;

    /// 转码实现在 App target 的 Swift 里（TranscodeVideo.swift 用 @_cdecl 导出）。
    ///
    /// 不能直接 `extern "C"` 声明：Rust 这边编的是 cdylib/staticlib，链接发生在
    /// Swift 目标文件之前，声明了就是 undefined symbol。dlsym 在**运行时**从主程序里
    /// 找符号，正好绕开这个顺序问题。
    type TranscodeFn = unsafe extern "C" fn(*const c_char, *const c_char) -> c_int;
    type ProgressFn = unsafe extern "C" fn() -> c_int;

    fn lookup<T: Copy>(name: &[u8]) -> Option<T> {
        unsafe {
            let symbol = libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr() as *const c_char);
            if symbol.is_null() {
                None
            } else {
                Some(std::mem::transmute_copy(&symbol))
            }
        }
    }

    fn transcode_fn() -> Option<TranscodeFn> {
        static FN: OnceLock<Option<TranscodeFn>> = OnceLock::new();
        *FN.get_or_init(|| lookup(b"courseai_transcode_video\0"))
    }

    fn progress_fn() -> Option<ProgressFn> {
        static FN: OnceLock<Option<ProgressFn>> = OnceLock::new();
        *FN.get_or_init(|| lookup(b"courseai_transcode_progress\0"))
    }

    pub fn run(source: &str, destination: &str) -> Result<(), String> {
        let Some(run) = transcode_fn() else {
            return Err("这个版本没有编入端上转码".into());
        };
        let source = CString::new(source).map_err(|_| "source path has NUL".to_string())?;
        let destination =
            CString::new(destination).map_err(|_| "destination path has NUL".to_string())?;
        let code = unsafe { run(source.as_ptr(), destination.as_ptr()) };
        if code == 0 {
            Ok(())
        } else {
            Err(format!("转码失败：{code}"))
        }
    }

    pub fn progress() -> u32 {
        match progress_fn() {
            Some(progress) => unsafe { progress().clamp(0, 100) as u32 },
            None => 0,
        }
    }
}

/// 启动一次后台转码。幂等：已经在转或已经转好就直接返回。
pub fn spawn_transcode(
    jobs: Arc<TranscodeJobs>,
    video_id: String,
    source: String,
    destination: String,
) {
    if jobs.is_running(&video_id) {
        return;
    }
    let progress = jobs.begin(&video_id);
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (&source, &destination);
        jobs.finish(&video_id, progress, Some("仅 iOS 支持端上转码".into()));
        return;
    }

    // 转码本身是同步的（AVAssetWriter 有它自己的线程），塞进阻塞线程池；
    // 进度另起一个轮询任务，每 500ms 抄一遍 Swift 侧的值。
    let gate = jobs.gate();
    tauri::async_runtime::spawn_blocking({
        let jobs = jobs.clone();
        let video_id = video_id.clone();
        let progress = progress.clone();
        move || {
            // 排队：拿到锁才开始转，避免几条视频同时解码。
            let _permit = gate.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            #[cfg(target_os = "ios")]
            let outcome = ffi::run(&source, &destination).map(|()| {
                // 旧封面是从解不了的原件抽出来的（黑图）。转好了就删掉，让下一次
                // 封面请求从 playable.mp4 重新抽一帧。
                if let Some(parent) = std::path::Path::new(&destination).parent() {
                    let _ = std::fs::remove_file(parent.join("cover.jpg"));
                }
            });
            #[cfg(not(target_os = "ios"))]
            let outcome: Result<(), String> = Err("仅 iOS 支持端上转码".into());
            jobs.finish(&video_id, progress, outcome.err());
        }
    });

    #[cfg(target_os = "ios")]
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let percent = ffi::progress();
            if percent >= 100 || !jobs.is_running(&video_id) {
                break;
            }
            if let Some(slot) = jobs.inner.lock().unwrap().get(&video_id) {
                slot.store(percent.max(1), Ordering::Relaxed);
            }
        }
    });
}

/// 判断这条视频需不需要转，并给出转码产物的落点（`data_dir/playable.mp4`，
/// 与桌面端 `cached_playable` 同一约定）。
pub fn plan(path: &std::path::Path, data_dir: &str) -> Option<std::path::PathBuf> {
    let codec = crate::pipeline::playable::video_codec(path)?;
    if crate::pipeline::playable::codec_playable_here(codec) {
        return None;
    }
    Some(std::path::Path::new(data_dir).join("playable.mp4"))
}

pub fn ensure_transcode(
    jobs: Arc<TranscodeJobs>,
    video_id: &str,
    file_path: &str,
    data_dir: &str,
) -> AppResult<()> {
    let target = match plan(std::path::Path::new(file_path), data_dir) {
        Some(target) => target,
        None => return Ok(()),
    };
    if jobs.is_running(video_id) {
        return Ok(());
    }
    if target.is_file() {
        // 缓存可能是崩溃/中断留下的半成品（甚至是 0 字节）。只有读到可播放的编码才算数，
        // 否则删掉重转 —— 不然用户会一直黑屏，而且没有任何提示。
        let usable = std::fs::metadata(&target)
            .map(|meta| meta.len() > 0)
            .unwrap_or(false)
            && crate::pipeline::playable::video_codec(&target)
                .map(crate::pipeline::playable::codec_playable_here)
                .unwrap_or(false);
        if usable {
            return Ok(());
        }
        let _ = std::fs::remove_file(&target);
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| AppError::Config(format!("转码目录创建失败：{error}")))?;
    }
    spawn_transcode(
        jobs,
        video_id.to_string(),
        file_path.to_string(),
        target.to_string_lossy().to_string(),
    );
    Ok(())
}

#[tauri::command]
pub fn cmd_transcode_status(
    jobs: tauri::State<'_, Arc<TranscodeJobs>>,
    video_id: String,
) -> TranscodeStatus {
    jobs.status(&video_id)
}

/// 手动触发一次转码（目前由 cmd_media_url 自动触发，命令留给「重试」按钮）。
#[tauri::command]
pub async fn cmd_start_transcode(
    state: tauri::State<'_, crate::commands::courses::AppState>,
    jobs: tauri::State<'_, Arc<TranscodeJobs>>,
    video_id: String,
) -> AppResult<TranscodeStatus> {
    let (file_path, data_dir) =
        crate::commands::videos::live_video_paths(&state.db, &video_id).await?;
    ensure_transcode(jobs.inner().clone(), &video_id, &file_path, &data_dir)?;
    Ok(jobs.status(&video_id))
}

/// 调试钩子：`Documents/transcode-now.txt` 里写一个 video_id，App 启动后就转它。
/// 只用于真机验证这条链路，删掉文件即失效。
#[cfg(target_os = "ios")]
pub async fn run_debug_trigger(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Ok(documents) = app.path().document_dir() else {
        return;
    };
    let marker = documents.join("transcode-now.txt");
    let Ok(raw) = std::fs::read_to_string(&marker) else {
        return;
    };
    let video_id = raw.trim().to_string();
    if video_id.is_empty() {
        return;
    }
    let state = app.state::<crate::commands::courses::AppState>();
    let Ok((file_path, data_dir)) =
        crate::commands::videos::live_video_paths(&state.db, &video_id).await
    else {
        return;
    };
    if let Some(jobs) = app.try_state::<std::sync::Arc<TranscodeJobs>>() {
        let _ = ensure_transcode(jobs.inner().clone(), &video_id, &file_path, &data_dir);
    }
}
