//! 手机上跑长任务（处理视频、转码、下载视频、下载识别模型）时不让系统把 App 挂起。
//!
//! 任务开始时 [`hold`] 一下，拿到的守卫活到任务结束。只要还有守卫，原生层就：
//! - iOS：关掉自动锁屏，并向系统申请后台继续运行（iOS 26 起是 BGContinuedProcessingTask，
//!   锁屏和灵动岛上有进度；更早的系统只有切走后约 30 秒的宽限）；
//! - Android：起前台服务（通知栏里一条进度），并持有 CPU 唤醒锁，熄屏也接着跑。
//!
//! 最后一个守卫放掉后再等 [`GRACE`] 才通知原生层收工：批量处理是一条跑完、过一会儿
//! 再起下一条，中间这点空档里收掉的话，iOS 在后台申请不回来，Android 在后台也起不了
//! 前台服务。桌面端只记账，不调原生。

use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 最后一个任务结束后多久才真正收工。批量处理每 2 秒看一次要不要起下一条。
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
const GRACE: Duration = Duration::from_secs(8);
/// 两次进度更新之间至少隔这么久，原生层不用每个百分点都刷一遍通知。
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
const THROTTLE: Duration = Duration::from_millis(1000);

/// 进度更新最多这么频繁地往外发（任务开始、结束不受限）。
const REPORT_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Processing,
    Transcode,
    Download,
    ModelDownload,
}

impl Kind {
    fn verb(self) -> &'static str {
        match self {
            Kind::Processing => "正在处理",
            Kind::Transcode => "正在转码",
            Kind::Download => "正在下载",
            Kind::ModelDownload => "正在下载识别模型",
        }
    }
}

/// 交给原生层的状态。`progress` 在 0..=1 之间，不知道进度时是 -1。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Status {
    pub active: bool,
    pub title: String,
    pub detail: String,
    pub progress: f64,
}

impl Status {
    fn idle() -> Self {
        Status {
            active: false,
            title: String::new(),
            detail: String::new(),
            progress: -1.0,
        }
    }
}

struct Entry {
    kind: Kind,
    key: String,
    name: String,
    /// 各部分（流水线的各个阶段、一个文件……）的进度。
    parts: BTreeMap<String, f64>,
    detail: String,
    /// 最近一次报进度的序号，用来挑「眼下在忙什么」。
    touched: u64,
}

#[derive(Default)]
struct Registry {
    next: u64,
    entries: BTreeMap<u64, Entry>,
    /// 上次因为进度往外发的时间。下载每收一块就报一次，没必要每次都发。
    last_report: Option<Instant>,
}

