//! 火山引擎「录音文件识别大模型」（auc bigmodel）后端。
//!
//! 参考 https://www.volcengine.com/docs/6561/1354868 。
//! 与流式（sauc）不同，这是 REST「提交 + 轮询」整文件识别：
//!   1. POST /submit 上传整段音频（base64），拿到由 X-Api-Request-Id 标识的任务；
//!   2. POST /query 轮询，直到 X-Api-Status-Code = 20000000（完成）拿结果。
//!
//! 鉴权同样是 App Key + Access Key 两段头；资源 ID 用 volc.bigasr.auc。
//! 对「处理已录好的课程视频」这个场景，比流式协议更稳、更简单。

use crate::error::{AppError, AppResult};
use crate::pipeline::asr::WhisperJson;
use crate::pipeline::volcengine_asr::response_payload_to_transcript;
use crate::sidecar::{resolve, FFMPEG};
use futures_util::stream::StreamExt;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;
use uuid::Uuid;

const SUBMIT_URL: &str = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const QUERY_URL: &str = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";
const RESOURCE_ID: &str = "volc.bigasr.auc";
const STATUS_SUCCESS: &str = "20000000";
/// 正在处理 / 排队中：只有这两个码才值得继续等。
const STATUS_PROCESSING: &str = "20000001";
const STATUS_QUEUED: &str = "20000002";
/// 静音音频：服务端已经处理完了，结论是「这段没有人说话」。
///
/// 原来把 2000000x 一律当「处理中」，于是这个**终态**会被一直轮询到超时——
/// 30 分钟一段，外面还包着两次重试，一段静音能拖掉 90 分钟。
const STATUS_SILENT: &str = "20000003";
const STATUS_HEADER: &str = "X-Api-Status-Code";
const MESSAGE_HEADER: &str = "X-Api-Message";
const POLL_INTERVAL: Duration = Duration::from_secs(3);
const MAX_POLLS: u32 = 600; // 3s × 600 ≈ 30 分钟上限
/// 单个 HTTP 请求的上限。没有它时，一次卡死的连接可以挂到天荒地老，
/// 所谓「30 分钟上限」只是轮询次数上限，根本不是真的 deadline。
const SUBMIT_TIMEOUT: Duration = Duration::from_secs(300);
const QUERY_TIMEOUT: Duration = Duration::from_secs(60);
/// 轮询期间允许连续多少次网络抖动。超过就放弃这一段——但**不会**重新提交。
const MAX_QUERY_HICCUPS: u32 = 5;

/// 带请求超时的客户端。两个阶段的超时不同：提交要上传整段 base64 音频，慢得多。
fn asr_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(SUBMIT_TIMEOUT)
        .build()
        .unwrap_or_default()
}

/// 一次识别失败发生在提交之前还是之后。
///
/// 这个区分决定了能不能重试：提交成功之后，任务已经在云端跑着、也已经计费；
/// 换个 request_id 重来一遍会变成**第二个任务、第二笔账**，而原任务还在继续跑。
/// 所以只有「提交本身没成功」才允许整段重来。
enum RecognizeFailure {
    BeforeSubmit(AppError),
    AfterSubmit(AppError),
}

impl RecognizeFailure {
    fn into_error(self) -> AppError {
        match self {
            Self::BeforeSubmit(error) | Self::AfterSubmit(error) => error,
        }
    }

    fn is_resubmittable(&self) -> bool {
        matches!(self, Self::BeforeSubmit(_))
    }
}

/// 分段识别默认参数：5 分钟一段、并发 4 路、每段指数回退重试两次。
pub const DEFAULT_CHUNK_SECS: u64 = 300;
pub const DEFAULT_CONCURRENCY: usize = 4;
const MAX_RETRIES: u32 = 2;

