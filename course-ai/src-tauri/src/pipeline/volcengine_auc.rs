//! 火山引擎「录音文件识别大模型」（auc bigmodel）后端。
//!
//! 参考 https://www.volcengine.com/docs/6561/1354868 。
//! 与流式（sauc）不同，这是 REST「提交 + 轮询」整文件识别：
//!   1. POST /submit 上传整段音频（base64），拿到由 X-Api-Request-Id 标识的任务；
//!   2. POST /query 轮询，直到 X-Api-Status-Code = 20000000（完成）拿结果。
//! 鉴权同样是 App Key + Access Key 两段头；资源 ID 用 volc.bigasr.auc。
//! 对「处理已录好的课程视频」这个场景，比流式协议更稳、更简单。

use crate::error::{AppError, AppResult};
use crate::pipeline::asr::WhisperJson;
use crate::pipeline::volcengine_asr::response_payload_to_transcript;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use uuid::Uuid;

const SUBMIT_URL: &str = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const QUERY_URL: &str = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";
const RESOURCE_ID: &str = "volc.bigasr.auc";
const STATUS_SUCCESS: &str = "20000000";
const STATUS_HEADER: &str = "X-Api-Status-Code";
const MESSAGE_HEADER: &str = "X-Api-Message";
const POLL_INTERVAL: Duration = Duration::from_secs(3);
const MAX_POLLS: u32 = 600; // 3s × 600 ≈ 30 分钟上限

pub async fn run_volcengine_file(
    audio: &Path,
    app_id: &str,
    access_token: &str,
) -> AppResult<WhisperJson> {
    let app_id = app_id.trim();
    let access_token = access_token.trim();
    if app_id.is_empty() || access_token.is_empty() {
        return Err(AppError::Config(
            "missing Volcengine ASR credentials：请在设置里填写 App ID 与 Access Token".into(),
        ));
    }

    let audio_bytes = tokio::fs::read(audio).await?;
    let request_id = Uuid::new_v4().to_string();
    let client = reqwest::Client::new();

    // ---- 1. 提交任务 ----
    let body = build_submit_body(&request_id, &base64_encode(&audio_bytes));
    let resp = client
        .post(SUBMIT_URL)
        .header("X-Api-App-Key", app_id)
        .header("X-Api-Access-Key", access_token)
        .header("X-Api-Resource-Id", RESOURCE_ID)
        .header("X-Api-Request-Id", &request_id)
        .header("X-Api-Sequence", "-1")
        .json(&body)
        .send()
        .await
        .map_err(|error| AppError::Pipeline(format!("volcengine submit: {error}")))?;
    let status = header_value(&resp, STATUS_HEADER);
    let message = header_value(&resp, MESSAGE_HEADER);
    if status.as_deref() != Some(STATUS_SUCCESS) {
        return Err(submit_error("submit", status, message, resp.status()));
    }

    // ---- 2. 轮询结果 ----
    for _ in 0..MAX_POLLS {
        let resp = client
            .post(QUERY_URL)
            .header("X-Api-App-Key", app_id)
            .header("X-Api-Access-Key", access_token)
            .header("X-Api-Resource-Id", RESOURCE_ID)
            .header("X-Api-Request-Id", &request_id)
            .header("X-Api-Sequence", "-1")
            .json(&json!({}))
            .send()
            .await
            .map_err(|error| AppError::Pipeline(format!("volcengine query: {error}")))?;
        let status = header_value(&resp, STATUS_HEADER);
        let message = header_value(&resp, MESSAGE_HEADER);
        match status.as_deref() {
            Some(STATUS_SUCCESS) => {
                let payload: Value = resp.json().await.map_err(|error| {
                    AppError::Pipeline(format!("volcengine query decode: {error}"))
                })?;
                return response_payload_to_transcript(&payload);
            }
            // 2000000x（排队 / 处理中）继续等；其余视为失败。
            Some(code) if code.starts_with("2000000") => {
                tokio::time::sleep(POLL_INTERVAL).await;
            }
            other => {
                return Err(submit_error(
                    "query",
                    other.map(str::to_string),
                    message,
                    resp.status(),
                ));
            }
        }
    }
    Err(AppError::Pipeline(
        "volcengine 录音文件识别轮询超时（超过 30 分钟仍未返回结果）".into(),
    ))
}

pub fn build_submit_body(request_id: &str, audio_base64: &str) -> Value {
    json!({
        "user": { "uid": request_id },
        "audio": {
            "data": audio_base64,
            "format": "mp3",
        },
        "request": {
            "model_name": "bigmodel",
            "enable_itn": true,
            "enable_punc": true,
            "enable_ddc": true,
            "show_utterances": true,
        },
    })
}

fn submit_error(
    stage: &str,
    status: Option<String>,
    message: Option<String>,
    http: reqwest::StatusCode,
) -> AppError {
    let status = status.unwrap_or_else(|| http.as_u16().to_string());
    let message = message.unwrap_or_default();
    let hint = if http.as_u16() == 401 || http.as_u16() == 403 {
        "（鉴权失败：请核对 App ID / Access Token，并确认控制台已开通「录音文件识别大模型」）"
    } else {
        ""
    };
    AppError::Pipeline(format!(
        "volcengine {stage} 失败：状态码 {status} {message}{hint}"
    ))
}

fn header_value(resp: &reqwest::Response, name: &str) -> Option<String> {
    resp.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

/// 标准 base64 编码（无换行）。手写以免引入新依赖。
pub fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((n >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn submit_body_uses_auc_bigmodel_defaults() {
        let body = build_submit_body("req-1", "QUJD");
        assert_eq!(body["audio"]["data"], "QUJD");
        // 整段上传走压缩后的 MP3，避免长视频 WAV base64 触发 413。
        assert_eq!(body["audio"]["format"], "mp3");
        assert_eq!(body["request"]["model_name"], "bigmodel");
        assert_eq!(body["request"]["show_utterances"], true);
        assert_eq!(body["user"]["uid"], "req-1");
    }

    #[test]
    fn maps_query_result_to_whisper_shape() {
        // /query 返回的结果挂在顶层 result 下，复用流式那套映射。
        let payload = json!({
            "result": {
                "text": "你好，世界。",
                "utterances": [
                    {
                        "start_time": 100,
                        "end_time": 800,
                        "text": "你好，世界。",
                        "words": [
                            {"start_time": 100, "end_time": 400, "text": "你好"},
                            {"start_time": 420, "end_time": 800, "text": "世界"}
                        ]
                    }
                ]
            }
        });
        let t = response_payload_to_transcript(&payload).unwrap();
        assert_eq!(t.transcription.len(), 1);
        assert_eq!(t.transcription[0].text, "你好，世界。");
        assert_eq!(t.transcription[0].offsets.from, 100);
        assert_eq!(t.transcription[0].tokens[1].text, "世界");
    }
}
