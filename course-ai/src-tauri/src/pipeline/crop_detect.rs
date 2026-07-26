//! 用 ffmpeg `cropdetect` 探测视频自带的黑边（letterbox/pillarbox），
//! 换算成四边占比 insets 存库，供播放器做非破坏式显示裁剪。
//!
//! cropdetect 在一段时间窗内累积「非黑包围盒」，天然保守——只要某帧某处不是黑，
//! 该区域就不会被裁，因此不会误切真实内容。我们采样视频靠前的一段（跳过片头），
//! 取最后一个稳定的 `crop=W:H:X:Y`，再按整帧分辨率换成比例。比例与像素纵横比（SAR）
//! 无关，前端直接套到显示框上即可。

use crate::sidecar::{resolve, FFMPEG};
use std::path::{Path, PathBuf};
use tokio::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct CropInsets {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// 无黑边（也用作「已探测、无黑边」的写库标记值）。
pub const NO_CROP: CropInsets = CropInsets {
    top: 0.0,
    right: 0.0,
    bottom: 0.0,
    left: 0.0,
};

/// 跑一遍 ffmpeg cropdetect，返回 stderr 文本；**spawn 失败返回 None**（区分「跑过」与「没跑成」）。
async fn run_cropdetect(path: &Path, at_s: i64, window_s: i64) -> Option<String> {
    let ffmpeg = resolve(&FFMPEG, None).ok()?;
    let output = Command::new(&ffmpeg)
        .kill_on_drop(true)
        // cropdetect 在窗口内累积包围盒；null 输出不落地、不编码。
        .args([
            "-hide_banner",
            "-nostats",
            "-ss",
            &at_s.to_string(),
            "-t",
            &window_s.to_string(),
            "-i",
        ])
        .arg(path)
        .args([
            "-vf",
            "cropdetect=limit=24:round=2:reset=0",
            "-an",
            "-f",
            "null",
            "-",
        ])
        .output()
        .await
        .ok()?;
    Some(String::from_utf8_lossy(&output.stderr).into_owned())
}

/// 跑 cropdetect 并解析出四边黑边占比；无黑边/失败返回 None。
pub async fn detect_crop(path: &Path) -> Option<CropInsets> {
    let samples = sample_insets(path).await?;
    merge_samples(&samples)
}

/// 采样正片多处，返回各处测到的包围盒。
///
/// 只看开头那一段是不够的：课程录像的片头常和正片取景不同（标题卡、片花、
/// 全屏欢迎页），照着片头的黑边去裁，正片的真实画面就被削掉一条。
async fn sample_insets(path: &Path) -> Option<Vec<CropInsets>> {
    let first = run_cropdetect(path, 3, 30).await?;
    let mut samples = Vec::new();
    if let Some(insets) = measure_sample(&first) {
        samples.push(insets);
    }
    for at_s in extra_offsets(parse_duration_ms(&first)) {
        let Some(stderr) = run_cropdetect(path, at_s, 20).await else {
            continue;
        };
        if let Some(insets) = measure_sample(&stderr) {
            samples.push(insets);
        }
    }
    Some(samples)
}

/// 除开头之外还该采样哪几处（秒）。太短的视频没有中后段可采，就只看开头。
pub fn extra_offsets(duration_ms: Option<i64>) -> Vec<i64> {
    let Some(duration_s) = duration_ms.map(|ms| ms / 1000) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if duration_s > 120 {
        out.push(duration_s * 40 / 100);
    }
    if duration_s > 300 {
        out.push(duration_s * 75 / 100);
    }
    out
}

/// 从 ffmpeg 头部信息里读片长（`Duration: 00:12:34.56`）。
/// cropdetect 那一趟本来就打了这行，不必再单独跑一次 ffprobe。
pub fn parse_duration_ms(stderr: &str) -> Option<i64> {
    let rest = stderr.split("Duration:").nth(1)?;
    let token = rest.trim_start().split(',').next()?.trim();
    let mut parts = token.split(':');
    let hours: i64 = parts.next()?.trim().parse().ok()?;
    let minutes: i64 = parts.next()?.trim().parse().ok()?;
    let seconds: f64 = parts.next()?.trim().parse().ok()?;
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    Some(((hours * 3600 + minutes * 60) as f64 + seconds).round() as i64 * 1000)
}

/// 合并多处采样：每边取最小值，等于「所有采样都同意这条边是黑的才裁」。
/// 只会裁得更少，不会更多——过裁才是会吃掉画面的那一侧错误。
pub fn merge_samples(samples: &[CropInsets]) -> Option<CropInsets> {
    let mut merged = *samples.first()?;
    for sample in &samples[1..] {
        merged.top = merged.top.min(sample.top);
        merged.right = merged.right.min(sample.right);
        merged.bottom = merged.bottom.min(sample.bottom);
        merged.left = merged.left.min(sample.left);
    }
    meaningful(merged)
}

/// 探测并写库，返回 insets（无黑边为 0）。
///
/// 只要 ffmpeg **跑过**（无论是否检出黑边）就写库——无黑边写 0，把该视频标记为「已探测」，
/// 避免每次打开都重跑。仅当 ffmpeg 没跑成（spawn 失败）时不写库（保持 NULL，下次再试）。
pub async fn ensure_crop(db: &crate::db::Db, video_id: &str, path: PathBuf) -> CropInsets {
    let Some(samples) = sample_insets(&path).await else {
        return NO_CROP;
    };
    let insets = merge_samples(&samples).unwrap_or(NO_CROP);
    let _ = sqlx::query(
        "UPDATE videos SET crop_top=?,crop_right=?,crop_bottom=?,crop_left=? WHERE id=?",
    )
    .bind(insets.top)
    .bind(insets.right)
    .bind(insets.bottom)
    .bind(insets.left)
    .bind(video_id)
    .execute(&db.pool)
    .await;
    insets
}

/// 从 ffmpeg stderr 里找整帧分辨率（"Video: ... WxH"）。
fn parse_dims(stderr: &str) -> Option<(i64, i64)> {
    for line in stderr.lines() {
        let Some(idx) = line.find("Video:") else {
            continue;
        };
        for tok in line[idx..].split(|c: char| c == ',' || c.is_whitespace()) {
            if let Some((a, b)) = tok.split_once('x') {
                if let (Ok(w), Ok(h)) = (a.parse::<i64>(), b.parse::<i64>()) {
                    if w > 0 && h > 0 {
                        return Some((w, h));
                    }
                }
            }
        }
    }
    None
}

/// 取最后一个 `crop=W:H:X:Y`（cropdetect 越往后越稳定）。
fn parse_last_crop(stderr: &str) -> Option<(i64, i64, i64, i64)> {
    let mut last = None;
    let mut rest = stderr;
    while let Some(i) = rest.find("crop=") {
        let after = &rest[i + 5..];
        let tok: String = after
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == ':')
            .collect();
        let parts: Vec<i64> = tok.split(':').filter_map(|p| p.parse().ok()).collect();
        if parts.len() == 4 {
            last = Some((parts[0], parts[1], parts[2], parts[3]));
        }
        rest = after;
    }
    last
}