/// 整段上传识别（短音频、关闭分段，或 Android 无 ffmpeg 切片时用）。内部带指数回退
/// 重试两次。`format` 必须与音频真实容器一致（wav / mp3 …），会写进提交体的 audio.format。
pub async fn run_volcengine_file(
    audio: &Path,
    app_id: &str,
    access_token: &str,
    context: Option<&str>,
    format: &str,
) -> AppResult<WhisperJson> {
    let (app_id, access_token) = check_credentials(app_id, access_token)?;
    let audio_bytes = tokio::fs::read(audio).await?;
    let client = asr_client();
    recognize_bytes_with_retry(
        &client,
        &app_id,
        &access_token,
        &audio_bytes,
        context,
        format,
    )
    .await
}

/// 分段并行识别：把长音频按固定时长切成多段 MP3，分别提交、并行轮询，再按各段
/// 的时间偏移合并。相比整段上传更快——服务端可并行处理、单次上传体积也更小。
/// 每段都带「指数回退重试两次」，个别分段抖动不会让整条任务失败。
pub async fn run_volcengine_file_chunked(
    wav: &Path,
    app_id: &str,
    access_token: &str,
    chunk_secs: u64,
    concurrency: usize,
    context: Option<String>,
) -> AppResult<WhisperJson> {
    let (app_id, access_token) = check_credentials(app_id, access_token)?;
    let chunk_secs = if chunk_secs == 0 {
        DEFAULT_CHUNK_SECS
    } else {
        chunk_secs
    };
    let concurrency = concurrency.clamp(1, 16);

    // 切片到临时目录；无论成功失败都清理。
    let chunk_dir = wav.with_file_name("vc_chunks");
    let _ = tokio::fs::remove_dir_all(&chunk_dir).await;
    tokio::fs::create_dir_all(&chunk_dir).await?;
    let split = split_audio_to_mp3(wav, &chunk_dir, chunk_secs).await;
    let chunks = match split {
        Ok(c) => c,
        Err(error) => {
            let _ = tokio::fs::remove_dir_all(&chunk_dir).await;
            return Err(error);
        }
    };
    // 只有一段就直接整段走（省去合并），仍带重试。
    if chunks.len() <= 1 {
        let single = match chunks.first() {
            Some(path) => path.clone(),
            None => {
                let _ = tokio::fs::remove_dir_all(&chunk_dir).await;
                return Err(AppError::Pipeline("音频切片为空，无法识别".into()));
            }
        };
        let client = asr_client();
        let bytes = tokio::fs::read(&single).await?;
        let out = recognize_bytes_with_retry(
            &client,
            &app_id,
            &access_token,
            &bytes,
            context.as_deref(),
            "mp3",
        )
        .await;
        let _ = tokio::fs::remove_dir_all(&chunk_dir).await;
        return out;
    }

    let client = asr_client();
    let results: Vec<AppResult<(usize, WhisperJson)>> =
        futures_util::stream::iter(chunks.into_iter().enumerate().map(|(idx, path)| {
            let client = client.clone();
            let app_id = app_id.clone();
            let access_token = access_token.clone();
            let context = context.clone();
            async move {
                let bytes = tokio::fs::read(&path).await?;
                let json = recognize_bytes_with_retry(
                    &client,
                    &app_id,
                    &access_token,
                    &bytes,
                    context.as_deref(),
                    "mp3",
                )
                .await?;
                Ok((idx, json))
            }
        }))
        .buffer_unordered(concurrency)
        .collect()
        .await;

    let _ = tokio::fs::remove_dir_all(&chunk_dir).await;

    // 任一段重试两次后仍失败 → 整体失败（避免悄悄丢字幕）。
    let mut parts: Vec<(usize, WhisperJson)> = Vec::with_capacity(results.len());
    for result in results {
        parts.push(result?);
    }
    Ok(merge_chunk_transcripts(parts, chunk_secs as i64 * 1000))
}

fn check_credentials(app_id: &str, access_token: &str) -> AppResult<(String, String)> {
    let app_id = app_id.trim().to_string();
    let access_token = access_token.trim().to_string();
    if app_id.is_empty() || access_token.is_empty() {
        return Err(AppError::Config(
            "missing Volcengine ASR credentials：请在设置里填写 App ID 与 Access Token".into(),
        ));
    }
    Ok((app_id, access_token))
}

