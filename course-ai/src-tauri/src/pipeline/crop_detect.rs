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

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CropInsets {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// 跑 ffmpeg cropdetect 采样一段，解析出四边黑边占比；无黑边/失败返回 None。
pub async fn detect_crop(path: &Path) -> Option<CropInsets> {
    let ffmpeg = resolve(&FFMPEG, None).ok()?;
    let output = Command::new(&ffmpeg)
        .kill_on_drop(true)
        // 跳过前 3s 片头，采样 60s；cropdetect 累积包围盒；null 输出不落地、不编码。
        .args(["-hide_banner", "-nostats", "-ss", "3", "-t", "60", "-i"])
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
    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_cropdetect(&stderr)
}

/// 探测并写库（尽力而为：失败/无黑边都静默跳过）。返回探测到的 insets 供调用方回填。
pub async fn detect_and_store_crop(
    db: &crate::db::Db,
    video_id: &str,
    path: PathBuf,
) -> Option<CropInsets> {
    let insets = detect_crop(&path).await?;
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
    Some(insets)
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

/// 解析 cropdetect 输出 → 四边占比。无有意义黑边返回 None。
pub fn parse_cropdetect(stderr: &str) -> Option<CropInsets> {
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
    let insets = CropInsets {
        top: clamp(top),
        right: clamp(right),
        bottom: clamp(bottom),
        left: clamp(left),
    };
    let max = insets
        .top
        .max(insets.right)
        .max(insets.bottom)
        .max(insets.left);
    // 黑边不足 1% 视为无（避免编码边缘的 1~2px 抖动）。
    if max < 0.01 {
        None
    } else {
        Some(insets)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_DIMS: &str =
        "  Stream #0:0(und): Video: h264 (High), yuv420p, 1920x1080, 2500 kb/s, 25 fps\n";

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