impl Registry {
    fn status(&self) -> Status {
        let Some(first) = self.entries.values().next() else {
            return Status::idle();
        };
        let mut keys: Vec<&str> = self.entries.values().map(|e| e.key.as_str()).collect();
        keys.sort_unstable();
        keys.dedup();
        let mut title = if first.name.is_empty() {
            first.kind.verb().to_string()
        } else {
            format!("{}「{}」", first.kind.verb(), first.name)
        };
        if keys.len() > 1 {
            title.push_str(&format!(" 等 {} 项", keys.len()));
        }
        let parts: Vec<f64> = self
            .entries
            .values()
            .flat_map(|e| e.parts.values().copied())
            .collect();
        let progress = if parts.is_empty() {
            -1.0
        } else {
            parts.iter().sum::<f64>() / parts.len() as f64
        };
        let detail = self
            .entries
            .values()
            .max_by_key(|e| e.touched)
            .map(|e| e.detail.clone())
            .unwrap_or_default();
        Status {
            active: true,
            title,
            detail,
            progress,
        }
    }
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

/// 守卫：丢掉即表示这项任务结束（正常完成、失败、被取消都一样）。
#[must_use]
pub struct Hold(u64);

impl Drop for Hold {
    fn drop(&mut self) {
        let mut registry = registry().lock().unwrap_or_else(|p| p.into_inner());
        registry.entries.remove(&self.0);
        publish(registry.status());
    }
}

/// 登记一项长任务。`key` 用来对上之后的 [`report`]（处理视频用视频 id）。
/// 视频标题多半就是文件名，通知里去掉扩展名。
fn display_name(name: String) -> String {
    const EXTS: &[&str] = &[
        ".mp4", ".mkv", ".mov", ".webm", ".flv", ".avi", ".m4v", ".mp3", ".m4a", ".wav",
    ];
    let lower = name.to_lowercase();
    match EXTS.iter().find(|ext| lower.ends_with(*ext)) {
        Some(ext) if name.len() > ext.len() => name[..name.len() - ext.len()].to_string(),
        _ => name,
    }
}

pub fn hold(kind: Kind, key: impl Into<String>, name: impl Into<String>) -> Hold {
    let mut registry = registry().lock().unwrap_or_else(|p| p.into_inner());
    registry.next += 1;
    let id = registry.next;
    registry.entries.insert(
        id,
        Entry {
            kind,
            key: key.into(),
            name: display_name(name.into()),
            parts: BTreeMap::new(),
            detail: String::new(),
            touched: id,
        },
    );
    publish(registry.status());
    Hold(id)
}

/// 报一项任务里某部分的进度（0..=1）。`detail` 为空时不改原来的说明。
/// 没有登记过这个 key（比如桌面端、或任务已经结束）就什么也不做。
pub fn report(key: &str, part: &str, progress: f64, detail: &str) {
    let mut registry = registry().lock().unwrap_or_else(|p| p.into_inner());
    registry.next += 1;
    let touched = registry.next;
    let mut hit = false;
    for entry in registry.entries.values_mut().filter(|e| e.key == key) {
        entry
            .parts
            .insert(part.to_string(), progress.clamp(0.0, 1.0));
        if !detail.is_empty() {
            entry.detail = detail.to_string();
            entry.touched = touched;
        }
        hit = true;
    }
    let due = registry
        .last_report
        .is_none_or(|at| at.elapsed() >= REPORT_INTERVAL);
    if hit && due {
        registry.last_report = Some(Instant::now());
        publish(registry.status());
    }
}

/// 流水线各阶段在通知里的叫法。
pub fn stage_label(stage: &str) -> &'static str {
    match stage {
        "crop" => "检测黑边",
        "audio" => "提取音频",
        "asr" => "语音识别",
        "slides" => "提取课件",
        "slides_ocr" => "识别课件文字",
        "chapters" => "划分章节",
        "summary" => "生成摘要",
        "notes" => "生成笔记",
        "quiz" => "出题",
        "mindmap" => "生成脑图",
        _ => "处理中",
    }
}

/// 流水线的任务事件顺手报给这里：已结束的阶段按做完算，正在跑的那个当作说明。
pub fn report_job(video_id: &str, stage: &str, status: &str, progress: f64) {
    let (progress, detail) = match status {
        "running" => (
            progress,
            format!(
                "{} {}%",
                stage_label(stage),
                (progress * 100.0).round() as i64
            ),
        ),
        "pending" => (progress, String::new()),
        _ => (1.0, String::new()),
    };
    report(video_id, stage, progress, &detail);
}

fn publish(status: Status) {
    if let Some(tx) = sender() {
        let _ = tx.lock().unwrap_or_else(|p| p.into_inner()).send(status);
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn sender() -> Option<&'static Mutex<Sender<Status>>> {
    static TX: OnceLock<Mutex<Sender<Status>>> = OnceLock::new();
    Some(TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("keep-alive".into())
            .spawn(move || {
                forward(rx, GRACE, THROTTLE, |status| {
                    if let Err(error) = crate::mobile_files::set_keep_alive(status) {
                        tracing::warn!("keep-alive: {error}");
                    }
                })
            })
            .expect("spawn keep-alive thread");
        Mutex::new(tx)
    }))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn sender() -> Option<&'static Mutex<Sender<Status>>> {
    None
}

