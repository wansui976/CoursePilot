//! 阿里云百炼（DashScope）「录音文件识别」后端，部署区域：中国内地。
//!
//! 参考 https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide 。
//! 异步「提交 + 轮询」整文件识别，支持 fun-asr / qwen3-asr-flash-filetrans / paraformer-v2：
//!   1. POST .../audio/asr/transcription（X-DashScope-Async: enable）提交，拿 task_id；
//!   2. GET  .../tasks/{task_id} 轮询，直到 task_status=SUCCEEDED；
//!   3. 下载 transcription_url 指向的 JSON，映射成内部字幕结构。
//! 本地文件没有公网 URL，改用 base64 data URI 作为 file_urls 传入。

use crate::error::{AppError, AppResult};
use crate::pipeline::asr::{Offsets, TokenObj, WhisperJson, WhisperSegment};
use crate::pipeline::volcengine_auc::base64_encode;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

const SUBMIT_URL: &str = "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription";
const TASK_URL_PREFIX: &str = "https://dashscope.aliyuncs.com/api/v1/tasks/";
const POLL_INTERVAL: Duration = Duration::from_secs(3);
const MAX_POLLS: u32 = 600; // 3s × 600 ≈ 30 分钟上限

/// 默认模型；可被设置覆盖。
pub const DEFAULT_MODEL: &str = "qwen3-asr-flash-filetrans";

pub async fn run_aliyun(audio_mp3: &Path, api_key: &str, model: &str) -> AppResult<WhisperJson> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(AppError::Config(
            "missing DashScope API Key：请在设置里填写阿里云百炼 API Key".into(),
        ));
    }
    let model = if model.trim().is_empty() {
        DEFAULT_MODEL
    } else {
        model.trim()
    };

    let bytes = tokio::fs::read(audio_mp3).await?;
    let data_uri = format!("data:audio/mpeg;base64,{}", base64_encode(&bytes));
    let client = reqwest::Client::new();

    // ---- 1. 提交任务 ----
    let resp = client
        .post(SUBMIT_URL)
        .bearer_auth(api_key)
        .header("X-DashScope-Async", "enable")
        .json(&build_submit_body(model, &data_uri))
        .send()
        .await
        .map_err(|error| AppError::Pipeline(format!("dashscope submit: {error}")))?;
    let http = resp.status();
    let payload: Value = resp
        .json()
        .await
        .map_err(|error| AppError::Pipeline(format!("dashscope submit decode: {error}")))?;
    let task_id = payload
        .pointer("/output/task_id")
        .and_then(Value::as_str)
        .ok_or_else(|| dashscope_error("submit", &payload, http))?
        .to_string();

    // ---- 2. 轮询任务 ----
    let task_url = format!("{TASK_URL_PREFIX}{task_id}");
    for _ in 0..MAX_POLLS {
        let resp = client
            .get(&task_url)
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|error| AppError::Pipeline(format!("dashscope query: {error}")))?;
        let http = resp.status();
        let payload: Value = resp
            .json()
            .await
            .map_err(|error| AppError::Pipeline(format!("dashscope query decode: {error}")))?;
        match payload
            .pointer("/output/task_status")
            .and_then(Value::as_str)
        {
            Some("SUCCEEDED") => {
                let url = transcription_url(&payload).ok_or_else(|| {
                    AppError::Pipeline(format!("dashscope 缺少 transcription_url: {payload}"))
                })?;
                return fetch_and_map(&client, &url).await;
            }
            Some("PENDING") | Some("RUNNING") => tokio::time::sleep(POLL_INTERVAL).await,
            _ => return Err(dashscope_error("query", &payload, http)),
        }
    }
    Err(AppError::Pipeline(
        "dashscope 录音文件识别轮询超时（超过 30 分钟仍未完成）".into(),
    ))
}

pub fn build_submit_body(model: &str, file_url: &str) -> Value {
    json!({
        "model": model,
        "input": { "file_urls": [file_url] },
    })
}

