use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::pipeline::crop_detect::CropInsets;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::sidecar::{resolve, FFMPEG};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tokio::io::AsyncReadExt;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tokio::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct SlideFrame {
    pub page_no: i64,
    pub image_path: String,
    pub start_ms: i64,
}

/// 提取参数。分开成一个结构而不是继续加参数，是因为这几项来源不同：门槛来自设置、
/// 时长与黑边来自视频表。
#[derive(Debug, Clone, Default)]
pub struct ExtractOptions {
    /// 单块亮度差门槛（0~255 量纲）；None 表示按画面噪声自估。
    pub block_delta: Option<f64>,
    /// 视频时长，只用来估采样总帧数好报百分比；None 时进度的 total 为 0。
    pub duration_ms: Option<i64>,
    /// 导入时 cropdetect 探测的黑边四边占比；None 或全 0 表示不裁。
    pub crop: Option<CropInsets>,
}

/// 提取进度。`phase` 为 "sample"（降采样通读整段视频，耗时大头）或
/// "capture"（逐页截全分辨率图）。`total` 为 0 表示总量未知（拿不到时长）。
#[derive(Debug, Clone, Serialize)]
pub struct ExtractProgress {
    pub phase: String,
    pub done: usize,
    pub total: usize,
}

impl ExtractProgress {
    fn sample(done: usize, total: usize) -> Self {
        Self {
            phase: "sample".into(),
            done,
            total,
        }
    }

    fn capture(done: usize, total: usize) -> Self {
        Self {
            phase: "capture".into(),
            done,
            total,
        }
    }
}

fn cancelled() -> AppError {
    AppError::Other("课件提取已取消".into())
}

/// 黑边裁剪滤镜（`crop=w:h:x:y`，用 iw/ih 表达式所以不必知道具体分辨率）。
/// 不裁时返回 None。黑边既该从判定里去掉——永远不变的黑块会稀释「变化块比例」，
/// 让真正的换页显得没那么大——也该从存下来的课件图里去掉。
/// 占比之和接近或超过整幅（旧数据/探测异常）时宁可不裁，免得把画面裁没了。
fn crop_filter(insets: Option<CropInsets>) -> Option<String> {
    let insets = insets?;
    let clamp = |value: f64| {
        if value.is_finite() {
            value.clamp(0.0, 1.0)
        } else {
            0.0
        }
    };
    let (top, right) = (clamp(insets.top), clamp(insets.right));
    let (bottom, left) = (clamp(insets.bottom), clamp(insets.left));
    let (width, height) = (1.0 - left - right, 1.0 - top - bottom);
    if width < 0.1 || height < 0.1 {
        return None;
    }
    if width > 0.999 && height > 0.999 {
        return None;
    }
    Some(format!(
        "crop=iw*{width:.4}:ih*{height:.4}:iw*{left:.4}:ih*{top:.4}"
    ))
}

// 同时最多跑几个截图进程。逐页串行时几十页就是几十次串行的进程启动+定位，
// 而这些截图彼此独立；并发数压在个位数，免得把 CPU 全喂给 ffmpeg 卡住播放。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const CAPTURE_CONCURRENCY: usize = 4;
// 采样阶段每读多少帧推一次进度（1 帧 = 1 秒视频，太密只是噪声）。
const SAMPLE_PROGRESS_EVERY: usize = 30;

// 抽帧分析参数。把视频降到很小的灰度帧来比对换页，既快又抗噪。
// 桌面端用 ffmpeg 生成低分辨率帧；Android 用原生 MediaMetadataRetriever 生成同尺寸亮度帧。
const SAMPLE_W: usize = 128;
const SAMPLE_H: usize = 72;
const SAMPLE_FPS: i64 = 1; // 每秒采 1 帧
const SAMPLE_INTERVAL_MS: i64 = 1000 / SAMPLE_FPS;

// 换页判定的分块参数：把采样帧切成 8×8 的块，只看块均值。
// 此前用整屏亮度 RMS，分不清「角落里的讲师摄像头/鼠标/进度条在动」和「换页」：
// 阈值调低会被局部动静刷出一堆重复页，调高又漏掉只换了标题和一行字的页。
const BLOCK: usize = 8;
const BLOCKS_X: usize = SAMPLE_W / BLOCK;
const BLOCKS_Y: usize = SAMPLE_H / BLOCK;
const BLOCK_COUNT: usize = BLOCKS_X * BLOCKS_Y;
// 至少这个比例的块变了才算换页：局部动静只影响少数块，换页动大半屏。
const CHANGE_RATIO: f64 = 0.2;
// 变化比例低于此值视为画面已稳定（用来挑动画结束后的那一帧）。比 CHANGE_RATIO 松，
// 讲师的小幅动作不至于让一页永远「不稳定」。
const SETTLED_RATIO: f64 = 0.1;
// 从换页点往后最多找几帧的稳定帧（1 帧 = 1 秒）。
const SETTLE_MAX_FRAMES: usize = 5;
// 停留不足这么多帧的页按转场/动画中间态丢掉。
const MIN_DWELL_FRAMES: usize = 2;
// 块均值极差小于此值的帧视为近纯色（黑屏片头、白场转场），不作为课件页。
const BLANK_SPREAD: f64 = 8.0;
// 自动块阈值的上下限（0~255 量纲，作用在单个块的均值差上）。
const BLOCK_DELTA_MIN: f64 = 4.0;
const BLOCK_DELTA_MAX: f64 = 24.0;