/// 把状态转给原生层：攒着的只发最新一条；活跃期间每发一次歇 `throttle`；
/// 收到「没有任务了」先等 `grace`，这期间又有任务就当没停过。
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
fn forward(
    rx: Receiver<Status>,
    grace: Duration,
    throttle: Duration,
    mut sink: impl FnMut(&Status),
) {
    let mut last = Status::idle();
    let mut pending: Option<Status> = None;
    loop {
        let mut status = match pending.take() {
            Some(status) => status,
            None => match rx.recv() {
                Ok(status) => status,
                Err(_) => return,
            },
        };
        while let Ok(next) = rx.try_recv() {
            status = next;
        }
        if !status.active && last.active {
            match rx.recv_timeout(grace) {
                Ok(next) => {
                    pending = Some(next);
                    continue;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        if status != last {
            sink(&status);
            last = status;
        }
        if last.active {
            std::thread::sleep(throttle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::sync::Arc;

    fn entry(kind: Kind, key: &str, name: &str) -> Entry {
        Entry {
            kind,
            key: key.into(),
            name: name.into(),
            parts: BTreeMap::new(),
            detail: String::new(),
            touched: 0,
        }
    }

    #[test]
    fn status_summarizes_entries() {
        let mut registry = Registry::default();
        assert!(!registry.status().active);

        let mut first = entry(Kind::Processing, "v1", "第一讲");
        first.parts.insert("asr".into(), 0.5);
        first.parts.insert("audio".into(), 1.0);
        first.detail = "语音识别 50%".into();
        first.touched = 2;
        registry.entries.insert(1, first);
        let status = registry.status();
        assert_eq!(status.title, "正在处理「第一讲」");
        assert_eq!(status.detail, "语音识别 50%");
        assert!((status.progress - 0.75).abs() < 1e-9);

        let mut second = entry(Kind::ModelDownload, "sensevoice", "SenseVoice");
        second.detail = "1.0 MB".into();
        second.touched = 3;
        registry.entries.insert(2, second);
        let status = registry.status();
        assert_eq!(status.title, "正在处理「第一讲」 等 2 项");
        assert_eq!(status.detail, "1.0 MB");
    }

    #[test]
    fn same_key_counts_once_and_no_parts_means_unknown_progress() {
        let mut registry = Registry::default();
        registry.entries.insert(1, entry(Kind::Transcode, "v1", ""));
        registry
            .entries
            .insert(2, entry(Kind::Processing, "v1", ""));
        let status = registry.status();
        assert_eq!(status.title, "正在转码");
        assert_eq!(status.progress, -1.0);
    }

    #[test]
    fn titles_drop_the_file_extension() {
        assert_eq!(
            display_name("03 梯度下降的直觉.mp4".into()),
            "03 梯度下降的直觉"
        );
        assert_eq!(display_name("Lecture.MKV".into()), "Lecture");
        assert_eq!(display_name("第一讲".into()), "第一讲");
        assert_eq!(display_name(".mp4".into()), ".mp4");
    }

    #[test]
    fn report_job_treats_finished_stages_as_done() {
        let _hold = hold(Kind::Processing, "report-job-test", "x");
        report_job("report-job-test", "audio", "done", 0.0);
        report_job("report-job-test", "asr", "running", 0.25);
        report_job("report-job-test", "quiz", "pending", 0.0);
        let registry = registry().lock().unwrap();
        let entry = registry
            .entries
            .values()
            .find(|e| e.key == "report-job-test")
            .unwrap();
        assert_eq!(entry.parts["audio"], 1.0);
        assert_eq!(entry.parts["asr"], 0.25);
        assert_eq!(entry.parts["quiz"], 0.0);
        assert_eq!(entry.detail, "语音识别 25%");
    }

    fn active(progress: f64) -> Status {
        Status {
            active: true,
            title: "t".into(),
            detail: String::new(),
            progress,
        }
    }

    fn run_forward(
        grace: Duration,
        script: impl FnOnce(&Sender<Status>) + Send + 'static,
    ) -> Vec<Status> {
        let (tx, rx) = channel();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = seen.clone();
        let worker = std::thread::spawn(move || {
            forward(rx, grace, Duration::from_millis(1), |s| {
                sink_seen.lock().unwrap().push(s.clone())
            })
        });
        script(&tx);
        drop(tx);
        worker.join().unwrap();
        Arc::try_unwrap(seen).unwrap().into_inner().unwrap()
    }

    #[test]
    fn a_gap_shorter_than_grace_never_reaches_native() {
        let seen = run_forward(Duration::from_millis(300), |tx| {
            tx.send(active(0.1)).unwrap();
            std::thread::sleep(Duration::from_millis(50));
            tx.send(Status::idle()).unwrap();
            std::thread::sleep(Duration::from_millis(50));
            tx.send(active(0.2)).unwrap();
            std::thread::sleep(Duration::from_millis(50));
        });
        assert!(seen.iter().all(|s| s.active), "{seen:?}");
        assert_eq!(seen.last().unwrap().progress, 0.2);
    }

    #[test]
    fn idle_is_sent_after_grace() {
        let seen = run_forward(Duration::from_millis(30), |tx| {
            tx.send(active(0.1)).unwrap();
            std::thread::sleep(Duration::from_millis(20));
            tx.send(Status::idle()).unwrap();
            std::thread::sleep(Duration::from_millis(150));
        });
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert!(!seen[1].active);
    }
}
