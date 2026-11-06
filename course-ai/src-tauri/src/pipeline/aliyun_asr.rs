//! 阿里云百炼（DashScope）「录音文件识别」后端，部署区域：中国内地。
//!
//! 参考 https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide 。
//! 异步「提交 + 轮询」整文件识别，支持 fun-asr / qwen3-asr-flash-filetrans / paraformer-v2：
//!   1. POST .../audio/asr/transcription（X-DashScope-Async: enable）提交，拿 task_id；
//!   2. GET  .../tasks/{task_id} 轮询，直到 task_status=SUCCEEDED；
//!   3. 下载 transcription_url 指向的 JSON，映射成内部字幕结构。
//!
//! 本地文件没有公网 URL：先传到百炼的**临时存储**（官方「上传本地文件获取临时 URL」：
//! getPolicy 拿上传凭证 → 表单直传 OSS → 得到 48 小时有效的 `oss://` 地址，单文件最大
//! 1 GB），提交时带 `X-DashScope-OssResourceResolve: enable` 让服务端认这个地址。
//! 见 https://help.aliyun.com/zh/model-studio/get-temporary-file-url 。
//!
//! 原来是把整段音频编成 base64 data URI 塞进提交请求（2026-10-26 实测三个模型都接受，
//! 记录见 `tools/aliyun-asr/availability-2026-10-26.md`），但服务端 JSON 单个字符串有
//! 2800 万字符的上限：桌面端 32 kbps 约 87 分钟、手机导出的高码率音频 20 多分钟就到顶。
//! 现在 data URI 只在临时存储上传失败、而文件又放得下时兜底。
//!
//! 字段名按模型区分：qwen3 用单数 `file_url` / `parameters.language`，fun-asr 与
//! paraformer 用复数 `file_urls` / `language_hints`，见 [`uses_singular_file_url`]。

use crate::error::{AppError, AppResult};
use crate::pipeline::asr::{Offsets, TokenObj, WhisperJson, WhisperSegment};
use crate::pipeline::volcengine_auc::base64_encode;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

const SUBMIT_URL: &str = "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription";
const UPLOAD_POLICY_URL: &str = "https://dashscope.aliyuncs.com/api/v1/uploads";
/// 临时存储单个文件的上限（官方文档写 1 GB；getPolicy 返回的 max_file_size_mb 为准）。
const DEFAULT_MAX_UPLOAD_MB: u64 = 1024;
/// 上传整段音频的超时。一小时的课桌面端约 14 MB，手机导出的音频可能上百 MB。
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const TASK_URL_PREFIX: &str = "https://dashscope.aliyuncs.com/api/v1/tasks/";
const POLL_INTERVAL: Duration = Duration::from_secs(3);
const MAX_POLLS: u32 = 1200; // 3s × 1200 ≈ 60 分钟上限：几小时的长课也够转完

/// 服务端 JSON 解析器对单个字符串的上限（`StreamReadConstraints.getMaxStringLength()`）。
/// data URI 是 JSON 里的一个字符串，超过它整次请求会以 HTTP 400 被拒——而且是在
/// 传了约 28MB 之后才拒。实测解析到 28,049,408 字符时被拒，错误信息给出的上限是
/// 28,000,000。这里留一点余量给 `data:<mime>;base64,` 前缀。
pub const MAX_DATA_URI_CHARS: usize = 28_000_000;
const MAX_AUDIO_BYTES: usize = MAX_DATA_URI_CHARS / 4 * 3 - 64;

/// 默认模型；可被设置覆盖。
pub const DEFAULT_MODEL: &str = "qwen3-asr-flash-filetrans";