/// RGB→Rec.709 亮度（与参考算法 video-to-ppt 一致）。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn luminance_frame(rgb: &[u8]) -> Vec<u8> {
    rgb.chunks_exact(3)
        .map(|p| {
            let y = 0.2126 * p[0] as f64 + 0.7152 * p[1] as f64 + 0.0722 * p[2] as f64;
            y.round().clamp(0.0, 255.0) as u8
        })
        .collect()
}

/// 把一帧亮度图压成块均值（16×9）。换页判定全部基于块均值。
/// 帧尺寸不是采样尺寸（移动端异常返回等）时返回空表，调用方按「无变化」处理。
fn block_means(frame: &[u8]) -> Vec<f64> {
    if frame.len() != SAMPLE_W * SAMPLE_H {
        return Vec::new();
    }
    let mut means = Vec::with_capacity(BLOCK_COUNT);
    for by in 0..BLOCKS_Y {
        for bx in 0..BLOCKS_X {
            let mut sum = 0_u32;
            for y in 0..BLOCK {
                let row = (by * BLOCK + y) * SAMPLE_W + bx * BLOCK;
                for x in 0..BLOCK {
                    sum += u32::from(frame[row + x]);
                }
            }
            means.push(f64::from(sum) / (BLOCK * BLOCK) as f64);
        }
    }
    means
}

/// 两帧之间「均值变化超过 delta」的块占全部块的比例。
fn changed_ratio(a: &[f64], b: &[f64], delta: f64) -> f64 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let changed = a
        .iter()
        .zip(b.iter())
        .filter(|(x, y)| (*x - *y).abs() > delta)
        .count();
    changed as f64 / a.len() as f64
}

/// 近纯色帧：块均值极差很小。黑屏片头、白场转场都长这样，它们不该占一页
/// （此前第 0 帧无条件成为第一页，于是黑屏片头就是第一张课件）。
fn is_blank(blocks: &[f64]) -> bool {
    if blocks.is_empty() {
        return true;
    }
    let (mut lo, mut hi) = (f64::MAX, f64::MIN);
    for &value in blocks {
        lo = lo.min(value);
        hi = hi.max(value);
    }
    hi - lo < BLANK_SPREAD
}

fn median(mut values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = values.len();
    if n % 2 == 1 {
        values[n / 2]
    } else {
        (values[n / 2 - 1] + values[n / 2]) / 2.0
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn short_stderr(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text.lines().rev().take(12).collect();
    lines.into_iter().rev().collect::<Vec<_>>().join("\n")
}

/// 让 ffmpeg 把视频降采样成一串小灰度帧（rgb24 原始流走管道），逐帧读出亮度，避免落地大文件。
/// `hwaccel` 打开时交给系统硬件解码器（Mac 上是 VideoToolbox）：采样要把整段视频完整解一遍，
/// 是整个提取流程的时间大头，也是唯一能成倍改善的地方。取消标志置位时杀掉子进程立即返回。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn sample_luma_frames(
    video: &Path,
    hwaccel: bool,
    crop: Option<&str>,
    total_hint: usize,
    cancel: &AtomicBool,
    on_progress: &mut (dyn FnMut(ExtractProgress) + Send),
) -> AppResult<Vec<Vec<u8>>> {
    let ffmpeg = resolve(&FFMPEG, None)?;
    let mut command = Command::new(&ffmpeg);
    command.args(["-hide_banner", "-nostdin"]);
    if hwaccel {
        command.args(["-hwaccel", "auto"]);
    }
    // 先裁黑边再降采样：黑边不该占掉采样帧里的块。
    let filters = match crop {
        Some(crop) => format!("{crop},fps={SAMPLE_FPS},scale={SAMPLE_W}:{SAMPLE_H}"),
        None => format!("fps={SAMPLE_FPS},scale={SAMPLE_W}:{SAMPLE_H}"),
    };
    let mut child = command
        .arg("-i")
        .arg(video)
        .args([
            "-an", // 只要画面：别让音频白解一遍
            "-sn", "-vf", &filters, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| AppError::Pipeline(format!("ffmpeg spawn: {error}")))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Pipeline("ffmpeg stdout unavailable".into()))?;
    let frame_size = SAMPLE_W * SAMPLE_H * 3;
    let mut buf = vec![0_u8; frame_size];
    let mut frames = Vec::new();
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            return Err(cancelled());
        }
        match stdout.read_exact(&mut buf).await {
            Ok(_) => {
                frames.push(luminance_frame(&buf));
                if frames.len() % SAMPLE_PROGRESS_EVERY == 0 {
                    on_progress(ExtractProgress::sample(frames.len(), total_hint));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(AppError::Pipeline(format!("ffmpeg read: {e}"))),
        }
    }
    let status = child.wait().await;
    // 硬件解码失败时 ffmpeg 可能中途退出、只吐出一部分帧，静默用会漏掉后半段的换页。
    // 调用方据此回落软解，所以这里把「非正常退出」当错误报出去。
    if !matches!(&status, Ok(status) if status.success()) {
        return Err(AppError::Pipeline(format!(
            "ffmpeg sample exited abnormally: {status:?}"
        )));
    }
    on_progress(ExtractProgress::sample(frames.len(), frames.len()));
    Ok(frames)
}

/// 先试硬件解码，失败（或一帧都没吐）再软解重来一次。
/// `-hwaccel auto` 在没有可用硬件时本就会退回软解，这里兜的是"选中了硬件但解不动"的情况。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn sample_luma_frames_with_fallback(
    video: &Path,
    crop: Option<&str>,
    total_hint: usize,
    cancel: &AtomicBool,
    on_progress: &mut (dyn FnMut(ExtractProgress) + Send),
) -> AppResult<Vec<Vec<u8>>> {
    match sample_luma_frames(video, true, crop, total_hint, cancel, on_progress).await {
        Ok(frames) if !frames.is_empty() => Ok(frames),
        Ok(_) | Err(_) if !cancel.load(Ordering::SeqCst) => {
            sample_luma_frames(video, false, crop, total_hint, cancel, on_progress).await
        }
        other => other,
    }
}