/// 单段采样的测量结果。
///
/// `None` 表示这段**没解出包围盒**（`-ss` 超出片长、解码失败），不该参与合并；
/// `Some(全 0)` 表示这段解出来了、就是没有黑边——这是反对裁剪的最强证据，
/// 必须参与合并，不能当作「没测到」丢掉。
fn measure_sample(stderr: &str) -> Option<CropInsets> {
    let (w, h) = parse_dims(stderr)?;
    let (cw, ch, cx, cy) = parse_last_crop(stderr)?;
    if cw <= 0 || ch <= 0 || cw > w || ch > h {
        return None;
    }
    let left = (cx.max(0) as f64) / (w as f64);
    let top = (cy.max(0) as f64) / (h as f64);
    let right = ((w - cx - cw).max(0) as f64) / (w as f64);
    let bottom = ((h - cy - ch).max(0) as f64) / (h as f64);

    // 单边超 45% 视为异常（整帧偏暗等）→ 该边不裁。
    let clamp = |v: f64| if v > 0.45 { 0.0 } else { v };
    Some(CropInsets {
        top: clamp(top),
        right: clamp(right),
        bottom: clamp(bottom),
        left: clamp(left),
    })
}

/// 黑边不足 1% 视为无（避免编码边缘的 1~2px 抖动）。
fn meaningful(insets: CropInsets) -> Option<CropInsets> {
    let max = insets
        .top
        .max(insets.right)
        .max(insets.bottom)
        .max(insets.left);
    if max < 0.01 {
        None
    } else {
        Some(insets)
    }
}