pub async fn run_aliyun(
    audio: &Path,
    mime: &str,
    api_key: &str,
    model: &str,
    language: Option<&str>,
    duration_ms: Option<i64>,
) -> AppResult<WhisperJson> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        // 显示给用户的句子，不加 "config error:" 前缀；重试也不会变好。
        return Err(AppError::Permanent(
            "缺少阿里云百炼 API Key：请在设置 → 语音识别里填写并保存（Key 以 sk- 开头）".into(),
        ));
    }
    let model = if model.trim().is_empty() {
        DEFAULT_MODEL
    } else {
        model.trim()
    };
    // qwen3-asr 用单数 parameters.language；paraformer-v2 / fun-asr 用 language_hints 数组。
    // 空值和「自动检测」都不传，交给模型自己判断。
    let language = language
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "auto");

    let size = tokio::fs::metadata(audio).await?.len();
    let client = reqwest::Client::new();

    // ---- 1. 音频传到百炼临时存储，拿 oss:// 地址 ----
    let (file_url, via_oss) = match upload_to_temp_storage(&client, api_key, model, audio, mime, size).await {
        Ok(url) => (url, true),
        Err(error) => {
            // 临时存储不通（网络、账号没开这个能力……）：放得下的话还走原来的 data URI，
            // 放不下就把上传失败的原因报出来——那才是要解决的问题。
            fallback_to_data_uri(&error, size as usize, duration_ms)?;
            tracing::warn!("阿里云临时存储上传失败：{error}；音频不大，改为随请求直接提交");
            let bytes = tokio::fs::read(audio).await?;
            (audio_data_uri(mime, &bytes), false)
        }
    };

    // ---- 2. 提交任务 ----
    let mut request = client
        .post(SUBMIT_URL)
        .bearer_auth(api_key)
        .header("X-DashScope-Async", "enable");
    if via_oss {
        // 没有这个头，服务端不认 oss:// 地址，报「URL 无效」。
        request = request.header("X-DashScope-OssResourceResolve", "enable");
    }
    let resp = request
        .json(&build_submit_body(model, &file_url, language))
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

    // ---- 3. 轮询任务 ----
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
        "dashscope 录音文件识别轮询超时（超过 60 分钟仍未完成）".into(),
    ))
}

/// getPolicy 返回的上传凭证（表单直传 OSS 用）。
#[derive(Debug, PartialEq)]
struct UploadPolicy {
    policy: String,
    signature: String,
    upload_dir: String,
    upload_host: String,
    oss_access_key_id: String,
    x_oss_object_acl: String,
    x_oss_forbid_overwrite: String,
    max_file_size_mb: u64,
}

fn parse_upload_policy(payload: &Value) -> Option<UploadPolicy> {
    let data = payload.get("data")?;
    let text = |name: &str| data.get(name).and_then(Value::as_str).map(str::to_string);
    Some(UploadPolicy {
        policy: text("policy")?,
        signature: text("signature")?,
        upload_dir: text("upload_dir")?,
        upload_host: text("upload_host")?,
        oss_access_key_id: text("oss_access_key_id")?,
        x_oss_object_acl: text("x_oss_object_acl").unwrap_or_else(|| "private".into()),
        x_oss_forbid_overwrite: text("x_oss_forbid_overwrite").unwrap_or_else(|| "true".into()),
        max_file_size_mb: data
            .get("max_file_size_mb")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_MAX_UPLOAD_MB),
    })
}