/// 一页课件在采样序列里的位置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlidePage {
    /// 这一页出现的采样帧（决定 start_ms，即「讲到这一页」的时间）。
    pub start_index: usize,
    /// 画面稳定后用于截图的采样帧：换页那一刻常落在淡入/飞入动画中途，截出来是半张图。
    pub capture_index: usize,
}

/// 在 [start, 下一页起点) 内找画面稳住的第一帧，最多往后 SETTLE_MAX_FRAMES 帧。
/// 一直不稳定（长动画）就用能取到的最后一帧——总比停在动画刚开始那一瞬好。
fn settle_index(blocks: &[Vec<f64>], start: usize, end: usize, delta: f64) -> usize {
    let last = blocks.len().saturating_sub(1);
    let limit = (start + SETTLE_MAX_FRAMES)
        .min(end.saturating_sub(1))
        .min(last)
        .max(start);
    for j in start..limit {
        if changed_ratio(&blocks[j], &blocks[j + 1], delta) < SETTLED_RATIO {
            return j;
        }
    }
    limit
}

/// 找出每一页课件：与前一帧、且与上一张已保存页都有足够比例的块发生变化，才算新的一页
/// （后者去掉渐变/动画回弹造成的重复页）。近纯色帧不参与成页；停留过短的页按转场丢掉；
/// 每页再往后挑一帧稳定画面用于截图。`block_delta` 是单个块「算变了」的亮度差门槛。
pub fn detect_slide_pages(frames: &[Vec<u8>], block_delta: f64) -> Vec<SlidePage> {
    if frames.is_empty() {
        return Vec::new();
    }
    let blocks: Vec<Vec<f64>> = frames.iter().map(|frame| block_means(frame)).collect();

    let mut starts: Vec<usize> = Vec::new();
    for i in 0..blocks.len() {
        if is_blank(&blocks[i]) {
            continue;
        }
        match starts.last() {
            // 第一页 = 第一帧有内容的画面（跳过黑屏片头）。
            None => starts.push(i),
            Some(&page) => {
                let from_prev = changed_ratio(&blocks[i - 1], &blocks[i], block_delta);
                let from_page = changed_ratio(&blocks[page], &blocks[i], block_delta);
                if from_prev >= CHANGE_RATIO && from_page >= CHANGE_RATIO {
                    starts.push(i);
                }
            }
        }
    }
    // 整段都是纯色（全黑视频等）时仍给出一页，否则「提取成功但一页都没有」更让人困惑。
    if starts.is_empty() {
        starts.push(0);
    }

    // 停留不足 MIN_DWELL_FRAMES 的页是转场/动画中间态。末页的停留算到采样结束。
    let mut kept: Vec<usize> = Vec::with_capacity(starts.len());
    for (i, &start) in starts.iter().enumerate() {
        let end = starts.get(i + 1).copied().unwrap_or(blocks.len());
        if end - start >= MIN_DWELL_FRAMES {
            kept.push(start);
        }
    }
    // 全被过滤掉（视频短于最短停留等）时保留第一页。
    if kept.is_empty() {
        kept.push(starts[0]);
    }

    kept.iter()
        .enumerate()
        .map(|(i, &start)| {
            let end = kept.get(i + 1).copied().unwrap_or(blocks.len());
            SlidePage {
                start_index: start,
                capture_index: settle_index(&blocks, start, end, block_delta),
            }
        })
        .collect()
}