/// 解析 cropdetect 输出 → 四边占比。无有意义黑边返回 None。
pub fn parse_cropdetect(stderr: &str) -> Option<CropInsets> {
    meaningful(measure_sample(stderr)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_DIMS: &str =
        "  Stream #0:0(und): Video: h264 (High), yuv420p, 1920x1080, 2500 kb/s, 25 fps\n";

    #[test]
    fn merging_samples_never_crops_more_than_the_least_black_one() {
        // 片头是 4:3 加左右黑边的标题卡，正片其实是满屏（或黑边窄得多）。
        // 只看片头就会照着 12.5% 去裁，正片左右各被削掉一条真实画面。
        let intro = CropInsets {
            top: 0.0,
            right: 0.125,
            bottom: 0.0,
            left: 0.125,
        };
        let body = CropInsets {
            top: 0.0,
            right: 0.04,
            bottom: 0.0,
            left: 0.0,
        };
        let merged = merge_samples(&[intro, body]).unwrap();
        assert_eq!(merged.left, 0.0);
        assert_eq!(merged.right, 0.04);

        // 各处一致的真信箱黑边照旧保留。
        let letterbox = CropInsets {
            top: 0.13,
            right: 0.0,
            bottom: 0.13,
            left: 0.0,
        };
        assert_eq!(merge_samples(&[letterbox, letterbox]).unwrap(), letterbox);

        // 有一处明确「没有黑边」就不该裁——那是反对裁剪的最强证据。
        assert_eq!(merge_samples(&[letterbox, NO_CROP]), None);
        assert_eq!(merge_samples(&[]), None);
    }

    #[test]
    fn a_sample_with_no_bars_still_counts_as_a_measurement() {
        // 「解出包围盒 = 整帧」必须参与合并（Some(全 0)），不能和「这段没帧」混为一谈。
        let full_frame = format!("{SAMPLE_DIMS}[Parsed_cropdetect_0 @ 0x1] crop=1920:1080:0:0\n");
        assert_eq!(measure_sample(&full_frame), Some(NO_CROP));
        // 没有 crop= 行（-ss 超出片长）→ 这段没测到，不参与合并。
        assert_eq!(measure_sample(SAMPLE_DIMS), None);
    }

    #[test]
    fn reads_duration_from_the_ffmpeg_header() {
        let log = "  Duration: 00:47:12.34, start: 0.000000, bitrate: 1500 kb/s\n";
        assert_eq!(parse_duration_ms(log), Some(2_832_000));
        assert_eq!(parse_duration_ms(SAMPLE_DIMS), None);
        // 直播流等拿不到片长时不瞎猜，只看开头那段。
        assert_eq!(parse_duration_ms("  Duration: N/A, bitrate: N/A\n"), None);
    }

    #[test]
    fn extra_sample_points_scale_with_length() {
        // 太短的视频没有中后段可采。
        assert!(extra_offsets(Some(90_000)).is_empty());
        assert_eq!(extra_offsets(Some(200_000)), vec![80]);
        assert_eq!(extra_offsets(Some(3_600_000)), vec![1_440, 2_700]);
        assert!(extra_offsets(None).is_empty());
    }

    #[test]
    fn parses_letterbox_top_bottom() {
        let log = format!(
            "{SAMPLE_DIMS}\
             [Parsed_cropdetect_0 @ 0x1] x1:0 x2:1919 y1:140 y2:939 crop=1920:800:0:140\n\
             [Parsed_cropdetect_0 @ 0x1] x1:0 x2:1919 y1:140 y2:939 crop=1920:800:0:140\n"
        );
        let insets = parse_cropdetect(&log).unwrap();
        assert!((insets.top - 140.0 / 1080.0).abs() < 1e-6);
        assert!((insets.bottom - 140.0 / 1080.0).abs() < 1e-6);
        assert_eq!(insets.left, 0.0);
        assert_eq!(insets.right, 0.0);
    }

    #[test]
    fn parses_pillarbox_left_right() {
        let log = format!("{SAMPLE_DIMS}[Parsed_cropdetect_0 @ 0x1] crop=1440:1080:240:0\n");
        let insets = parse_cropdetect(&log).unwrap();
        assert!((insets.left - 240.0 / 1920.0).abs() < 1e-6);
        assert!((insets.right - 240.0 / 1920.0).abs() < 1e-6);
        assert_eq!(insets.top, 0.0);
        assert_eq!(insets.bottom, 0.0);
    }

    #[test]
    fn full_frame_crop_is_no_bars() {
        let log = format!("{SAMPLE_DIMS}[Parsed_cropdetect_0 @ 0x1] crop=1920:1080:0:0\n");
        assert_eq!(parse_cropdetect(&log), None);
    }

    #[test]
    fn no_crop_line_is_none() {
        assert_eq!(parse_cropdetect(SAMPLE_DIMS), None);
    }

    #[test]
    fn takes_the_last_crop_value() {
        let log = format!(
            "{SAMPLE_DIMS}\
             [cropdetect] crop=1920:1040:0:20\n\
             [cropdetect] crop=1920:800:0:140\n"
        );
        let insets = parse_cropdetect(&log).unwrap();
        assert!((insets.top - 140.0 / 1080.0).abs() < 1e-6);
    }
}