/// 把本地音频传到百炼临时存储，返回 `oss://` 地址（48 小时有效）。
async fn upload_to_temp_storage(
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
    audio: &Path,
    mime: &str,
    size: u64,
) -> AppResult<String> {
    let resp = client
        .get(UPLOAD_POLICY_URL)
        .query(&[("action", "getPolicy"), ("model", model)])
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|error| AppError::Pipeline(format!("dashscope 获取上传凭证: {error}")))?;
    let http = resp.status();
    let payload: Value = resp
        .json()
        .await
        .map_err(|error| AppError::Pipeline(format!("dashscope 上传凭证解析: {error}")))?;
    let policy =
        parse_upload_policy(&payload).ok_or_else(|| dashscope_error("getPolicy", &payload, http))?;
    if size > policy.max_file_size_mb * 1024 * 1024 {
        return Err(AppError::Permanent(format!(
            "音频有 {:.0} MB，超过阿里云临时存储单个文件 {} MB 的上限；请把视频切成几段再导入",
            size as f64 / 1_048_576.0,
            policy.max_file_size_mb
        )));
    }
    let ext = audio.extension().and_then(|e| e.to_str()).unwrap_or("bin");
    let key = format!("{}/{}.{ext}", policy.upload_dir.trim_end_matches('/'), uuid::Uuid::new_v4());
    let bytes = tokio::fs::read(audio).await?;
    let file = reqwest::multipart::Part::bytes(bytes)
        .file_name(format!("audio.{ext}"))
        .mime_str(mime)
        .map_err(|error| AppError::Pipeline(format!("dashscope 上传: {error}")))?;
    // file 必须是最后一个字段（OSS 表单上传的规矩），其余顺序随意。
    let form = reqwest::multipart::Form::new()
        .text("OSSAccessKeyId", policy.oss_access_key_id)
        .text("Signature", policy.signature)
        .text("policy", policy.policy)
        .text("x-oss-object-acl", policy.x_oss_object_acl)
        .text("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite)
        .text("key", key.clone())
        .text("success_action_status", "200")
        .part("file", file);
    let resp = client
        .post(&policy.upload_host)
        .timeout(UPLOAD_TIMEOUT)
        .multipart(form)
        .send()
        .await
        .map_err(|error| AppError::Pipeline(format!("dashscope 上传音频: {error}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Pipeline(format!(
            "dashscope 上传音频失败：HTTP {status} {}",
            body.chars().take(300).collect::<String>()
        )));
    }
    Ok(format!("oss://{key}"))
}

/// 临时存储传不上去时，还能不能退回 data URI：放得下就退，放不下就把两个原因一起报。
fn fallback_to_data_uri(upload_error: &AppError, size: usize, duration_ms: Option<i64>) -> AppResult<()> {
    if let AppError::Permanent(_) = upload_error {
        // 超过临时存储上限之类：data URI 只会更放不下。
        return Err(AppError::Permanent(upload_error.to_string()));
    }
    ensure_fits_data_uri(size, duration_ms).map_err(|too_big| {
        AppError::Pipeline(format!("上传到阿里云临时存储失败（{upload_error}）；{too_big}"))
    })
}

/// base64 会膨胀 4/3，服务端又把 data URI 当一个 JSON 字符串解析，所以能提交的
/// 原始音频有硬上限。超过时直接报错，并给出真实时长和替代方案。
///
/// 不要按 32 kbps 反推时长：只有桌面端会把音频压到 32 kbps，Android 导出的 M4A
/// 通常沿用原音轨（128 kbps 以上），同样 20 多分钟就会触顶。用视频本身的时长最准。
pub fn ensure_fits_data_uri(audio_bytes: usize, duration_ms: Option<i64>) -> AppResult<()> {
    if audio_bytes <= MAX_AUDIO_BYTES {
        return Ok(());
    }
    let size = format!("{:.1} MB", audio_bytes as f64 / 1_000_000.0);
    let length = match duration_ms {
        Some(ms) if ms > 0 => {
            let minutes = ((ms as f64 / 60_000.0).round() as i64).max(1);
            format!("{size}（约 {minutes} 分钟）")
        }
        _ => size,
    };
    Err(AppError::Permanent(format!(
        "音频太大：{length}，base64 后会超过阿里云单次请求的 {} 字符上限。\
         移动端导出的音频码率更高，同样时长会更早触顶；请把视频/音频切成几段再导入，\
         或改用本地识别。",
        MAX_DATA_URI_CHARS
    )))
}

pub fn audio_data_uri(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", base64_encode(bytes))
}

/// qwen3-asr 系列的录音文件识别接口收的是**单数** `file_url`（一次一个文件）；
/// fun-asr / paraformer 收的是复数 `file_urls` 数组。发错字段名，服务端会报
/// 「缺少必需参数」，而这正是默认模型——等于默认配置下这条后端根本跑不通。
pub fn uses_singular_file_url(model: &str) -> bool {
    model.contains("qwen3-asr")
}

