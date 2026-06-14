use crate::db::Db;
use crate::error::{AppError, AppResult};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::sidecar::{resolve, FFMPEG};
use serde::Serialize;
use std::path::{Path, PathBuf};
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

// 抽帧分析参数。把视频降到很小的灰度帧来比对换页，既快又抗噪。
// 桌面端用 ffmpeg 生成低分辨率帧；Android 用原生 MediaMetadataRetriever 生成同尺寸亮度帧。
const SAMPLE_W: usize = 128;
const SAMPLE_H: usize = 72;
const SAMPLE_FPS: i64 = 1; // 每秒采 1 帧
const SAMPLE_INTERVAL_MS: i64 = 1000 / SAMPLE_FPS;
// 亮度 RMS 差阈值的上下限（0~255 量纲）。动态阈值取相邻差的中位数后钳到这区间：
// 静态讲义中位数通常很小→落到下限 10，能滤掉光标/噪声；动态内容则自动抬高。
const THRESHOLD_MIN: f64 = 10.0;
const THRESHOLD_MAX: f64 = 60.0;

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

/// 两帧亮度的均方根差（RMS）。
fn rms_diff(a: &[u8], b: &[u8]) -> f64 {
    if a.is_empty() {
        return 0.0;
    }
    let sum: f64 = a
        .iter()
        .zip(b.iter())
        .map(|(x, y)| {
            let d = *x as f64 - *y as f64;
            d * d
        })
        .sum();
    (sum / a.len() as f64).sqrt()
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
#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn sample_luma_frames(video: &Path) -> AppResult<Vec<Vec<u8>>> {
    let ffmpeg = resolve(&FFMPEG, None)?;
    let mut child = Command::new(&ffmpeg)
        .args(["-hide_banner", "-nostdin", "-i"])
        .arg(video)
        .args([
            "-vf",
            &format!("fps={SAMPLE_FPS},scale={SAMPLE_W}:{SAMPLE_H}"),
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
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
        match stdout.read_exact(&mut buf).await {
            Ok(_) => frames.push(luminance_frame(&buf)),
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(AppError::Pipeline(format!("ffmpeg read: {e}"))),
        }
    }
    let _ = child.wait().await;
    Ok(frames)
}

/// 算出每个换页所在的采样帧下标。第 0 帧永远是第一页；之后某帧相对上一帧的亮度 RMS
/// 差超过阈值、且与"上一张已保存页"也明显不同（去重渐变/动画回弹），才算新的一页。
pub fn detect_slide_indices(frames: &[Vec<u8>], threshold: f64) -> Vec<usize> {
    if frames.is_empty() {
        return Vec::new();
    }
    let mut starts = vec![0usize];
    let mut last = 0usize;
    for i in 1..frames.len() {
        let changed = rms_diff(&frames[i - 1], &frames[i]) > threshold;
        if changed && rms_diff(&frames[last], &frames[i]) > threshold {
            starts.push(i);
            last = i;
        }
    }
    starts
}

/// 动态阈值：相邻帧亮度差的中位数，钳到 [THRESHOLD_MIN, THRESHOLD_MAX]。
pub fn dynamic_threshold(frames: &[Vec<u8>]) -> f64 {
    let diffs: Vec<f64> = frames.windows(2).map(|w| rms_diff(&w[0], &w[1])).collect();
    median(diffs).clamp(THRESHOLD_MIN, THRESHOLD_MAX)
}

#[cfg(target_os = "android")]
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
                    "android luma frame decode: invalid base64 byte {byte}"
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

#[cfg(target_os = "android")]
async fn sample_android_luma_frames(video: &Path) -> AppResult<(Vec<Vec<u8>>, i64)> {
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
                "android luma frame size mismatch: expected {expected}, got {}",
                frame.len()
            )));
        }
        frames.push(frame);
    }
    Ok((frames, response.interval_ms))
}

/// Android：用原生 MediaMetadataRetriever 截一帧落地 JPEG（无 ffmpeg）。
#[cfg(target_os = "android")]
async fn capture_jpeg_at(video: &Path, out: &Path, at_ms: i64) -> AppResult<()> {
    crate::mobile_files::export_frame_jpeg(
        video.to_string_lossy().to_string(),
        at_ms,
        out.to_string_lossy().to_string(),
    )
    .await
    .map(|_| ())
    .map_err(AppError::Pipeline)
}

