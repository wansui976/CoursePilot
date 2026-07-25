//! 截字 OCR：ffmpeg 截（可裁剪）帧 → tesseract 识别。
//!
//! 运行时需要 `tesseract`（含 `chi_sim` 语言包）。当前沙箱未安装，故 run_ocr
//! 在缺二进制时返回明确错误；arg 构造为纯函数，单测覆盖。

use crate::error::{AppError, AppResult};
#[cfg(not(target_os = "android"))]
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::sidecar::{resolve, FFMPEG, TESSERACT};
use std::path::{Path, PathBuf};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
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
#[cfg(not(any(target_os = "android", target_os = "ios")))]
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

#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn run_ocr(
    _video: &Path,
    _out_dir: &Path,
    _at_ms: i64,
    _rect: Rect,
    _langs: &str,
) -> AppResult<String> {
    Err(AppError::Config(
        "移动端 OCR 暂不可用，请先在桌面端完成截字".into(),
    ))
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn grab_frame(
    _video: &Path,
    _out_dir: &Path,
    _at_ms: i64,
    _rect: Rect,
) -> AppResult<PathBuf> {
    Err(AppError::Config("移动端不支持本地 ffmpeg 截帧".into()))
}

/// 对一张已落地的图片跑本地 tesseract。课件页 OCR 直接认已有的页图，不必重新截帧。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn run_ocr_on_image(image: &Path, langs: &str) -> AppResult<String> {
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

#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn run_ocr_on_image(_image: &Path, _langs: &str) -> AppResult<String> {
    Err(AppError::Config("移动端暂不支持本地 OCR".into()))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn run_ocr(
    video: &Path,
    out_dir: &Path,
    at_ms: i64,
    rect: Rect,
    langs: &str,
) -> AppResult<String> {
    let image = grab_frame(video, out_dir, at_ms, rect).await?;
    run_ocr_on_image(&image, langs).await
}

// 判废用的最低要求：去掉空白后至少这么多字符，且有效字符（中日韩/字母数字/常见标点）
// 占比不低于这个比例。中文幻灯片走本地 tesseract 时公式和艺术字常出乱码，
// 乱码进了 AI 背景比没有更糟——模型会照着乱码编术语，所以宁可整页丢掉。
const OCR_MIN_CHARS: usize = 4;
const OCR_MIN_VALID_RATIO: f64 = 0.6;

/// 一个字符是否算「像正常文本」。
fn is_meaningful_char(ch: char) -> bool {
    ch.is_alphanumeric()
        || matches!(
            ch,
            '，' | '。'
                | '、'
                | '：'
                | '；'
                | '？'
                | '！'
                | '（'
                | '）'
                | '《'
                | '》'
                | '“'
                | '”'
                | '·'
                | '—'
                | '%'
                | '.'
                | ','
                | ':'
                | ';'
                | '?'
                | '!'
                | '('
                | ')'
                | '['
                | ']'
                | '+'
                | '-'
                | '='
                | '/'
                | '<'
                | '>'
                | '*'
                | '&'
                | '#'
                | '\''
                | '"'
        )
}

/// OCR 结果是否值得留下。纯函数，可单测。
pub fn ocr_text_is_usable(text: &str) -> bool {
    let visible: Vec<char> = text.chars().filter(|ch| !ch.is_whitespace()).collect();
    if visible.len() < OCR_MIN_CHARS {
        return false;
    }
    let meaningful = visible
        .iter()
        .copied()
        .filter(|ch| is_meaningful_char(*ch))
        .count();
    meaningful as f64 / visible.len() as f64 >= OCR_MIN_VALID_RATIO
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ocr_quality_gate_keeps_text_and_drops_junk() {
        assert!(ocr_text_is_usable("贝叶斯定理：P(A|B) = P(B|A)P(A)/P(B)"));
        assert!(ocr_text_is_usable("Chapter 2 — Bayes' rule"));
        // 太短：一两个字符没有价值。
        assert!(!ocr_text_is_usable("。"));
        assert!(!ocr_text_is_usable("   \n  "));
        // 乱码：进了 AI 背景比没有更糟，模型会照着乱码编术语。
        assert!(!ocr_text_is_usable("§¥«»~^`|\\@¤¶"));
    }

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