/// 自动块阈值：先估画面噪声地板（每对相邻帧取各块均值差的中位数，再取全局中位数），
/// 抬高几倍作为「算变了」的门槛。此前的自适应阈值取整屏 RMS 差的中位数，那跟随的是
/// 「典型运动量」而不是噪声——动态内容多的视频会把门槛抬到漏页。
pub fn dynamic_block_delta(frames: &[Vec<u8>]) -> f64 {
    let blocks: Vec<Vec<f64>> = frames.iter().map(|frame| block_means(frame)).collect();
    let per_pair: Vec<f64> = blocks
        .windows(2)
        .filter(|pair| pair[0].len() == pair[1].len() && !pair[0].is_empty())
        .map(|pair| {
            median(
                pair[0]
                    .iter()
                    .zip(pair[1].iter())
                    .map(|(a, b)| (a - b).abs())
                    .collect(),
            )
        })
        .collect();
    (median(per_pair) * 3.0 + BLOCK_DELTA_MIN).clamp(BLOCK_DELTA_MIN, BLOCK_DELTA_MAX)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn decode_base64(input: &str) -> AppResult<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer = 0_u32;
    let mut bits = 0_u8;
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b'\r' | b'\n' | b'\t' | b' ' => continue,
            _ => {
                return Err(AppError::Pipeline(format!(
                    "mobile luma frame decode: invalid base64 byte {byte}"
                )))
            }
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

/// 移动端（Android: MediaMetadataRetriever；iOS: AVAssetImageGenerator）原生低分辨率
/// 亮度抽帧，供课件提取复用同一套 Rust 换页检测算法。
#[cfg(any(target_os = "android", target_os = "ios"))]
async fn sample_mobile_luma_frames(video: &Path) -> AppResult<(Vec<Vec<u8>>, i64)> {
    let response = crate::mobile_files::export_luma_frames(
        video.to_string_lossy().to_string(),
        SAMPLE_W as i64,
        SAMPLE_H as i64,
        SAMPLE_INTERVAL_MS,
    )
    .await
    .map_err(AppError::Pipeline)?;
    let expected = SAMPLE_W * SAMPLE_H;
    let mut frames = Vec::with_capacity(response.frames.len());
    for encoded in response.frames {
        let frame = decode_base64(&encoded)?;
        if frame.len() != expected {
            return Err(AppError::Pipeline(format!(
                "mobile luma frame size mismatch: expected {expected}, got {}",
                frame.len()
            )));
        }
        frames.push(frame);
    }
    Ok((frames, response.interval_ms))
}

/// 移动端原生截一帧落地 JPEG（无 ffmpeg）：
/// Android 走 MediaMetadataRetriever，iOS 走 AVAssetImageGenerator。
/// 原生截帧没有滤镜链，`_crop` 只为与桌面端同签名——移动端不做黑边裁剪。
#[cfg(any(target_os = "android", target_os = "ios"))]
async fn capture_jpeg_at(
    video: &Path,
    out: &Path,
    at_ms: i64,
    _crop: Option<&str>,
) -> AppResult<()> {
    crate::mobile_files::export_frame_jpeg(
        video.to_string_lossy().to_string(),
        at_ms,
        out.to_string_lossy().to_string(),
    )
    .await
    .map(|_| ())
    .map_err(AppError::Pipeline)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn capture_jpeg_at(
    video: &Path,
    out: &Path,
    at_ms: i64,
    crop: Option<&str>,
) -> AppResult<()> {
    let seconds = at_ms as f64 / 1000.0;
    let ffmpeg = resolve(&FFMPEG, None)?;
    let mut command = Command::new(&ffmpeg);
    command
        .args([
            "-hide_banner",
            "-nostdin",
            "-y",
            "-ss",
            &format!("{seconds}"),
            "-i",
        ])
        .arg(video);
    if let Some(crop) = crop {
        command.args(["-vf", crop]);
    }
    let output = command
        .args(["-frames:v", "1", "-q:v", "2", "-update", "1"])
        .arg(out)
        .output()
        .await
        .map_err(|error| AppError::Pipeline(format!("ffmpeg spawn: {error}")))?;
    if !output.status.success() {
        return Err(AppError::Pipeline(format!(
            "ffmpeg capture failed: {}\n{}",
            output.status,
            short_stderr(&output.stderr)
        )));
    }
    Ok(())
}

/// 移动端（Android / iOS）：用原生低分辨率亮度抽帧 + 共享换页检测算法提取课件页，
/// 再为每页用原生截帧落地一张全分辨率图。无 ffmpeg。
/// 原生抽帧是一次性返回的，采样阶段只在结束时报一次进度；黑边裁剪在移动端不生效。
#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn extract_slides(
    video: &Path,
    out_dir: &Path,
    options: ExtractOptions,
    cancel: &AtomicBool,
    on_progress: &mut (dyn FnMut(ExtractProgress) + Send),
) -> AppResult<Vec<SlideFrame>> {
    let slides_dir = out_dir.join("slides");
    let _ = std::fs::remove_dir_all(&slides_dir);
    std::fs::create_dir_all(&slides_dir)?;

    let (frames, interval_ms) = sample_mobile_luma_frames(video).await?;
    on_progress(ExtractProgress::sample(frames.len(), frames.len()));
    if cancel.load(Ordering::SeqCst) {
        return Err(cancelled());
    }
    if frames.is_empty() {
        let fallback = slides_dir.join("0001.jpg");
        capture_jpeg_at(video, &fallback, 0, None).await?;
        return Ok(vec![SlideFrame {
            page_no: 0,
            image_path: fallback.to_string_lossy().to_string(),
            start_ms: 0,
        }]);
    }

    let block_delta = options
        .block_delta
        .unwrap_or_else(|| dynamic_block_delta(&frames));
    let pages = detect_slide_pages(&frames, block_delta);
    let mut out = Vec::new();
    for (page, spec) in pages.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        let start_ms = spec.start_index as i64 * interval_ms;
        let image = slides_dir.join(format!("{:04}.jpg", page + 1));
        capture_jpeg_at(video, &image, spec.capture_index as i64 * interval_ms, None).await?;
        out.push(SlideFrame {
            page_no: page as i64,
            image_path: image.to_string_lossy().to_string(),
            start_ms,
        });
        on_progress(ExtractProgress::capture(out.len(), pages.len()));
    }
    Ok(out)
}