/// 一次「提交 + 轮询」完整识别一段音频字节。
async fn recognize_bytes(
    client: &reqwest::Client,
    app_id: &str,
    access_token: &str,
    audio_bytes: &[u8],
    context: Option<&str>,
    format: &str,
) -> Result<WhisperJson, RecognizeFailure> {
    let request_id = Uuid::new_v4().to_string();

    // ---- 1. 提交任务 ----
    let body = build_submit_body(&request_id, &base64_encode(audio_bytes), context, format);
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
        .map_err(|error| {
            RecognizeFailure::BeforeSubmit(AppError::Pipeline(format!(
                "volcengine submit: {error}"
            )))
        })?;
    let status = header_value(&resp, STATUS_HEADER);
    let message = header_value(&resp, MESSAGE_HEADER);
    if status.as_deref() != Some(STATUS_SUCCESS) {
        return Err(RecognizeFailure::BeforeSubmit(submit_error(
            "submit",
            status,
            message,
            resp.status(),
        )));
    }

    // ---- 2. 轮询结果 ----
    // 从这里开始，云端任务已经存在并计费：无论出什么事都只能报错，不能换个
    // request_id 重来（那会变成第二个任务、第二笔账，原任务还在跑）。
    poll_until_done(client, app_id, access_token, &request_id)
        .await
        .map_err(RecognizeFailure::AfterSubmit)
}