/// iOS：用原生 AVAssetImageGenerator 截一帧落地 JPEG（无 ffmpeg）。
#[cfg(target_os = "ios")]
async fn capture_jpeg_at(video: &Path, out: &Path, at_ms: i64) -> AppResult<()> {
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
async fn capture_jpeg_at(video: &Path, out: &Path, at_ms: i64) -> AppResult<()> {
    let seconds = at_ms as f64 / 1000.0;
    let ffmpeg = resolve(&FFMPEG, None)?;
    let output = Command::new(&ffmpeg)
        .args([
            "-hide_banner",
            "-nostdin",
            "-y",
            "-ss",
            &format!("{seconds}"),
            "-i",
        ])
        .arg(video)
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

/// Android：用原生低分辨率亮度抽帧 + 共享换页检测算法提取课件页。
#[cfg(target_os = "android")]
pub async fn extract_slides(
    video: &Path,
    out_dir: &Path,
    threshold_override: Option<f64>,
) -> AppResult<Vec<SlideFrame>> {
    let slides_dir = out_dir.join("slides");
    let _ = std::fs::remove_dir_all(&slides_dir);
    std::fs::create_dir_all(&slides_dir)?;

    let (frames, interval_ms) = sample_android_luma_frames(video).await?;
    if frames.is_empty() {
        let fallback = slides_dir.join("0001.jpg");
        capture_jpeg_at(video, &fallback, 0).await?;
        return Ok(vec![SlideFrame {
            page_no: 0,
            image_path: fallback.to_string_lossy().to_string(),
            start_ms: 0,
        }]);
    }

    let threshold = threshold_override.unwrap_or_else(|| dynamic_threshold(&frames));
    let indices = detect_slide_indices(&frames, threshold);
    let mut out = Vec::new();
    for (page, &idx) in indices.iter().enumerate() {
        let start_ms = idx as i64 * interval_ms;
        let image = slides_dir.join(format!("{:04}.jpg", page + 1));
        capture_jpeg_at(video, &image, start_ms).await?;
        out.push(SlideFrame {
            page_no: page as i64,
            image_path: image.to_string_lossy().to_string(),
            start_ms,
        });
    }
    Ok(out)
}

/// 抽课件页：降采样灰度帧 → 亮度 RMS 差 + 动态阈值找换页点 → 为每页截一张全分辨率图。
/// `threshold_override` 给定时直接用作亮度阈值（0~255 量纲），否则按视频内容自适应。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn extract_slides(
    video: &Path,
    out_dir: &Path,
    threshold_override: Option<f64>,
) -> AppResult<Vec<SlideFrame>> {
    let slides_dir = out_dir.join("slides");
    // 清掉旧图，避免页数变少时残留上次的多余图片。
    let _ = std::fs::remove_dir_all(&slides_dir);
    std::fs::create_dir_all(&slides_dir)?;

    let frames = sample_luma_frames(video).await?;
    if frames.is_empty() {
        let fallback = slides_dir.join("0001.jpg");
        capture_jpeg_at(video, &fallback, 0).await?;
        return Ok(vec![SlideFrame {
            page_no: 0,
            image_path: fallback.to_string_lossy().to_string(),
            start_ms: 0,
        }]);
    }

    let threshold = threshold_override.unwrap_or_else(|| dynamic_threshold(&frames));
    let indices = detect_slide_indices(&frames, threshold);

    let mut out = Vec::new();
    for (page, &idx) in indices.iter().enumerate() {
        let start_ms = idx as i64 * SAMPLE_INTERVAL_MS;
        let image = slides_dir.join(format!("{:04}.jpg", page + 1));
        capture_jpeg_at(video, &image, start_ms).await?;
        out.push(SlideFrame {
            page_no: page as i64,
            image_path: image.to_string_lossy().to_string(),
            start_ms,
        });
    }
    Ok(out)
}

#[cfg(target_os = "ios")]
pub async fn extract_slides(
    _video: &Path,
    _out_dir: &Path,
    _threshold_override: Option<f64>,
) -> AppResult<Vec<SlideFrame>> {
    Err(AppError::Config("移动端暂不支持课件自动抽取".into()))
}

pub async fn store_slides(db: &Db, video_id: &str, frames: &[SlideFrame]) -> AppResult<usize> {
    sqlx::query("DELETE FROM slides WHERE video_id=?")
        .bind(video_id)
        .execute(&db.pool)
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
        .execute(&db.pool)
        .await?;
    }
    Ok(frames.len())
}