/// 抽课件页：降采样灰度帧 → 分块变化比例找换页点 → 为每页截一张全分辨率图。
/// 视频自带黑边（`options.crop`）会在采样与截图两处都先裁掉：黑块永远不变，
/// 留着既稀释换页判定、也让存下来的课件图带着黑边。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn extract_slides(
    video: &Path,
    out_dir: &Path,
    options: ExtractOptions,
    cancel: &AtomicBool,
    on_progress: &mut (dyn FnMut(ExtractProgress) + Send),
) -> AppResult<Vec<SlideFrame>> {
    let slides_dir = out_dir.join("slides");
    // 清掉旧图，避免页数变少时残留上次的多余图片。
    let _ = std::fs::remove_dir_all(&slides_dir);
    std::fs::create_dir_all(&slides_dir)?;

    let total_hint = options
        .duration_ms
        .filter(|ms| *ms > 0)
        .map(|ms| (ms / SAMPLE_INTERVAL_MS) as usize)
        .unwrap_or(0);
    let crop = crop_filter(options.crop);
    let frames =
        sample_luma_frames_with_fallback(video, crop.as_deref(), total_hint, cancel, on_progress)
            .await?;
    if frames.is_empty() {
        let fallback = slides_dir.join("0001.jpg");
        capture_jpeg_at(video, &fallback, 0, crop.as_deref()).await?;
        return Ok(vec![SlideFrame {
            page_no: 0,
            image_path: fallback.to_string_lossy().to_string(),
            start_ms: 0,
        }]);
    }

    let block_delta = options
        .block_delta
        .unwrap_or_else(|| dynamic_block_delta(&frames));
    let pages = detect_slide_pages(&frames, block_delta);

    // 页号/文件名/截图时间点先算好，截图本身只是各自独立的 I/O，因此可以并发而不动页序。
    // 截的是稳定后那一帧，而 start_ms 仍是这一页出现的时刻（点缩略图要跳到讲它的开头）。
    let planned: Vec<(SlideFrame, i64)> = pages
        .iter()
        .enumerate()
        .map(|(page, spec)| {
            let image = slides_dir.join(format!("{:04}.jpg", page + 1));
            (
                SlideFrame {
                    page_no: page as i64,
                    image_path: image.to_string_lossy().to_string(),
                    start_ms: spec.start_index as i64 * SAMPLE_INTERVAL_MS,
                },
                spec.capture_index as i64 * SAMPLE_INTERVAL_MS,
            )
        })
        .collect();

    let mut done = 0;
    for chunk in planned.chunks(CAPTURE_CONCURRENCY) {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        let shots = chunk.iter().map(|(frame, at_ms)| {
            capture_jpeg_at(video, Path::new(&frame.image_path), *at_ms, crop.as_deref())
        });
        futures_util::future::try_join_all(shots).await?;
        done += chunk.len();
        on_progress(ExtractProgress::capture(done, planned.len()));
    }
    Ok(planned.into_iter().map(|(frame, _)| frame).collect())
}

pub async fn store_slides(db: &Db, video_id: &str, frames: &[SlideFrame]) -> AppResult<usize> {
    let mut tx = db.pool.begin().await?;
    sqlx::query("DELETE FROM slides WHERE video_id=?")
        .bind(video_id)
        .execute(&mut *tx)
        .await?;
    for (idx, f) in frames.iter().enumerate() {
        let end_ms = frames.get(idx + 1).map(|n| n.start_ms);
        sqlx::query(
            "INSERT INTO slides(video_id,image_path,start_ms,end_ms,page_no)
             VALUES (?,?,?,?,?)",
        )
        .bind(video_id)
        .bind(&f.image_path)
        .bind(f.start_ms)
        .bind(end_ms)
        .bind(f.page_no)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(frames.len())
}

/// 取视频首帧作为封面，缓存到 data_dir/cover.jpg；已存在则直接返回。
pub async fn ensure_cover(video: &Path, data_dir: &Path) -> AppResult<PathBuf> {
    std::fs::create_dir_all(data_dir)?;
    let cover = data_dir.join("cover.jpg");
    if !cover.is_file() {
        // 取第 1 秒，避开纯黑片头；极短视频则回退到首帧。
        if capture_jpeg_at(video, &cover, 1000, None).await.is_err() {
            capture_jpeg_at(video, &cover, 0, None).await?;
        }
    }
    Ok(cover)
}

/// 在 at_ms 处截一帧到 screenshots/，返回落地路径。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn capture_frame(video: &Path, out_dir: &Path, at_ms: i64) -> AppResult<PathBuf> {
    let shots_dir = out_dir.join("screenshots");
    std::fs::create_dir_all(&shots_dir)?;
    let out = shots_dir.join(format!("{at_ms}.jpg"));
    capture_jpeg_at(video, &out, at_ms, None).await?;
    Ok(out)
}