pub fn build_submit_body(model: &str, file_url: &str, language: Option<&str>) -> Value {
    let singular = uses_singular_file_url(model);
    let input = if singular {
        json!({ "file_url": file_url })
    } else {
        json!({ "file_urls": [file_url] })
    };
    let mut body = json!({
        "model": model,
        "input": input,
    });

    let mut parameters = serde_json::Map::new();
    if let Some(lang) = language {
        // 官方参数名不同：qwen3-asr 系列是单数 `language`（只能一个值），
        // fun-asr / paraformer 是复数数组 `language_hints`。发错名字不会报错，
        // 只会被当成未知参数忽略——语言设置看似生效、实际没生效。
        if singular {
            parameters.insert("language".into(), json!(lang));
        } else {
            parameters.insert("language_hints".into(), json!([lang]));
        }
    }
    if singular {
        // 默认 false：只返回句级时间戳，长句不会按标点切开。开启后才有字级
        // 时间戳，文稿的逐句高亮和「按标点切长句」都依赖它。
        parameters.insert("enable_words".into(), json!(true));
    }
    if !parameters.is_empty() {
        body["parameters"] = Value::Object(parameters);
    }
    body
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
    let hint = match http.as_u16() {
        401 | 403 => "（鉴权失败：请核对百炼 API Key，并确认已开通对应模型）",
        429 => "（请求过于频繁：稍等片刻再试）",
        _ => "",
    };
    // 纯静音、纯音乐这类音频，任务最终是 FAILED，但 code 是
    // SUCCESS_WITH_NO_VALID_FRAGMENT。直接把它抛给用户，看到的只有一串英文
    // 错误码，完全不知道「不是 Key 错了，是这段音频没人说话」。
    if code == "SUCCESS_WITH_NO_VALID_FRAGMENT" {
        return AppError::Pipeline(
            "阿里云没有从这段音频里检测到语音（SUCCESS_WITH_NO_VALID_FRAGMENT）。\
             如果视频只有音乐或静音，可以改用 B 站自带字幕，或切到本地 Whisper。"
                .into(),
        );
    }
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
        let body = build_submit_body("fun-asr", "data:audio/mpeg;base64,QUJD", None);
        assert_eq!(body["model"], "fun-asr");
        assert_eq!(body["input"]["file_urls"][0], "data:audio/mpeg;base64,QUJD");
        assert!(body.get("parameters").is_none());
    }

    #[test]
    fn qwen3_takes_a_singular_file_url() {
        // 默认模型就是 qwen3 系列，它收的是单数 file_url。发成复数数组会被服务端
        // 判成缺少必需参数——等于默认配置下这条后端根本跑不通。
        assert!(uses_singular_file_url(DEFAULT_MODEL));
        let body = build_submit_body(DEFAULT_MODEL, "data:audio/mp4;base64,QUJD", None);
        assert_eq!(body["input"]["file_url"], "data:audio/mp4;base64,QUJD");
        assert!(body["input"].get("file_urls").is_none());

        // fun-asr / paraformer 仍然是复数数组，别把它们一起改坏了。
        assert!(!uses_singular_file_url("fun-asr"));
        assert!(!uses_singular_file_url("paraformer-v2"));
    }

    #[test]
    fn rejects_audio_that_would_exceed_the_string_limit() {
        // 20MB 原始音频 base64 后约 27.9M 字符，能过。
        assert!(ensure_fits_data_uri(20_000_000, None).is_ok());
        // 22MB 原始音频 base64 后约 29.3M，服务端会 400；
        // 本地就该拦下来，别让用户等十几分钟上传。
        let err = ensure_fits_data_uri(21_234_567, Some(22 * 60_000))
            .unwrap_err()
            .to_string();
        assert!(err.contains("音频太大"), "{err}");
        // 按真实时长报，而不是假装所有音频都是 32 kbps。
        assert!(err.contains("21.2 MB"), "{err}");
        assert!(err.contains("约 22 分钟"), "{err}");
        assert!(!err.contains("32 kbps"), "{err}");
        assert!(err.contains("28000000"), "{err}");
        assert!(err.contains("本地识别"), "{err}");
    }

    #[test]
    fn preflight_boundary_keeps_the_data_uri_under_the_limit() {
        // MAX_AUDIO_BYTES 是私有的，但边界必须真的落在 28,000,000 以内：
        // base64 长度是 4*ceil(n/3)，再加 data URI 前缀。
        let encoded = (MAX_AUDIO_BYTES + 2) / 3 * 4;
        assert!(encoded + 64 <= MAX_DATA_URI_CHARS, "{encoded}");
    }

    #[test]
    fn audio_data_uri_keeps_supplied_mime() {
        assert_eq!(
            audio_data_uri("audio/mp4", b"ABC"),
            "data:audio/mp4;base64,QUJD"
        );
    }

    #[test]
    fn submit_body_adds_language_hints_when_set() {
        let body = build_submit_body("paraformer-v2", "u", Some("en"));
        assert_eq!(body["parameters"]["language_hints"][0], "en");
        assert!(body["parameters"].get("language").is_none());
        assert!(body["parameters"].get("enable_words").is_none());
    }

    #[test]
    fn qwen3_uses_singular_language_and_asks_for_word_timestamps() {
        // 官方文档里 qwen3-asr 的语言参数叫 `language`，不是 `language_hints`。
        // 参数名写错不会报错，只会被静默忽略——设置里选的语言等于没选。
        let body = build_submit_body(DEFAULT_MODEL, "u", Some("zh"));
        assert_eq!(body["parameters"]["language"], "zh");
        assert!(body["parameters"].get("language_hints").is_none());
        // 不开 enable_words 只有句级时间戳，长句也不会按标点切开。
        assert_eq!(body["parameters"]["enable_words"], true);
    }

    #[test]
    fn qwen3_still_enables_words_without_a_language() {
        let body = build_submit_body(DEFAULT_MODEL, "u", None);
        assert_eq!(body["parameters"]["enable_words"], true);
        assert!(body["parameters"].get("language").is_none());
    }

    #[test]
    fn fun_asr_does_not_get_qwen3_only_parameters() {
        let body = build_submit_body("fun-asr", "u", Some("zh"));
        assert_eq!(body["parameters"]["language_hints"][0], "zh");
        assert!(body["parameters"].get("enable_words").is_none());
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

    #[tokio::test]
    async fn empty_key_gets_a_readable_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.mp3");
        std::fs::write(&path, b"not really audio").unwrap();
        let err = run_aliyun(&path, "audio/mpeg", "  ", DEFAULT_MODEL, None, None)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("缺少阿里云百炼 API Key"), "{err}");
        assert!(!err.contains("config error"), "{err}");
    }

    #[test]
    fn a_failed_upload_falls_back_to_a_data_uri_only_when_the_audio_fits() {
        let network = AppError::Pipeline("dashscope 获取上传凭证: timeout".into());
        assert!(fallback_to_data_uri(&network, 5_000_000, None).is_ok());
        let err = fallback_to_data_uri(&network, 40_000_000, Some(90 * 60_000))
            .unwrap_err()
            .to_string();
        assert!(err.contains("上传到阿里云临时存储失败"), "{err}");
        assert!(err.contains("timeout"), "{err}");
        assert!(err.contains("音频太大"), "{err}");
        // 超过临时存储上限：不该再试更小的 data URI。
        let too_big = AppError::Permanent("音频有 2000 MB，超过阿里云临时存储".into());
        assert!(fallback_to_data_uri(&too_big, 100, None).is_err());
    }

    #[test]
    fn the_upload_policy_is_read_from_the_documented_fields() {
        let payload = json!({
            "request_id": "r",
            "data": {
                "policy": "p", "signature": "s", "upload_dir": "dashscope-instant/abc/2026-11-05/xyz",
                "upload_host": "https://dashscope-file-xxx.oss-cn-beijing.aliyuncs.com",
                "expire_in_seconds": 300, "max_file_size_mb": 1024, "capacity_limit_mb": 999999999,
                "oss_access_key_id": "LTAI", "x_oss_object_acl": "private", "x_oss_forbid_overwrite": "true"
            }
        });
        let policy = parse_upload_policy(&payload).unwrap();
        assert_eq!(policy.upload_host, "https://dashscope-file-xxx.oss-cn-beijing.aliyuncs.com");
        assert_eq!(policy.max_file_size_mb, 1024);
        assert_eq!(policy.oss_access_key_id, "LTAI");
        // Key 不对时没有 data，报 DashScope 原本的错误。
        assert!(parse_upload_policy(&json!({"code": "InvalidApiKey", "message": "bad"})).is_none());
    }

    /// 真网测试：默认不跑，配置好 Key 与一段音频后手动执行
    /// `cargo test --lib live_aliyun -- --ignored --nocapture`。
    /// 它走的是生产路径 `run_aliyun`，不是手搓请求体。
    #[tokio::test]
    #[ignore = "需要网络、DASHSCOPE_API_KEY 和 ALIYUN_ASR_AUDIO"]
    async fn live_aliyun_transcribes_a_local_file() {
        let key = std::env::var("DASHSCOPE_API_KEY").expect("DASHSCOPE_API_KEY");
        let audio = std::env::var("ALIYUN_ASR_AUDIO").expect("ALIYUN_ASR_AUDIO");
        let mime = if audio.ends_with(".wav") { "audio/wav" } else { "audio/mpeg" };
        let json = run_aliyun(
            Path::new(&audio),
            mime,
            &key,
            DEFAULT_MODEL,
            Some("zh"),
            None,
        )
        .await
        .expect("live aliyun asr");
        let text: String = json
            .transcription
            .iter()
            .map(|segment| segment.text.as_str())
            .collect();
        eprintln!("live transcript: {text}");
        assert!(!text.trim().is_empty(), "empty transcript");
        assert!(
            json.transcription
                .iter()
                .any(|segment| !segment.tokens.is_empty()),
            "enable_words=true should return word timestamps"
        );
    }

    /// 真网测试：音频确实传到了临时存储（而不是悄悄退回了 data URI）。
    /// `cargo test --lib live_aliyun_upload -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "需要网络、DASHSCOPE_API_KEY 和 ALIYUN_ASR_AUDIO"]
    async fn live_aliyun_upload_returns_an_oss_url() {
        let key = std::env::var("DASHSCOPE_API_KEY").expect("DASHSCOPE_API_KEY");
        let audio = std::env::var("ALIYUN_ASR_AUDIO").expect("ALIYUN_ASR_AUDIO");
        let path = Path::new(&audio);
        let size = std::fs::metadata(path).unwrap().len();
        let url = upload_to_temp_storage(&reqwest::Client::new(), &key, DEFAULT_MODEL, path, "audio/mpeg", size)
            .await
            .expect("upload");
        eprintln!("uploaded {size} bytes → {url}");
        assert!(url.starts_with("oss://"), "{url}");
    }

    #[test]
    fn silent_audio_gets_a_readable_error() {
        // 纯静音/纯音乐的任务是 FAILED，但 code 叫 SUCCESS_WITH_NO_VALID_FRAGMENT。
        // 原样抛出去，用户只会看到一串英文错误码，不知道其实不是配置问题。
        let payload = json!({
            "output": {
                "task_status": "FAILED",
                "code": "SUCCESS_WITH_NO_VALID_FRAGMENT",
                "message": "SUCCESS_WITH_NO_VALID_FRAGMENT"
            }
        });
        let err = dashscope_error("query", &payload, reqwest::StatusCode::OK);
        let text = err.to_string();
        assert!(text.contains("没有从这段音频里检测到语音"), "{text}");
        assert!(text.contains("SUCCESS_WITH_NO_VALID_FRAGMENT"), "{text}");
    }
}
