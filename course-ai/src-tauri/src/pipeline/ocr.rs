//! 截字 OCR：ffmpeg 截（可裁剪）帧 → tesseract 识别。
//!
//! 运行时需要 `tesseract`（含 `chi_sim` 语言包）。当前沙箱未安装，故 run_ocr
//! 在缺二进制时返回明确错误；arg 构造为纯函数，单测覆盖。

use crate::error::{AppError, AppResult};
#[cfg(not(target_os = "android"))]
use crate::sidecar::{resolve, FFMPEG, TESSERACT};
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "android"))]
use tokio::process::Command;

/// 像素矩形；w 或 h 为 0 表示整帧。
#[derive(Debug, Clone, Copy)]
pub struct Rect {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

/// 构造 tesseract 命令参数：`<image> stdout -l <langs>`。
pub fn build_tesseract_args(image: &str, langs: &str) -> Vec<String> {
    vec![
        image.to_string(),
        "stdout".to_string(),
        "-l".to_string(),
        langs.to_string(),
    ]
}

/// 构造 ffmpeg 截帧（可选裁剪）的 vf 值；整帧时返回 None。
pub fn build_crop_vf(rect: Rect) -> Option<String> {
    if rect.w > 0 && rect.h > 0 {
        Some(format!("crop={}:{}:{}:{}", rect.w, rect.h, rect.x, rect.y))
    } else {
        None
    }
}

/// 截取视频某时刻的（可选裁剪）帧为 PNG，供本地或云端 OCR 复用。
#[cfg(target_os = "android")]
pub async fn grab_frame(
    video: &Path,
    out_dir: &Path,
    at_ms: i64,
    rect: Rect,
) -> AppResult<PathBuf> {
    if build_crop_vf(rect).is_some() {
        return Err(AppError::Config("移动端截图 OCR 暂不支持区域裁剪".into()));
    }
    crate::pipeline::slides::capture_frame(video, out_dir, at_ms).await
}

/// 截取视频某时刻的（可选）帧为 PNG，供本地或云端 OCR 复用。
#[cfg(not(target_os = "android"))]
pub async fn grab_frame(
    video: &Path,
    out_dir: &Path,
    at_ms: i64,
    rect: Rect,
) -> AppResult<PathBuf> {
    std::fs::create_dir_all(out_dir)?;
    let out = out_dir.join(format!("ocr_{at_ms}.png"));
    let seconds = at_ms as f64 / 1000.0;
    let ffmpeg = resolve(&FFMPEG, None)?;
    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-y", "-ss", &format!("{seconds}"), "-i"])
        .arg(video)
        .args(["-frames:v", "1"]);
    if let Some(vf) = build_crop_vf(rect) {
        cmd.args(["-vf", &vf]);
    }
    cmd.arg(&out);
    let status = cmd
        .status()
        .await
        .map_err(|e| AppError::Pipeline(format!("ffmpeg spawn: {e}")))?;
    if !status.success() {
        return Err(AppError::Pipeline(format!(
            "ffmpeg ocr frame failed: {status}"
        )));
    }
    Ok(out)
}

#[cfg(target_os = "android")]
pub async fn run_ocr(
    _video: &Path,
    _out_dir: &Path,
    _at_ms: i64,
    _rect: Rect,
    _langs: &str,
) -> AppResult<String> {
    Err(AppError::Config(
        "移动端本地 Tesseract OCR 不可用，请在设置中选择阿里云 OCR".into(),
    ))
}

#[cfg(not(target_os = "android"))]
pub async fn run_ocr(
    video: &Path,
    out_dir: &Path,
    at_ms: i64,
    rect: Rect,
    langs: &str,
) -> AppResult<String> {
    let image = grab_frame(video, out_dir, at_ms, rect).await?;
    let tesseract = resolve(&TESSERACT, None)?;
    let args = build_tesseract_args(&image.to_string_lossy(), langs);
    let output = Command::new(&tesseract)
        .args(&args)
        .output()
        .await
        .map_err(|e| AppError::Pipeline(format!("tesseract spawn: {e}")))?;
    if !output.status.success() {
        return Err(AppError::Pipeline(format!(
            "tesseract failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tesseract_args_have_stdout_and_lang() {
        let args = build_tesseract_args("/tmp/a.png", "chi_sim+eng");
        assert_eq!(args, vec!["/tmp/a.png", "stdout", "-l", "chi_sim+eng"]);
    }

    #[test]
    fn crop_vf_only_when_sized() {
        assert_eq!(
            build_crop_vf(Rect {
                x: 10,
                y: 20,
                w: 100,
                h: 50
            }),
            Some("crop=100:50:10:20".into())
        );
        assert_eq!(
            build_crop_vf(Rect {
                x: 0,
                y: 0,
                w: 0,
                h: 0
            }),
            None
        );
    }
}
