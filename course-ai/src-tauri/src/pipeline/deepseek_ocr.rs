//! DeepSeek 视觉大模型 OCR 后端。
//!
//! 参考 https://api-docs.deepseek.com/zh-cn/guides/vision 。走 OpenAI 兼容的
//! `/chat/completions` 端点，图片以 base64 data URL 内联进 user 消息；
//! `deepseek-v4-flash-vision-exp` 是当前支持的视觉模型。
//! 与阿里云 OCR 一样，这是「引擎不可用则整批停」的路径，凭据缺失/鉴权失败应尽快报错。

use crate::error::{AppError, AppResult};
use base64::{engine::general_purpose, Engine as _};
use reqwest::header::CONTENT_TYPE;
use serde_json::{json, Value};

/// 默认视觉模型。
pub const DEFAULT_MODEL: &str = "deepseek-v4-flash-vision-exp";
/// DeepSeek OpenAI 兼容端点。`/chat/completions` 直接挂在根路径上。
pub const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";

/// 识别图片里的全部文字，按原文顺序逐行返回。
const OCR_PROMPT: &str = "请逐字识别这张图片中的全部文字，保持原有的换行与顺序，\
不要翻译，不要解释，不要输出任何多余内容，只输出识别到的文字本身。\
图片里没有文字时输出空内容。";

fn truncate(s: &str, max_chars: usize) -> String {
    let t: String = s.chars().take(max_chars).collect();
    if s.chars().count() > max_chars {
        format!("{t}…")
    } else {
        t
    }
}

/// 从图片字节里猜 MIME。DeepSeek 按文件实际内容判断格式，不依赖声明值，
/// 这里尽力猜一个一致的 data URL 前缀；猜不出来按 JPEG 处理（课件截图都是 JPG）。
fn detect_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "image/jpeg"
    }
}

/// 对一张图片做 DeepSeek 视觉识别，返回整段文本。
pub async fn run_deepseek_ocr(
    image: &[u8],
    api_key: &str,
    base_url: &str,
    model: &str,
) -> AppResult<String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(AppError::Config(
            "missing DeepSeek API Key：请在设置里填写 DeepSeek API Key".into(),
        ));
    }
    let model = if model.trim().is_empty() {
        DEFAULT_MODEL
    } else {
        model.trim()
    };
    let base_url = if base_url.trim().is_empty() {
        DEFAULT_BASE_URL
    } else {
        base_url.trim()
    };

    let mime = detect_mime(image);
    let b64 = general_purpose::STANDARD.encode(image);
    let data_url = format!("data:{mime};base64,{b64}");

    let body = json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": OCR_PROMPT },
                { "type": "image_url", "image_url": { "url": data_url } },
            ],
        }],
        "temperature": 0,
    });

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .bearer_auth(api_key)
        .header(CONTENT_TYPE, "application/json")
        .timeout(std::time::Duration::from_secs(120))
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Pipeline(format!("deepseek ocr request: {e}")))?;

    let status = resp.status();
    let raw = resp
        .text()
        .await
        .map_err(|e| AppError::Pipeline(format!("deepseek ocr read body: {e}")))?;
    let payload: Value = serde_json::from_str(&raw).map_err(|e| {
        AppError::Pipeline(format!(
            "deepseek ocr decode: {e}；原始响应：{}",
            truncate(&raw, 300)
        ))
    })?;

    if !status.is_success() {
        let truncated = truncate(&raw, 300);
        let message = payload["error"]["message"].as_str().unwrap_or(&truncated);
        let code = payload["error"]["code"].as_str().unwrap_or("");
        let hint = if matches!(status.as_u16(), 401 | 403) {
            "（鉴权/权限失败：请核对 DeepSeek API Key，并确认模型名支持图片输入）"
        } else if status.as_u16() == 400 {
            "（请求被拒绝：请核对模型名是否为视觉模型，图片是否超过大小限制）"
        } else {
            ""
        };
        let text = format!(
            "DeepSeek OCR 失败：{} {code} {message}{hint}",
            status.as_u16()
        );
        // 鉴权、余额这类是账号级问题：几十页逐一重试只是把同一个拒绝重复几十遍。
        // 标成「重试没用」，批量识别据此当场停下并把原因报出来。400（模型名不支持
        // 图片、图片超限）也是配置错误，重试没有意义，同样按「重试没用」处理。
        let account_level = matches!(status.as_u16(), 401..=403)
            || [
                "authentication",
                "permission",
                "unauthorized",
                "insufficient_balance",
                "insufficient_quota",
            ]
            .iter()
            .any(|marker| code.contains(marker));
        return Err(if account_level || status.as_u16() == 400 {
            AppError::Permanent(text)
        } else {
            AppError::Pipeline(text)
        });
    }

    let content = payload["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    if content.is_empty() {
        // 「调用成功、这页没有文字」是正常结果，不是错误：封面、纯图页、空白页本来就没字。
        // 以前的实现在这里报错会把整批判成引擎不可用而中止。
        tracing::debug!(response = %truncate(&raw, 600), "deepseek OCR 这一页没有文字");
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_mime_from_magic_bytes() {
        assert_eq!(detect_mime(&[0xff, 0xd8, 0xff, 0xe0]), "image/jpeg");
        assert_eq!(detect_mime(b"\x89PNG\r\n\x1a\n"), "image/png");
        assert_eq!(detect_mime(b"GIF89a"), "image/gif");
        let mut webp = vec![0u8; 20];
        webp[0..4].copy_from_slice(b"RIFF");
        webp[8..12].copy_from_slice(b"WEBP");
        assert_eq!(detect_mime(&webp), "image/webp");
        assert_eq!(detect_mime(&[0u8, 1u8, 2u8]), "image/jpeg");
    }

    #[test]
    fn default_constants_match_deepseek_vision() {
        assert_eq!(DEFAULT_MODEL, "deepseek-v4-flash-vision-exp");
        assert_eq!(DEFAULT_BASE_URL, "https://api.deepseek.com");
    }
}