/// fun-asr / paraformer 结果在 output.results[]，qwen3-asr-flash-filetrans 在 output.result。
pub fn transcription_url(payload: &Value) -> Option<String> {
    payload
        .pointer("/output/results/0/transcription_url")
        .or_else(|| payload.pointer("/output/result/transcription_url"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

async fn fetch_and_map(client: &reqwest::Client, url: &str) -> AppResult<WhisperJson> {
    let payload: Value = client
        .get(url)
        .send()
        .await
        .map_err(|error| AppError::Pipeline(format!("dashscope 下载结果: {error}")))?
        .json()
        .await
        .map_err(|error| AppError::Pipeline(format!("dashscope 结果解析: {error}")))?;
    result_json_to_transcript(&payload)
}

/// 结果 JSON 形如 { transcripts:[{ sentences:[{begin_time,end_time,text,words:[...]}] }] }。
pub fn result_json_to_transcript(payload: &Value) -> AppResult<WhisperJson> {
    let mut transcription = Vec::new();
    let transcripts = payload
        .get("transcripts")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Pipeline(format!("dashscope 结果缺少 transcripts: {payload}")))?;
    for transcript in transcripts {
        let Some(sentences) = transcript.get("sentences").and_then(Value::as_array) else {
            continue;
        };
        for sentence in sentences {
            let text = sentence
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if text.is_empty() {
                continue;
            }
            let from = sentence
                .get("begin_time")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let to = sentence
                .get("end_time")
                .and_then(Value::as_i64)
                .unwrap_or(from);
            let tokens = sentence
                .get("words")
                .and_then(Value::as_array)
                .map(|words| {
                    words
                        .iter()
                        .filter_map(|word| {
                            let text = word.get("text").and_then(Value::as_str)?.trim().to_string();
                            if text.is_empty() {
                                return None;
                            }
                            Some(TokenObj {
                                text,
                                offsets: Offsets {
                                    from: word
                                        .get("begin_time")
                                        .and_then(Value::as_i64)
                                        .unwrap_or(from),
                                    to: word.get("end_time").and_then(Value::as_i64).unwrap_or(to),
                                },
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            transcription.push(WhisperSegment {
                text,
                offsets: Offsets { from, to },
                tokens,
            });
        }
    }
    Ok(WhisperJson { transcription })
}

fn dashscope_error(stage: &str, payload: &Value, http: reqwest::StatusCode) -> AppError {
    let code = payload
        .get("code")
        .and_then(Value::as_str)
        .or_else(|| payload.pointer("/output/code").and_then(Value::as_str))
        .unwrap_or("");
    let message = payload
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| payload.pointer("/output/message").and_then(Value::as_str))
        .unwrap_or("");
    let hint = if http.as_u16() == 401 || http.as_u16() == 403 {
        "（鉴权失败：请核对百炼 API Key，并确认已开通对应模型）"
    } else {
        ""
    };
    AppError::Pipeline(format!(
        "dashscope {stage} 失败：HTTP {} {code} {message}{hint}",
        http.as_u16()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submit_body_uses_file_urls() {
        let body = build_submit_body("fun-asr", "data:audio/mpeg;base64,QUJD");
        assert_eq!(body["model"], "fun-asr");
        assert_eq!(body["input"]["file_urls"][0], "data:audio/mpeg;base64,QUJD");
    }

    #[test]
    fn picks_transcription_url_from_either_shape() {
        let funasr = json!({"output":{"results":[{"transcription_url":"https://a/r.json"}]}});
        assert_eq!(transcription_url(&funasr).unwrap(), "https://a/r.json");
        let qwen = json!({"output":{"result":{"transcription_url":"https://b/r.json"}}});
        assert_eq!(transcription_url(&qwen).unwrap(), "https://b/r.json");
    }

    #[test]
    fn maps_sentences_to_whisper_shape() {
        let payload = json!({
            "transcripts": [{
                "sentences": [{
                    "begin_time": 760,
                    "end_time": 3240,
                    "text": "你好，世界。",
                    "words": [
                        {"begin_time": 760, "end_time": 1000, "text": "你好"},
                        {"begin_time": 1020, "end_time": 3240, "text": "世界"}
                    ]
                }]
            }]
        });
        let t = result_json_to_transcript(&payload).unwrap();
        assert_eq!(t.transcription.len(), 1);
        assert_eq!(t.transcription[0].text, "你好，世界。");
        assert_eq!(t.transcription[0].offsets.from, 760);
        assert_eq!(t.transcription[0].offsets.to, 3240);
        assert_eq!(t.transcription[0].tokens[1].text, "世界");
    }

    #[test]
    fn error_includes_dashscope_message() {
        let payload = json!({"code":"InvalidApiKey","message":"bad key"});
        let err = dashscope_error("submit", &payload, reqwest::StatusCode::UNAUTHORIZED);
        assert!(err.to_string().contains("InvalidApiKey"));
        assert!(err.to_string().contains("bad key"));
    }
}