/// 轮询同一个 request_id 直到出结果。网络抖动就地重试，绝不换 id。
async fn poll_until_done(
    client: &reqwest::Client,
    app_id: &str,
    access_token: &str,
    request_id: &str,
) -> AppResult<WhisperJson> {
    let mut hiccups = 0u32;
    for _ in 0..MAX_POLLS {
        let sent = client
            .post(QUERY_URL)
            .timeout(QUERY_TIMEOUT)
            .header("X-Api-App-Key", app_id)
            .header("X-Api-Access-Key", access_token)
            .header("X-Api-Resource-Id", RESOURCE_ID)
            .header("X-Api-Request-Id", request_id)
            .header("X-Api-Sequence", "-1")
            .json(&json!({}))
            .send()
            .await;
        let resp = match sent {
            Ok(resp) => {
                hiccups = 0;
                resp
            }
            // 查询请求本身没发出去/超时：任务还在云端跑着，接着问就是了。
            // 原来这里直接报错，外层会把整段音频重新提交一次——白花一份钱。
            Err(error) => {
                hiccups += 1;
                if hiccups > MAX_QUERY_HICCUPS {
                    return Err(AppError::Pipeline(format!(
                        "volcengine query 连续 {MAX_QUERY_HICCUPS} 次失败：{error}"
                    )));
                }
                tracing::warn!("volcengine query 第 {hiccups} 次网络失败：{error}；稍后再查");
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
        };
        let status = header_value(&resp, STATUS_HEADER);
        let message = header_value(&resp, MESSAGE_HEADER);
        match status.as_deref() {
            Some(STATUS_SUCCESS) => {
                let payload: Value = resp.json().await.map_err(|error| {
                    AppError::Pipeline(format!("volcengine query decode: {error}"))
                })?;
                return response_payload_to_transcript(&payload);
            }
            // 服务端说这段没有人说话。这是终态，不是「还在处理」：接着轮询只会
            // 一路等到超时。返回空字幕即可——长音频是分段识别的，中间夹一段静音
            // 很正常，不该让整个视频失败。
            Some(STATUS_SILENT) => {
                tracing::info!(request_id, "volcengine 判定该段为静音，返回空字幕");
                return Ok(WhisperJson {
                    transcription: Vec::new(),
                });
            }
            Some(STATUS_PROCESSING) | Some(STATUS_QUEUED) => {
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

/// 在 recognize_bytes 外包一层指数回退重试：失败后等 2s、4s 再试，最多重试两次。
///
/// **只重试提交阶段的失败**。提交成功之后的任何失败都直接上报：那时云端任务已经
/// 建好并开始计费，重来一遍等于同一段音频付两次钱，而且两个任务会并行跑。
async fn recognize_bytes_with_retry(
    client: &reqwest::Client,
    app_id: &str,
    access_token: &str,
    audio_bytes: &[u8],
    context: Option<&str>,
    format: &str,
) -> AppResult<WhisperJson> {
    let mut attempt = 0u32;
    loop {
        match recognize_bytes(client, app_id, access_token, audio_bytes, context, format).await {
            Ok(value) => return Ok(value),
            Err(failure) => {
                if !failure.is_resubmittable() || attempt >= MAX_RETRIES {
                    return Err(failure.into_error());
                }
                let error = failure.into_error();
                let backoff = Duration::from_secs(2u64.pow(attempt + 1));
                tracing::warn!(
                    "volcengine 分段提交第 {} 次失败：{error}；{:?} 后重试",
                    attempt + 1,
                    backoff
                );
                tokio::time::sleep(backoff).await;
                attempt += 1;
            }
        }
    }
}

/// 用 ffmpeg segment 复用器把 WAV 一刀切成多段定长 MP3（mono/16kHz/48kbps），
/// 返回按文件名排序的分片路径。第 i 段的起始时间约为 i × chunk_secs。
async fn split_audio_to_mp3(
    wav: &Path,
    out_dir: &Path,
    chunk_secs: u64,
) -> AppResult<Vec<PathBuf>> {
    let ffmpeg = resolve(&FFMPEG, None)?;
    let pattern = out_dir.join("chunk_%04d.mp3");
    let status = Command::new(&ffmpeg)
        .kill_on_drop(true)
        .args(["-y", "-i"])
        .arg(wav)
        .args([
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "48k",
            "-f",
            "segment",
            "-segment_time",
            &chunk_secs.to_string(),
        ])
        .arg(&pattern)
        .status()
        .await
        .map_err(|error| AppError::Pipeline(format!("ffmpeg segment spawn: {error}")))?;
    if !status.success() {
        return Err(AppError::Pipeline(format!(
            "ffmpeg segment failed: {status}"
        )));
    }
    let mut files = Vec::new();
    let mut entries = tokio::fs::read_dir(out_dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("mp3") {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

/// 把各分段的识别结果按时间偏移（第 i 段 +i×chunk_ms）平移后合并、按起始时间排序。
fn merge_chunk_transcripts(mut parts: Vec<(usize, WhisperJson)>, chunk_ms: i64) -> WhisperJson {
    parts.sort_by_key(|(idx, _)| *idx);
    let mut merged = Vec::new();
    for (idx, json) in parts {
        let offset = idx as i64 * chunk_ms;
        for mut segment in json.transcription {
            segment.offsets.from += offset;
            segment.offsets.to += offset;
            for token in &mut segment.tokens {
                token.offsets.from += offset;
                token.offsets.to += offset;
            }
            merged.push(segment);
        }
    }
    merged.sort_by_key(|segment| segment.offsets.from);
    WhisperJson {
        transcription: merged,
    }
}

pub fn build_submit_body(
    request_id: &str,
    audio_base64: &str,
    context: Option<&str>,
    format: &str,
) -> Value {
    let mut request = json!({
        "model_name": "bigmodel",
        "enable_itn": true,
        "enable_punc": true,
        "enable_ddc": true,
        "show_utterances": true,
    });
    // 热词 + 上下文：作为 request.context 字符串透传（见 build_context_json）。
    if let Some(ctx) = context.filter(|c| !c.is_empty()) {
        request["context"] = Value::String(ctx.to_string());
    }
    json!({
        "user": { "uid": request_id },
        "audio": {
            "data": audio_base64,
            "format": format,
        },
        "request": request,
    })
}

/// 把热词与上下文行拼成火山 `context` 字段所需的 JSON 字符串：
/// - 有热词 → `"hotwords":[{"word":..}]`（热词直传，最多 5000 词）；
/// - 有上下文 → `"context_type":"dialog_ctx","context_data":[{"text":..}]`；
///
/// 两者都有就合并进同一个对象；都为空则返回 None（此时不下发 context）。
/// 空白项会被过滤；上下文 800 tokens / 20 轮的上限由服务端按新到旧截断，这里不强截。
pub fn build_context_json(hotwords: &[String], context_lines: &[String]) -> Option<String> {
    let hotwords: Vec<&str> = hotwords
        .iter()
        .map(|w| w.trim())
        .filter(|w| !w.is_empty())
        .collect();
    let context_lines: Vec<&str> = context_lines
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    if hotwords.is_empty() && context_lines.is_empty() {
        return None;
    }
    let mut obj = serde_json::Map::new();
    if !hotwords.is_empty() {
        obj.insert(
            "hotwords".into(),
            Value::Array(hotwords.iter().map(|w| json!({ "word": w })).collect()),
        );
    }
    if !context_lines.is_empty() {
        obj.insert("context_type".into(), Value::String("dialog_ctx".into()));
        obj.insert(
            "context_data".into(),
            Value::Array(context_lines.iter().map(|l| json!({ "text": l })).collect()),
        );
    }
    serde_json::to_string(&Value::Object(obj)).ok()
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
    fn only_a_failed_submit_may_be_retried() {
        // 提交没成功 = 云端没有任务，整段重来是安全的。
        assert!(RecognizeFailure::BeforeSubmit(AppError::Pipeline("x".into())).is_resubmittable());
        // 提交成功之后的任何失败（查询超时、解析出错）都不能重来：任务已经在云端
        // 跑着并计费，换个 request_id 重来会变成第二个任务、第二笔账。
        assert!(!RecognizeFailure::AfterSubmit(AppError::Pipeline("x".into())).is_resubmittable());
    }

    #[test]
    fn silence_is_a_terminal_status_not_a_reason_to_keep_polling() {
        // 这三个码必须区分开：静音是**结论**，排队和处理中才是「再等等」。
        // 原来 2000000x 一律当处理中，一段静音会轮询到超时——30 分钟一段，
        // 外面还包着两次重试，能拖掉 90 分钟。
        assert_ne!(STATUS_SILENT, STATUS_PROCESSING);
        assert_ne!(STATUS_SILENT, STATUS_QUEUED);
        for code in [
            STATUS_SUCCESS,
            STATUS_PROCESSING,
            STATUS_QUEUED,
            STATUS_SILENT,
        ] {
            assert!(code.starts_with("2000000"), "{code} 应属于 2000000x 一族");
        }
    }

    #[test]
    fn a_silent_chunk_yields_an_empty_transcript_that_merges_cleanly() {
        // 长音频是分段识别的，中间夹一段静音很正常，不该让整个视频失败。
        let silent = WhisperJson {
            transcription: Vec::new(),
        };
        let spoken = maps_one_segment("后半段有人说话");
        let merged = merge_chunk_transcripts(vec![(0, silent), (1, spoken)], 300_000);
        assert_eq!(merged.transcription.len(), 1);
        assert_eq!(merged.transcription[0].text, "后半段有人说话");
        // 第二段的时间偏移照常加上，静音段不会把时间轴顶乱。
        assert_eq!(merged.transcription[0].offsets.from, 300_000);
    }

    /// 造一段只有一句话、从 0ms 开始的识别结果。
    fn maps_one_segment(text: &str) -> WhisperJson {
        WhisperJson {
            transcription: vec![crate::pipeline::asr::WhisperSegment {
                text: text.to_string(),
                offsets: crate::pipeline::asr::Offsets { from: 0, to: 1_000 },
                tokens: Vec::new(),
            }],
        }
    }

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
        let body = build_submit_body("req-1", "QUJD", None, "mp3");
        assert_eq!(body["audio"]["data"], "QUJD");
        // format 透传：桌面分段走 MP3；Android 整段直传 WAV 时会传 "wav"。
        assert_eq!(body["audio"]["format"], "mp3");
        assert_eq!(body["request"]["model_name"], "bigmodel");
        assert_eq!(body["request"]["show_utterances"], true);
        assert_eq!(body["user"]["uid"], "req-1");
        // 没传 context 时 request 里不应出现该字段。
        assert!(body["request"].get("context").is_none());
    }

    #[test]
    fn submit_body_honors_explicit_audio_format() {
        // Android 整段直传原生导出的 WAV 时，format 必须如实标成 "wav"。
        let body = build_submit_body("req-1", "QUJD", None, "wav");
        assert_eq!(body["audio"]["format"], "wav");
    }

    #[test]
    fn submit_body_embeds_context_string_in_request() {
        let body = build_submit_body("req-1", "QUJD", Some("{\"hotwords\":[]}"), "mp3");
        assert_eq!(body["request"]["context"], "{\"hotwords\":[]}");
        // 空串视为不带 context。
        let empty = build_submit_body("req-1", "QUJD", Some(""), "mp3");
        assert!(empty["request"].get("context").is_none());
    }

    #[test]
    fn build_context_json_combines_hotwords_and_dialog() {
        let json =
            build_context_json(&["焓变".into(), "  ".into()], &["标题：概括题".into()]).unwrap();
        let value: Value = serde_json::from_str(&json).unwrap();
        // 空白热词被过滤，只剩一个。
        assert_eq!(value["hotwords"].as_array().unwrap().len(), 1);
        assert_eq!(value["hotwords"][0]["word"], "焓变");
        assert_eq!(value["context_type"], "dialog_ctx");
        assert_eq!(value["context_data"][0]["text"], "标题：概括题");
    }

    #[test]
    fn build_context_json_only_one_side_or_none() {
        // 只有热词。
        let hw = build_context_json(&["勒沙特列".into()], &[]).unwrap();
        let v: Value = serde_json::from_str(&hw).unwrap();
        assert!(v.get("hotwords").is_some());
        assert!(v.get("context_type").is_none());
        // 只有上下文。
        let ctx = build_context_json(&[], &["课程：申论".into()]).unwrap();
        let v: Value = serde_json::from_str(&ctx).unwrap();
        assert!(v.get("hotwords").is_none());
        assert_eq!(v["context_type"], "dialog_ctx");
        // 都为空（含纯空白）→ None。
        assert!(build_context_json(&["   ".into()], &["".into()]).is_none());
    }

    #[test]
    fn merges_chunks_with_time_offset() {
        let chunk0: WhisperJson = serde_json::from_value(json!({
            "transcription": [{
                "text": "第一段",
                "offsets": { "from": 100, "to": 900 },
                "tokens": [{ "text": "第", "offsets": { "from": 100, "to": 300 } }]
            }]
        }))
        .unwrap();
        let chunk1: WhisperJson = serde_json::from_value(json!({
            "transcription": [{
                "text": "第二段",
                "offsets": { "from": 50, "to": 700 },
                "tokens": []
            }]
        }))
        .unwrap();

        // 故意乱序传入，验证按 idx 排序后再平移合并。
        let merged = merge_chunk_transcripts(vec![(1, chunk1), (0, chunk0)], 300_000);
        assert_eq!(merged.transcription.len(), 2);
        // 第 0 段不偏移。
        assert_eq!(merged.transcription[0].offsets.from, 100);
        assert_eq!(merged.transcription[0].tokens[0].offsets.from, 100);
        // 第 1 段整体 +300000ms（含其 token）。
        assert_eq!(merged.transcription[1].offsets.from, 300_050);
        assert_eq!(merged.transcription[1].offsets.to, 300_700);
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