/// 移动端（Android / iOS）：用原生截帧落地截图，无 ffmpeg。
#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn capture_frame(video: &Path, out_dir: &Path, at_ms: i64) -> AppResult<PathBuf> {
    let shots_dir = out_dir.join("screenshots");
    std::fs::create_dir_all(&shots_dir)?;
    let out = shots_dir.join(format!("{at_ms}.jpg"));
    capture_jpeg_at(video, &out, at_ms, None).await?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::crop_detect::NO_CROP;
    use std::process::Command as StdCommand;
    use tempfile::tempdir;

    fn solid(value: u8) -> Vec<u8> {
        vec![value; SAMPLE_W * SAMPLE_H]
    }

    /// 一张"有内容"的页：左半 base、右半 base+90，块均值极差够大，不会被当成纯色。
    fn page(base: u8) -> Vec<u8> {
        let mut frame = vec![base; SAMPLE_W * SAMPLE_H];
        for y in 0..SAMPLE_H {
            for x in SAMPLE_W / 2..SAMPLE_W {
                frame[y * SAMPLE_W + x] = base.saturating_add(90);
            }
        }
        frame
    }

    /// 在一页上改动左上角 bx×by 个块。2×2 用来模拟讲师摄像头/鼠标那种局部动静，
    /// 4×6（24/144 ≈ 17%）用来模拟"还在动但不算换页"的动画。
    fn with_blocks(frame: &[u8], bx: usize, by: usize, value: u8) -> Vec<u8> {
        let mut out = frame.to_vec();
        for y in 0..BLOCK * by {
            for x in 0..BLOCK * bx {
                out[y * SAMPLE_W + x] = value;
            }
        }
        out
    }

    fn with_corner(frame: &[u8], value: u8) -> Vec<u8> {
        with_blocks(frame, 2, 2, value)
    }

    fn starts_of(pages: &[SlidePage]) -> Vec<usize> {
        pages.iter().map(|p| p.start_index).collect()
    }

    #[test]
    fn luminance_uses_rec709_weights() {
        // 纯绿权重最大。
        let green = luminance_frame(&[0, 255, 0]);
        assert_eq!(green[0], (0.7152_f64 * 255.0).round() as u8);
    }

    #[test]
    fn changed_ratio_counts_only_blocks_over_delta() {
        let a = block_means(&page(40));
        assert_eq!(a.len(), BLOCK_COUNT);
        assert_eq!(changed_ratio(&a, &a, 8.0), 0.0);
        // 左上 2×2 块变了：4/144，远低于换页所需比例。
        let corner = block_means(&with_corner(&page(40), 220));
        let ratio = changed_ratio(&a, &corner, 8.0);
        assert!(
            (ratio - 4.0 / BLOCK_COUNT as f64).abs() < 1e-9,
            "got {ratio}"
        );
        assert!(ratio < CHANGE_RATIO);
        // 整屏换页：所有块都变。
        assert_eq!(changed_ratio(&a, &block_means(&page(140)), 8.0), 1.0);
    }

    #[test]
    fn local_motion_does_not_make_a_new_page() {
        // 一页讲义 + 角落里有人在动：此前整屏 RMS 一超阈值就成新页，现在只动 4 块不算。
        let base = page(40);
        let frames = vec![
            base.clone(),
            with_corner(&base, 200),
            with_corner(&base, 60),
            base.clone(),
        ];
        assert_eq!(starts_of(&detect_slide_pages(&frames, 8.0)), vec![0]);
    }

    #[test]
    fn detects_each_distinct_page_once() {
        // 三张明显不同的页，中间各夹一张"稳定后的同页"——不应重复计数。
        let frames = vec![
            page(10),
            page(10),
            page(120),
            page(120),
            page(160),
            page(160),
        ];
        assert_eq!(starts_of(&detect_slide_pages(&frames, 8.0)), vec![0, 2, 4]);
    }

    #[test]
    fn skips_blank_intro_frames() {
        // 黑屏片头不该占第一页：第一页从有内容的那一帧开始。
        let frames = vec![solid(0), solid(0), page(90), page(90)];
        assert_eq!(starts_of(&detect_slide_pages(&frames, 8.0)), vec![2]);
    }

    #[test]
    fn drops_pages_that_do_not_stay_long_enough() {
        // 第 2 帧是转场中间态（只停留 1 帧），应被丢掉，只留前后两页。
        let frames = vec![page(20), page(20), page(200), page(90), page(90), page(90)];
        assert_eq!(starts_of(&detect_slide_pages(&frames, 8.0)), vec![0, 3]);
    }

    #[test]
    fn captures_the_frame_after_the_animation_settles() {
        // 换页后还有一帧在动（约 17% 的块，够"不稳定"但不够"新的一页"）：
        // 截图取稳定后的那一帧，start_index 仍是换页那一刻。
        let frames = vec![
            page(20),
            page(20),
            page(120),
            with_blocks(&page(120), 4, 6, 255),
            page(120),
            page(120),
        ];
        let pages = detect_slide_pages(&frames, 8.0);
        assert_eq!(starts_of(&pages), vec![0, 2]);
        assert_eq!(pages[1].start_index, 2);
        assert_eq!(pages[1].capture_index, 4);
    }

    #[test]
    fn steady_content_yields_single_page() {
        let frames = vec![page(200), page(200), page(200)];
        let delta = dynamic_block_delta(&frames);
        assert_eq!(starts_of(&detect_slide_pages(&frames, delta)), vec![0]);
    }

    #[test]
    fn dynamic_block_delta_floors_for_static_video_and_rises_with_noise() {
        let still = vec![page(128), page(128), page(128)];
        assert_eq!(dynamic_block_delta(&still), BLOCK_DELTA_MIN);
        // 每帧整屏抖动 ±6 的噪声视频：门槛抬高，不再把噪声当换页。
        let noisy = vec![page(100), page(106), page(100), page(106)];
        assert!(dynamic_block_delta(&noisy) > BLOCK_DELTA_MIN);
        assert!(dynamic_block_delta(&noisy) <= BLOCK_DELTA_MAX);
    }

    #[test]
    fn crop_filter_skips_no_crop_and_absurd_insets() {
        assert_eq!(crop_filter(None), None);
        assert_eq!(crop_filter(Some(NO_CROP)), None);
        // 上下各 10% 的信箱黑边。
        let letterbox = CropInsets {
            top: 0.1,
            right: 0.0,
            bottom: 0.1,
            left: 0.0,
        };
        assert_eq!(
            crop_filter(Some(letterbox)).unwrap(),
            "crop=iw*1.0000:ih*0.8000:iw*0.0000:ih*0.1000"
        );
        // 探测异常/脏数据把画面裁没了，宁可不裁。
        let absurd = CropInsets {
            top: 0.6,
            right: 0.0,
            bottom: 0.6,
            left: 0.0,
        };
        assert_eq!(crop_filter(Some(absurd)), None);
        let nan = CropInsets {
            top: f64::NAN,
            right: 0.0,
            bottom: 0.0,
            left: 0.0,
        };
        assert_eq!(crop_filter(Some(nan)), None);
    }

    #[test]
    fn all_blank_video_still_yields_one_page() {
        let frames = vec![solid(0), solid(0), solid(0)];
        assert_eq!(starts_of(&detect_slide_pages(&frames, 8.0)), vec![0]);
    }

    #[tokio::test]
    async fn extracts_slides_from_color_changes() {
        if which::which("ffmpeg").is_err() {
            eprintln!("skipping: no ffmpeg");
            return;
        }
        let dir = tempdir().unwrap();
        let video = dir.path().join("in.mp4");
        // 每段左半边画成白块：纯色帧会被当作转场/黑屏跳过，讲义总是有明暗结构的。
        let gen = StdCommand::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=160x90:d=2",
                "-f",
                "lavfi",
                "-i",
                "color=c=green:s=160x90:d=2",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=160x90:d=2",
                "-filter_complex",
                "[0:v]drawbox=w=80:h=90:color=white:t=fill[a];\
                 [1:v]drawbox=w=80:h=90:color=white:t=fill[b];\
                 [2:v]drawbox=w=80:h=90:color=white:t=fill[c];\
                 [a][b][c]concat=n=3:v=1:a=0",
            ])
            .arg(&video)
            .output()
            .expect("ffmpeg gen");
        assert!(gen.status.success(), "gen failed: {gen:?}");

        let mut events: Vec<ExtractProgress> = Vec::new();
        let frames = extract_slides(
            &video,
            dir.path(),
            ExtractOptions {
                duration_ms: Some(6_000),
                ..Default::default()
            },
            &AtomicBool::new(false),
            &mut |progress| events.push(progress),
        )
        .await
        .unwrap();
        // 红/绿/蓝三段，应至少抽出多于一页且每页图片落地。
        assert!(
            frames.len() >= 2,
            "expected multiple pages, got {}",
            frames.len()
        );
        assert!(Path::new(&frames[0].image_path).is_file());
        // 两个阶段都要报进度，截图阶段的总数等于页数（前端据此显示 i/n）。
        assert!(events.iter().any(|e| e.phase == "sample"));
        let last = events.last().expect("progress events");
        assert_eq!(last.phase, "capture");
        assert_eq!(last.done, frames.len());
        assert_eq!(last.total, frames.len());

        let dbdir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dbdir.path().join("t.db"))
            .await
            .unwrap();
        let course = crate::commands::courses::create_course(
            &db,
            "c".into(),
            dir.path().to_string_lossy().into(),
        )
        .await
        .unwrap();
        let vrow = crate::commands::videos::add_local_video(&db, &course.id, video.clone(), None)
            .await
            .unwrap();
        let n = store_slides(&db, &vrow.id, &frames).await.unwrap();
        assert_eq!(n, frames.len());
    }

    #[tokio::test]
    async fn extracts_fallback_single_page_when_static() {
        if which::which("ffmpeg").is_err() {
            eprintln!("skipping: no ffmpeg");
            return;
        }
        let dir = tempdir().unwrap();
        let video = dir.path().join("steady.mp4");
        let gen = StdCommand::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=white:s=160x90:d=3",
                "-vf",
                "drawbox=w=80:h=90:color=black:t=fill",
            ])
            .arg(&video)
            .output()
            .expect("ffmpeg gen");
        assert!(gen.status.success(), "gen failed: {gen:?}");

        let frames = extract_slides(
            &video,
            dir.path(),
            ExtractOptions::default(),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].start_ms, 0);
        assert!(Path::new(&frames[0].image_path).is_file());
    }

    /// 用 ffprobe 读一张图的尺寸，验证黑边是不是真被裁掉了。
    fn image_dims(path: &Path) -> (i64, i64) {
        let out = StdCommand::new("ffprobe")
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=p=0",
            ])
            .arg(path)
            .output()
            .expect("ffprobe");
        let text = String::from_utf8_lossy(&out.stdout);
        let mut parts = text.trim().split(',');
        let width = parts.next().unwrap().parse().unwrap();
        let height = parts.next().unwrap().parse().unwrap();
        (width, height)
    }

    #[tokio::test]
    async fn crops_black_bars_out_of_the_saved_slide_images() {
        if which::which("ffmpeg").is_err() || which::which("ffprobe").is_err() {
            eprintln!("skipping: no ffmpeg/ffprobe");
            return;
        }
        let dir = tempdir().unwrap();
        let video = dir.path().join("letterbox.mp4");
        // 上下各 18/90 的黑边，内容在中间 54 高的带子里；换页时白块从左半移到右半。
        let band = |x: i64| format!("drawbox=x={x}:y=18:w=80:h=54:color=white:t=fill");
        let gen = StdCommand::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=160x90:d=2",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=160x90:d=2",
                "-filter_complex",
                &format!(
                    "[0:v]{}[a];[1:v]{}[b];[a][b]concat=n=2:v=1:a=0",
                    band(0),
                    band(80)
                ),
            ])
            .arg(&video)
            .output()
            .expect("ffmpeg gen");
        assert!(gen.status.success(), "gen failed: {gen:?}");

        let insets = CropInsets {
            top: 0.2,
            right: 0.0,
            bottom: 0.2,
            left: 0.0,
        };
        let cropped = extract_slides(
            &video,
            &dir.path().join("cropped"),
            ExtractOptions {
                crop: Some(insets),
                ..Default::default()
            },
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap();
        assert!(cropped.len() >= 2, "got {} pages", cropped.len());
        // 存下来的课件图不该再带黑边：90 高裁掉上下各 20% 剩 54。
        assert_eq!(image_dims(Path::new(&cropped[0].image_path)), (160, 54));

        // 不裁时仍是整幅，两者的差别就是这次改动。
        let whole = extract_slides(
            &video,
            &dir.path().join("whole"),
            ExtractOptions::default(),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap();
        assert_eq!(image_dims(Path::new(&whole[0].image_path)), (160, 90));
    }

    #[tokio::test]
    async fn extraction_stops_when_cancelled() {
        if which::which("ffmpeg").is_err() {
            eprintln!("skipping: no ffmpeg");
            return;
        }
        let dir = tempdir().unwrap();
        let video = dir.path().join("cancel.mp4");
        let gen = StdCommand::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=white:s=160x90:d=3",
                "-vf",
                "drawbox=w=80:h=90:color=black:t=fill",
            ])
            .arg(&video)
            .output()
            .expect("ffmpeg gen");
        assert!(gen.status.success(), "gen failed: {gen:?}");

        // 已置位的取消标志：采样一开始就该停下，不写任何图。
        let error = extract_slides(
            &video,
            dir.path(),
            ExtractOptions::default(),
            &AtomicBool::new(true),
            &mut |_| {},
        )
        .await
        .expect_err("cancelled extraction should fail");
        assert!(error.to_string().contains("取消"), "got {error}");
    }

    #[tokio::test]
    async fn store_slides_rolls_back_the_whole_replacement_on_insert_failure() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        let course = crate::commands::courses::create_course(
            &db,
            "c".into(),
            dir.path().to_string_lossy().into(),
        )
        .await
        .unwrap();
        let video_path = dir.path().join("v.mp4");
        std::fs::write(&video_path, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, video_path, None)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO slides(video_id,image_path,start_ms,end_ms,page_no)
             VALUES (?,?,?,?,?)",
        )
        .bind(&video.id)
        .bind("old.jpg")
        .bind(0_i64)
        .bind(None::<i64>)
        .bind(0_i64)
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TRIGGER fail_second_slide BEFORE INSERT ON slides
             WHEN NEW.page_no=1 BEGIN SELECT RAISE(ABORT, 'test failure'); END",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        let replacement = vec![
            SlideFrame {
                page_no: 0,
                image_path: "new-1.jpg".into(),
                start_ms: 0,
            },
            SlideFrame {
                page_no: 1,
                image_path: "new-2.jpg".into(),
                start_ms: 1_000,
            },
        ];

        assert!(store_slides(&db, &video.id, &replacement).await.is_err());
        let paths: Vec<String> =
            sqlx::query_scalar("SELECT image_path FROM slides WHERE video_id=? ORDER BY page_no")
                .bind(&video.id)
                .fetch_all(&db.pool)
                .await
                .unwrap();
        assert_eq!(paths, vec!["old.jpg"]);
    }

    #[tokio::test]
    async fn captures_single_frame() {
        if which::which("ffmpeg").is_err() {
            eprintln!("skipping: no ffmpeg");
            return;
        }
        let dir = tempdir().unwrap();
        let video = dir.path().join("in.mp4");
        let gen = StdCommand::new("ffmpeg")
            .args(["-y", "-f", "lavfi", "-i", "color=c=blue:s=160x90:d=2"])
            .arg(&video)
            .output()
            .expect("gen");
        assert!(gen.status.success());
        let shot = capture_frame(&video, dir.path(), 1000).await.unwrap();
        assert!(shot.is_file());
    }
}