/// 取视频首帧作为封面，缓存到 data_dir/cover.jpg；已存在则直接返回。
pub async fn ensure_cover(video: &Path, data_dir: &Path) -> AppResult<PathBuf> {
    std::fs::create_dir_all(data_dir)?;
    let cover = data_dir.join("cover.jpg");
    if !cover.is_file() {
        // 取第 1 秒，避开纯黑片头；极短视频则回退到首帧。
        if capture_jpeg_at(video, &cover, 1000).await.is_err() {
            capture_jpeg_at(video, &cover, 0).await?;
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
    capture_jpeg_at(video, &out, at_ms).await?;
    Ok(out)
}

#[cfg(target_os = "ios")]
pub async fn capture_frame(
    _video: &Path,
    _out_dir: &Path,
    _at_ms: i64,
) -> AppResult<PathBuf> {
    Err(AppError::Config("移动端暂不支持课件截图".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;
    use tempfile::tempdir;

    fn solid(value: u8) -> Vec<u8> {
        vec![value; SAMPLE_W * SAMPLE_H]
    }

    #[test]
    fn luminance_uses_rec709_weights() {
        // 纯绿权重最大。
        let green = luminance_frame(&[0, 255, 0]);
        assert_eq!(green[0], (0.7152_f64 * 255.0).round() as u8);
    }

    #[test]
    fn rms_diff_zero_for_identical_and_positive_for_different() {
        let a = solid(40);
        assert_eq!(rms_diff(&a, &a), 0.0);
        let b = solid(60);
        assert!((rms_diff(&a, &b) - 20.0).abs() < 1e-9);
    }

    #[test]
    fn detects_each_distinct_page_once() {
        // 三张明显不同的页，中间各夹一张"稳定后的同页"——不应重复计数。
        let frames = vec![solid(10), solid(10), solid(120), solid(120), solid(230)];
        let starts = detect_slide_indices(&frames, 15.0);
        // 起点：0(第一页)、2(跳到120)、4(跳到230)。中间稳定帧不算。
        assert_eq!(starts, vec![0, 2, 4]);
    }

    #[test]
    fn steady_content_yields_single_page() {
        let frames = vec![solid(200), solid(200), solid(200)];
        let threshold = dynamic_threshold(&frames);
        assert_eq!(detect_slide_indices(&frames, threshold), vec![0]);
    }

    #[test]
    fn dynamic_threshold_clamps_to_floor_for_static_video() {
        let frames = vec![solid(128), solid(129), solid(128)]; // 几乎不变
        assert_eq!(dynamic_threshold(&frames), THRESHOLD_MIN);
    }

    #[tokio::test]
    async fn extracts_slides_from_color_changes() {
        if which::which("ffmpeg").is_err() {
            eprintln!("skipping: no ffmpeg");
            return;
        }
        let dir = tempdir().unwrap();
        let video = dir.path().join("in.mp4");
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
                "[0:v][1:v][2:v]concat=n=3:v=1:a=0",
            ])
            .arg(&video)
            .output()
            .expect("ffmpeg gen");
        assert!(gen.status.success(), "gen failed: {gen:?}");

        let frames = extract_slides(&video, dir.path(), None).await.unwrap();
        // 红/绿/蓝三段，应至少抽出多于一页且每页图片落地。
        assert!(
            frames.len() >= 2,
            "expected multiple pages, got {}",
            frames.len()
        );
        assert!(Path::new(&frames[0].image_path).is_file());

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
            .args(["-y", "-f", "lavfi", "-i", "color=c=white:s=160x90:d=2"])
            .arg(&video)
            .output()
            .expect("ffmpeg gen");
        assert!(gen.status.success(), "gen failed: {gen:?}");

        let frames = extract_slides(&video, dir.path(), None).await.unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].start_ms, 0);
        assert!(Path::new(&frames[0].image_path).is_file());
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
