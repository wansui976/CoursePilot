//! 火山引擎「录音文件识别大模型」（auc bigmodel）后端。
//!
//! 参考 https://www.volcengine.com/docs/6561/1354868 。
//! 与流式（sauc）不同，这是 REST「提交 + 轮询」整文件识别：
//!   1. POST /submit 上传整段音频（base64），拿到由 X-Api-Request-Id 标识的任务；
//!   2. POST /query 轮询，直到 X-Api-Status-Code = 20000000（完成）拿结果。
//!
//! 鉴权同样是 App Key + Access Key 两段头；资源 ID 随模型版本而变——这一条最容易踩：
//! 控制台开通「豆包录音文件识别模型2.0」时资源 ID 是 `volc.seedasr.auc`，开通 1.0 才是
//! `volc.bigasr.auc`。用错不会被当成参数错误，而是 403 + `45000030 requested resource
//! not granted`，看着像 App ID / Token 填错了（见下面 RESOURCE_ID_V2 的说明）。
//! 对「处理已录好的课程视频」这个场景，比流式协议更稳、更简单。

use crate::error::{AppError, AppResult};
use crate::pipeline::ai::{report, Progress};
use crate::pipeline::asr::WhisperJson;
use crate::pipeline::volcengine_asr::response_payload_to_transcript;
use crate::sidecar::{resolve, FFMPEG};
use futures_util::stream::StreamExt;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use uuid::Uuid;

const SUBMIT_URL: &str = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const QUERY_URL: &str = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";
/// 「豆包录音文件识别模型2.0」的资源 ID。控制台现在默认开通、也默认售卖 2.0，
/// 所以先试它。
const RESOURCE_ID_V2: &str = "volc.seedasr.auc";
/// 「豆包录音文件识别模型1.0」的资源 ID。老账号、旧版控制台开通的是这个。
///
/// 这两个 ID 和「有没有开通服务」是绑死的一对：开通了 2.0 却发 1.0 的 ID，服务端
/// 不会说「模型版本不对」，而是回 HTTP 403 + 业务码 45000030 `requested resource
/// not granted`——和 App ID / Token 填错长得一模一样。真实反馈就是被它带偏的：
/// 反复核对 App ID 与 Access Token 都没问题，其实只是 ID 差了半截。
const RESOURCE_ID_V1: &str = "volc.bigasr.auc";
/// 资源没授权给这个 App 时，服务端回的业务码。
const STATUS_RESOURCE_NOT_GRANTED: &str = "45000030";
/// 本进程内已经试通过的那个资源 ID。分段识别会并发提交十几段，没有它的话每一段
/// 都要先撞一次 403 再回退——白打十几次日志，还白等回退重试。
static RESOLVED_RESOURCE_ID: OnceLock<&'static str> = OnceLock::new();
const STATUS_SUCCESS: &str = "20000000";
/// 正在处理 / 排队中：只有这两个码才值得继续等。
const STATUS_PROCESSING: &str = "20000001";
const STATUS_QUEUED: &str = "20000002";
/// 静音音频：服务端已经处理完了，结论是「这段没有人说话」。
///
/// 原来把 2000000x 一律当「处理中」，于是这个**终态**会被一直轮询到超时——
/// 30 分钟一段，外面还包着两次重试，一段静音能拖掉 90 分钟。
const STATUS_SILENT: &str = "20000003";
/// 「quota exceeded」：后面跟着超的是哪一类额度。`types:qps` / 并发是限流——等一等、
/// 放慢就好；别的类型（时长、资源包）是额度真用完了，等多久都不会好。
const STATUS_QUOTA_EXCEEDED: &str = "45000292";
const STATUS_HEADER: &str = "X-Api-Status-Code";
const MESSAGE_HEADER: &str = "X-Api-Message";
const POLL_INTERVAL: Duration = Duration::from_secs(3);
/// 轮询的总时长上限（从提交成功算起）。被限流时每次要多等一会儿，按次数算上限的话
/// 会被拉得很长，所以按墙上时间算。
const POLL_DEADLINE: Duration = Duration::from_secs(30 * 60);
/// 被限流后再问之前，最多等这么久。
const MAX_THROTTLE_BACKOFF: Duration = Duration::from_secs(30);
/// 提交被限流时最多再提交几次。限流拒掉的提交没建任务、不计费，多试几次没有代价。
const MAX_THROTTLED_SUBMITS: u32 = 8;
/// 单个 HTTP 请求的上限。没有它时，一次卡死的连接可以挂到天荒地老，
/// 所谓「30 分钟上限」只是轮询次数上限，根本不是真的 deadline。
const SUBMIT_TIMEOUT: Duration = Duration::from_secs(300);
const QUERY_TIMEOUT: Duration = Duration::from_secs(60);
/// 轮询期间允许连续多少次网络抖动。超过就放弃这一段——但**不会**重新提交。
const MAX_QUERY_HICCUPS: u32 = 5;

/// 所有火山请求（各分段的提交和轮询）共用的节拍器。
///
/// 平时不限速；一旦服务端说「QPS 超了」，就给请求之间加上间隔并逐次翻倍，之后每成功
/// 一次就收窄一点。分段识别好几路一起轮询，单靠各路自己退避，一放开又一起撞上去——
/// 只有大家排同一个队才真的把总请求率降下来。
struct Pacer {
    next: std::time::Instant,
    gap: Duration,
}

const PACER_MIN_GAP: Duration = Duration::from_millis(500);
const PACER_MAX_GAP: Duration = Duration::from_secs(5);

impl Pacer {
    fn new(now: std::time::Instant) -> Self {
        Pacer {
            next: now,
            gap: Duration::ZERO,
        }
    }

    /// 占一个发送时刻，返回还要等多久。
    fn reserve(&mut self, now: std::time::Instant) -> Duration {
        let at = self.next.max(now);
        self.next = at + self.gap;
        at - now
    }

    fn throttled(&mut self) {
        self.gap = (self.gap * 2).clamp(PACER_MIN_GAP, PACER_MAX_GAP);
    }

    fn succeeded(&mut self) {
        self.gap = self.gap.mul_f32(0.85);
        if self.gap < Duration::from_millis(50) {
            self.gap = Duration::ZERO;
        }
    }
}

fn pacer() -> &'static std::sync::Mutex<Pacer> {
    static PACER: OnceLock<std::sync::Mutex<Pacer>> = OnceLock::new();
    PACER.get_or_init(|| std::sync::Mutex::new(Pacer::new(std::time::Instant::now())))
}

/// 发请求之前排队。
async fn pace() {
    let wait = pacer()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .reserve(std::time::Instant::now());
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
}

fn pace_throttled() {
    pacer()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .throttled();
}

fn pace_succeeded() {
    pacer()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .succeeded();
}

/// 服务端是不是在说「请求太频繁」（QPS / 并发超限）。这不是请求本身有问题，
/// 等一会儿、放慢再问就好。
fn is_rate_limited(status: Option<&str>, message: Option<&str>, http: reqwest::StatusCode) -> bool {
    let message = message.unwrap_or_default().to_ascii_lowercase();
    let throttle_words =
        message.contains("qps") || message.contains("concurren") || message.contains("rate limit");
    match status {
        Some(STATUS_QUOTA_EXCEEDED) => throttle_words || message.is_empty(),
        Some(code) if code.starts_with('2') => false,
        _ => http == reqwest::StatusCode::TOO_MANY_REQUESTS || throttle_words,
    }
}

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
    /// 提交被限流拒掉了：任务没建、没计费，等一会儿再提交是安全的。
    Throttled(AppError),
    /// 提交被明确拒绝，且换个说法去问也是同一个答复：App ID / Token 不对、资源没授权。
    ///
    /// 这类失败再提交一百遍也不会变好，回退重试只是把同一条错误多打印两遍。
    Rejected(AppError),
    AfterSubmit(AppError),
}

impl RecognizeFailure {
    fn into_error(self) -> AppError {
        match self {
            Self::BeforeSubmit(error)
            | Self::Throttled(error)
            | Self::Rejected(error)
            | Self::AfterSubmit(error) => error,
        }
    }

    fn is_resubmittable(&self) -> bool {
        matches!(self, Self::BeforeSubmit(_) | Self::Throttled(_))
    }
}

/// 分段识别默认参数：5 分钟一段、并发 4 路、每段指数回退重试两次。
pub const DEFAULT_CHUNK_SECS: u64 = 300;
pub const DEFAULT_CONCURRENCY: usize = 4;
const MAX_RETRIES: u32 = 2;

/// 整段上传识别（短音频、关闭分段，或 Android 无 ffmpeg 切片时用）。内部带指数回退
/// 重试两次。`format` 必须与音频真实容器一致（wav / mp3 …），会写进提交体的 audio.format。
///
/// 传了 `cache` 时和分段识别一样断点续跑：认完的结果、已经提交但还没拿到结果的任务
/// 都记下来，下次不必再付一次钱。
pub async fn run_volcengine_file(
    audio: &Path,
    app_id: &str,
    access_token: &str,
    context: Option<&str>,
    format: &str,
    cache: Option<&crate::pipeline::asr_cache::ChunkCache<'_>>,
) -> AppResult<WhisperJson> {
    let (app_id, access_token) = check_credentials(app_id, access_token)?;
    let audio_bytes = tokio::fs::read(audio).await?;
    let client = asr_client();
    cached_or_recognize(&audio_bytes, cache, || {
        recognize_bytes_with_retry(
            &client,
            &app_id,
            &access_token,
            &audio_bytes,
            context,
            format,
            cache,
        )
    })
    .await
}

/// 分段并行识别：把长音频按固定时长切成多段 MP3，分别提交、并行轮询，再按各段
/// 的时间偏移合并。相比整段上传更快——服务端可并行处理、单次上传体积也更小。
/// 每段都带「指数回退重试两次」，个别分段抖动不会让整条任务失败。
///
/// `progress` 收到「已完成几段 / 共几段」：长课切出二三十段、要认好几分钟，
/// 不报的话整段都停在开始识别那一刻的进度上，看着像卡死。
#[allow(clippy::too_many_arguments)] // 凭证/切片/并发/上下文/缓存/进度各有其义。
pub async fn run_volcengine_file_chunked(
    wav: &Path,
    app_id: &str,
    access_token: &str,
    chunk_secs: u64,
    concurrency: usize,
    context: Option<String>,
    cache: Option<&crate::pipeline::asr_cache::ChunkCache<'_>>,
    progress: Progress<'_>,
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
        let out = cached_or_recognize(&bytes, cache, || {
            recognize_bytes_with_retry(
                &client,
                &app_id,
                &access_token,
                &bytes,
                context.as_deref(),
                "mp3",
                cache,
            )
        })
        .await;
        let _ = tokio::fs::remove_dir_all(&chunk_dir).await;
        return out;
    }

    let client = asr_client();
    let total = chunks.len();
    report(progress, 0.0, &chunk_progress_message(0, total));
    let pending = futures_util::stream::iter(chunks.into_iter().enumerate().map(|(idx, path)| {
        let client = client.clone();
        let app_id = app_id.clone();
        let access_token = access_token.clone();
        let context = context.clone();
        async move {
            let bytes = tokio::fs::read(&path).await?;
            let json = cached_or_recognize(&bytes, cache, || {
                recognize_bytes_with_retry(
                    &client,
                    &app_id,
                    &access_token,
                    &bytes,
                    context.as_deref(),
                    "mp3",
                    cache,
                )
            })
            .await?;
            Ok((idx, json))
        }
    }))
    .buffer_unordered(concurrency);
    let results: Vec<AppResult<(usize, WhisperJson)>> =
        collect_reporting_progress(pending, total, progress).await;

    let _ = tokio::fs::remove_dir_all(&chunk_dir).await;

    // 任一段重试两次后仍失败 → 整体失败（避免悄悄丢字幕）。
    let mut parts: Vec<(usize, WhisperJson)> = Vec::with_capacity(results.len());
    for result in results {
        parts.push(result?);
    }
    Ok(merge_chunk_transcripts(parts, chunk_secs as i64 * 1000))
}

/// 逐个收齐分段结果，每认完一段报一次进度（谁先认完算谁，不按顺序）。
async fn collect_reporting_progress<S: futures_util::Stream>(
    results: S,
    total: usize,
    progress: Progress<'_>,
) -> Vec<S::Item> {
    let mut results = std::pin::pin!(results);
    let mut collected = Vec::with_capacity(total);
    while let Some(result) = results.next().await {
        collected.push(result);
        report(
            progress,
            collected.len() as f64 / total.max(1) as f64,
            &chunk_progress_message(collected.len(), total),
        );
    }
    collected
}

fn chunk_progress_message(done: usize, total: usize) -> String {
    format!("云端分段识别中（火山引擎），已完成 {done}/{total} 段")
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
    cache: Option<&crate::pipeline::asr_cache::ChunkCache<'_>>,
) -> Result<WhisperJson, RecognizeFailure> {
    // ---- 0. 上次已经提交过、钱也付了，只是没等到结果？先去问那个任务 ----
    if let Some(cache) = cache {
        if let Some((request_id, resource_id)) = cache.get_pending(audio_bytes).await {
            tracing::info!(%request_id, "这段音频上次已经提交过，先查那个任务，不再重复提交");
            match poll_until_done(client, app_id, access_token, &resource_id, &request_id).await {
                Ok(json) => return Ok(json),
                // 服务端不认这个任务了（过期、被清理）：只能重新提交。
                Err(failure) if failure.task_gone => {
                    tracing::warn!(%request_id, "上次的任务查不到了：{}；重新提交", failure.error);
                    cache.clear_pending(audio_bytes).await;
                }
                Err(failure) => return Err(RecognizeFailure::AfterSubmit(failure.error)),
            }
        }
    }

    let request_id = Uuid::new_v4().to_string();
    let body = build_submit_body(&request_id, &base64_encode(audio_bytes), context, format);

    // ---- 1. 提交任务 ----
    // 403 + 45000030 只说明「这个资源 ID 没授权给这个 App」，换个版本重发是安全的：
    // 请求根本没被受理，没建任务、没计费。所以先按 2.0 试，被拒就退回 1.0。
    let mut accepted: Option<&'static str> = None;
    let mut rejection: Option<AppError> = None;
    for resource_id in resource_candidates(RESOLVED_RESOURCE_ID.get().copied()) {
        pace().await;
        let resp = match client
            .post(SUBMIT_URL)
            .header("X-Api-App-Key", app_id)
            .header("X-Api-Access-Key", access_token)
            .header("X-Api-Resource-Id", resource_id)
            .header("X-Api-Request-Id", &request_id)
            .header("X-Api-Sequence", "-1")
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(error) => {
                return Err(RecognizeFailure::BeforeSubmit(AppError::Pipeline(format!(
                    "volcengine submit: {error}"
                ))))
            }
        };
        let status = header_value(&resp, STATUS_HEADER);
        let message = header_value(&resp, MESSAGE_HEADER);
        if status.as_deref() == Some(STATUS_SUCCESS) {
            let _ = RESOLVED_RESOURCE_ID.set(resource_id);
            pace_succeeded();
            accepted = Some(resource_id);
            break;
        }
        let http = resp.status();
        // 限流拒掉的提交没建任务、没计费：放慢节拍，交给外层等一会儿再提交。
        if is_rate_limited(status.as_deref(), message.as_deref(), http) {
            pace_throttled();
            return Err(RecognizeFailure::Throttled(submit_error(
                "submit",
                status,
                message,
                http,
                resource_id,
            )));
        }
        let not_granted = is_resource_not_granted(status.as_deref(), message.as_deref());
        let error = submit_error("submit", status, message, http, resource_id);
        if not_granted {
            rejection = Some(error);
            continue;
        }
        // Token 错、App ID 错：换个资源 ID 去问也是同一个答复，回退重试同样没意义。
        return Err(
            if http == reqwest::StatusCode::UNAUTHORIZED || http == reqwest::StatusCode::FORBIDDEN {
                RecognizeFailure::Rejected(error)
            } else {
                RecognizeFailure::BeforeSubmit(error)
            },
        );
    }
    let Some(resource_id) = accepted else {
        return Err(RecognizeFailure::Rejected(rejection.unwrap_or_else(|| {
            AppError::Pipeline("volcengine submit 失败：资源未授权".into())
        })));
    };

    // ---- 2. 轮询结果 ----
    // 从这里开始，云端任务已经存在并计费：无论出什么事都只能报错，不能换个
    // request_id 重来（那会变成第二个任务、第二笔账，原任务还在跑）。
    // 先把任务记下来：这次没等到结果（断网、被限流太久、App 被杀），下次直接接着查。
    if let Some(cache) = cache {
        cache
            .put_pending(audio_bytes, &request_id, resource_id)
            .await;
    }
    poll_until_done(client, app_id, access_token, resource_id, &request_id)
        .await
        .map_err(|failure| RecognizeFailure::AfterSubmit(failure.error))
}

/// 拿到一个查询状态码之后该怎么办。
#[derive(Debug, PartialEq)]
enum PollAction {
    /// 出结果了，去取正文。
    Take,
    /// 服务端的结论是「这段没人说话」。
    Silent,
    /// 还在排队/处理中，等一会儿再问。
    KeepWaiting,
    /// 服务端自己出错了。这一次没问到，但任务还在跑——记一次抖动，接着问。
    Hiccup,
    /// 问得太勤被限流了。任务照样在跑，放慢再问。
    Throttled,
    /// 参数错、鉴权失败之类：再问一百遍也是同一个答复。
    Fatal,
}

/// 业务状态码的首位标明是谁的问题，和 HTTP 一样：2 = 正常，4 = 请求方，5 = 服务端。
///
/// 关键是别把 5 开头的当终态。那类错误（真实遇到的是 55000000，网关取不到到后端的
/// 连接）几秒后就自愈，而放弃的代价极不对称：这段音频已经付过钱了，扔掉要重付一次。
/// 网关有时只返回 HTTP 状态而没有业务状态头；这时 429/5xx 也属于可恢复抖动。
///
/// 限流（QPS 超了）单独一类：它是 4 开头的，按上面的规矩会被当成终态——真实遇到过：
/// 分段识别几路一起轮询，一次「quota exceeded types:qps」就把整个视频判失败，
/// 而每一段都已经提交、扣过额度了。
fn classify_poll_status(
    status: Option<&str>,
    message: Option<&str>,
    http: reqwest::StatusCode,
) -> PollAction {
    if is_rate_limited(status, message, http) {
        return PollAction::Throttled;
    }
    match status {
        Some(STATUS_SUCCESS) => PollAction::Take,
        Some(STATUS_SILENT) => PollAction::Silent,
        Some(STATUS_PROCESSING) | Some(STATUS_QUEUED) => PollAction::KeepWaiting,
        Some(code) if code.starts_with('5') => PollAction::Hiccup,
        Some(_) => PollAction::Fatal,
        None if http == reqwest::StatusCode::TOO_MANY_REQUESTS || http.is_server_error() => {
            PollAction::Hiccup
        }
        None => PollAction::Fatal,
    }
}

/// 轮询失败。`task_gone`：服务端明确答复了一个终态错误（任务不存在、参数错……），
/// 这个 request_id 再问也没用；其余（网络、服务端错误、限流太久、超时）任务可能还在跑。
struct PollFailure {
    error: AppError,
    task_gone: bool,
}

impl PollFailure {
    fn retryable(error: AppError) -> Self {
        PollFailure {
            error,
            task_gone: false,
        }
    }
}

/// 轮询同一个 request_id 直到出结果。网络抖动、限流就地重试，绝不换 id。
async fn poll_until_done(
    client: &reqwest::Client,
    app_id: &str,
    access_token: &str,
    resource_id: &str,
    request_id: &str,
) -> Result<WhisperJson, PollFailure> {
    let started = std::time::Instant::now();
    let mut hiccups = 0u32;
    let mut throttles = 0u32;
    while started.elapsed() < POLL_DEADLINE {
        pace().await;
        let sent = client
            .post(QUERY_URL)
            .timeout(QUERY_TIMEOUT)
            .header("X-Api-App-Key", app_id)
            .header("X-Api-Access-Key", access_token)
            .header("X-Api-Resource-Id", resource_id)
            .header("X-Api-Request-Id", request_id)
            .header("X-Api-Sequence", "-1")
            .json(&json!({}))
            .send()
            .await;
        // 计数只在**问到了可用答复**（处理中/排队中）时归零，收到响应本身不算数：
        // 服务端错误是裹在一个 HTTP 200 里回来的，在这里归零的话，一串 5xx 会把
        // 上限彻底架空，一路空转到 30 分钟的轮询上限。
        let resp = match sent {
            Ok(resp) => resp,
            // 查询请求本身没发出去/超时：任务还在云端跑着，接着问就是了。
            // 原来这里直接报错，外层会把整段音频重新提交一次——白花一份钱。
            Err(error) => {
                hiccups += 1;
                if hiccups > MAX_QUERY_HICCUPS {
                    return Err(PollFailure::retryable(AppError::Pipeline(format!(
                        "volcengine query 连续 {MAX_QUERY_HICCUPS} 次失败：{error}"
                    ))));
                }
                tracing::warn!("volcengine query 第 {hiccups} 次网络失败：{error}；稍后再查");
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
        };
        let status = header_value(&resp, STATUS_HEADER);
        let message = header_value(&resp, MESSAGE_HEADER);
        match classify_poll_status(status.as_deref(), message.as_deref(), resp.status()) {
            PollAction::Take => {
                pace_succeeded();
                let payload: Value = resp.json().await.map_err(|error| {
                    PollFailure::retryable(AppError::Pipeline(format!(
                        "volcengine query decode: {error}"
                    )))
                })?;
                return response_payload_to_transcript(&payload).map_err(PollFailure::retryable);
            }
            // 服务端说这段没有人说话。这是终态，不是「还在处理」：接着轮询只会
            // 一路等到超时。返回空字幕即可——长音频是分段识别的，中间夹一段静音
            // 很正常，不该让整个视频失败。
            PollAction::Silent => {
                tracing::info!(request_id, "volcengine 判定该段为静音，返回空字幕");
                return Ok(WhisperJson {
                    transcription: Vec::new(),
                });
            }
            PollAction::KeepWaiting => {
                hiccups = 0;
                throttles = 0;
                pace_succeeded();
                tokio::time::sleep(POLL_INTERVAL).await;
            }
            // 问得太勤了。任务还在跑、钱已经付了，这时放弃最亏：放慢大家的节拍，
            // 自己也退避一会儿再问（3、6、12……最多 30 秒），直到总时长上限。
            PollAction::Throttled => {
                pace_throttled();
                throttles += 1;
                let backoff = (POLL_INTERVAL * 2u32.saturating_pow(throttles.min(5)))
                    .min(MAX_THROTTLE_BACKOFF);
                tracing::warn!(
                    request_id,
                    "volcengine query 被限流（{}：{}）；{:?} 后再查",
                    status.as_deref().unwrap_or(""),
                    message.as_deref().unwrap_or(""),
                    backoff
                );
                tokio::time::sleep(backoff).await;
            }
            // 服务端自己出错。这和上面「查询请求根本没发出去」是同一件事：这一次没
            // 问到结果，任务却还在云端跑着；区别只是失败被裹在一个 HTTP 200 里报回来，
            // 对我们没有意义。原来它落进下面的兜底分支当场判死，而这段音频已经付过
            // 钱了——放弃等于把它扔掉，重来还要再付一次。接着问只花几秒，外层 30 分钟
            // 的轮询上限照样兜着底。
            PollAction::Hiccup => {
                hiccups += 1;
                if hiccups > MAX_QUERY_HICCUPS {
                    return Err(PollFailure::retryable(submit_error(
                        "query",
                        status,
                        message,
                        resp.status(),
                        resource_id,
                    )));
                }
                tracing::warn!(
                    request_id,
                    "volcengine query 第 {hiccups} 次返回服务端错误 {}：{}；稍后再查",
                    status.as_deref().unwrap_or(""),
                    message.as_deref().unwrap_or("")
                );
                tokio::time::sleep(POLL_INTERVAL).await;
            }
            PollAction::Fatal => {
                return Err(PollFailure {
                    error: submit_error("query", status, message, resp.status(), resource_id),
                    task_gone: true,
                });
            }
        }
    }
    Err(PollFailure::retryable(AppError::Pipeline(
        "volcengine 录音文件识别轮询超时（超过 30 分钟仍未返回结果）；任务已经记下，重新处理时会接着查，不会重复扣费".into(),
    )))
}

/// 先看这一片之前认过没有；没有才真的去认，认完记下来。
///
/// 断点续跑就靠这一层：中途退出时，已经认完、已经付过钱的分片留在库里，下次直接取回。
/// 缓存本身是尽力而为的——读写出任何问题都只退化成「重认一遍」，不会让识别失败。
async fn cached_or_recognize<F, Fut>(
    audio_bytes: &[u8],
    cache: Option<&crate::pipeline::asr_cache::ChunkCache<'_>>,
    recognize: F,
) -> AppResult<WhisperJson>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = AppResult<WhisperJson>>,
{
    if let Some(cache) = cache {
        if let Some(hit) = cache.get(audio_bytes).await {
            tracing::info!("命中上次中断前已识别的分片，跳过一次云端调用");
            return Ok(hit);
        }
    }
    let json = recognize().await?;
    // 认完就存，别等整份合并完——「等全部认完再一起落库」正是中断后从头再来的原因。
    if let Some(cache) = cache {
        cache.put(audio_bytes, &json).await;
    }
    Ok(json)
}

/// 在 recognize_bytes 外包一层指数回退重试：失败后等 2s、4s 再试，最多重试两次。
///
/// **只重试提交阶段的失败**。提交成功之后的任何失败都直接上报：那时云端任务已经
/// 建好并开始计费，重来一遍等于同一段音频付两次钱，而且两个任务会并行跑。
#[allow(clippy::too_many_arguments)] // 凭证/音频/上下文/格式/缓存各有其义。
async fn recognize_bytes_with_retry(
    client: &reqwest::Client,
    app_id: &str,
    access_token: &str,
    audio_bytes: &[u8],
    context: Option<&str>,
    format: &str,
    cache: Option<&crate::pipeline::asr_cache::ChunkCache<'_>>,
) -> AppResult<WhisperJson> {
    let mut attempt = 0u32;
    let mut throttled = 0u32;
    loop {
        match recognize_bytes(
            client,
            app_id,
            access_token,
            audio_bytes,
            context,
            format,
            cache,
        )
        .await
        {
            Ok(value) => return Ok(value),
            // 提交被限流：没建任务、没计费，多等几次也不花钱。
            Err(RecognizeFailure::Throttled(error)) if throttled < MAX_THROTTLED_SUBMITS => {
                throttled += 1;
                let backoff = (Duration::from_secs(5) * 2u32.saturating_pow(throttled.min(3)))
                    .min(MAX_THROTTLE_BACKOFF);
                tracing::warn!(
                    "volcengine 提交被限流（第 {throttled} 次）：{error}；{backoff:?} 后再提交"
                );
                tokio::time::sleep(backoff).await;
            }
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
    let status = crate::sidecar::command(&ffmpeg)
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
    resource_id: &str,
) -> AppError {
    let status = status.unwrap_or_else(|| http.as_u16().to_string());
    let message = message.unwrap_or_default();
    // 45000030 是最容易被误判的一条：它长得和鉴权失败一模一样（403 + not granted），
    // 真正原因却是「资源 ID 和开通的模型版本对不上」。所以提示里必须把两个 ID 都点明，
    // 否则用户只会去反复核对 App ID / Token —— 核对到天亮也没用。
    let hint = if is_resource_not_granted(Some(&status), Some(&message)) {
        "（资源未授权：模型版本对不上，不是 App ID / Access Token 写错。\
         开通「豆包录音文件识别模型2.0」要发 volc.seedasr.auc，开通 1.0 才是 \
         volc.bigasr.auc；应用会自动依次试这两个。两个都被拒时请确认这个 App ID 就是\
         开通了该服务的那个应用，且账号已实名）"
    } else if is_rate_limited(Some(&status), Some(&message), http) {
        "（请求太频繁，超过了账号的 QPS 限制；已经自动放慢重试仍不行时，把设置里的分段并发数调小）"
    } else if status == STATUS_QUOTA_EXCEEDED {
        "（账号的识别额度用完了：请到火山引擎控制台查看资源包 / 余额）"
    } else if http == reqwest::StatusCode::UNAUTHORIZED || http == reqwest::StatusCode::FORBIDDEN {
        "（鉴权失败：请核对 App ID / Access Token，并确认控制台已开通「录音文件识别大模型」）"
    } else {
        ""
    };
    AppError::Pipeline(format!(
        "volcengine {stage} 失败：状态码 {status} {message}（resource_id={resource_id}）{hint}"
    ))
}

/// 服务端是不是说「这个资源 ID 没授权给这个 App」。
///
/// 除业务码外还认消息文本：网关拦下来时有时只回 HTTP 403，不带 `X-Api-Status-Code`。
fn is_resource_not_granted(status: Option<&str>, message: Option<&str>) -> bool {
    status == Some(STATUS_RESOURCE_NOT_GRANTED)
        || message.is_some_and(|text| text.contains("not granted"))
}

/// 这次提交按什么顺序试资源 ID：本进程里已经试通过的那个排最前，另一个当回退。
///
/// 分段识别会并发提交十几段，记住结果能让后面的段一次成功，不必每段先撞一次 403。
fn resource_candidates(resolved: Option<&'static str>) -> Vec<&'static str> {
    let mut ids = vec![RESOURCE_ID_V2, RESOURCE_ID_V1];
    if let Some(known) = resolved {
        ids.retain(|id| *id != known);
        ids.insert(0, known);
    }
    ids
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

    async fn cache_fixture(dir: &tempfile::TempDir) -> (crate::db::Db, String) {
        let db = crate::db::Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course = crate::commands::courses::create_course(
            &db,
            "c".into(),
            dir.path().to_string_lossy().into(),
        )
        .await
        .unwrap();
        let path = dir.path().join("v.mp4");
        std::fs::write(&path, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, path, None)
            .await
            .unwrap();
        (db, video.id)
    }

    #[tokio::test]
    async fn a_recognized_chunk_is_stored_right_away_and_reused_next_time() {
        // 断点续跑的两半，缺一半就等于没做：
        //   认完立刻存（不是等整份合并完才落库——那正是中断后从头再来的原因）；
        //   下次先查缓存，命中就不再走云端。
        let dir = tempfile::tempdir().unwrap();
        let (db, video_id) = cache_fixture(&dir).await;
        let cache = crate::pipeline::asr_cache::ChunkCache {
            db: &db,
            video_id: &video_id,
            params: "volcengine-auc|".into(),
        };
        let audio = b"pretend-mp3-bytes";

        // 第一次：没认过，走识别，结果应当当场落库。
        let first = cached_or_recognize(audio, Some(&cache), || async {
            Ok(maps_one_segment("这一片认出来的话"))
        })
        .await
        .unwrap();
        assert_eq!(first.transcription[0].text, "这一片认出来的话");
        assert!(
            cache.get(audio).await.is_some(),
            "认完必须立刻存，否则中断后这一片的钱白花"
        );

        // 第二次（模拟中断后重来）：必须走缓存。这里的识别闭包一旦被调用就直接失败，
        // 所以能拿到结果就证明它没去调云端。
        let second = cached_or_recognize(audio, Some(&cache), || async {
            Err(AppError::Pipeline("不该走到这里：应当命中缓存".into()))
        })
        .await
        .unwrap();
        assert_eq!(second.transcription[0].text, "这一片认出来的话");
    }

    #[tokio::test]
    async fn without_a_cache_it_just_recognizes_as_before() {
        // 没有缓存句柄时（整段上传模式等）行为不变，不该因为多了这一层就出事。
        let out = cached_or_recognize(b"bytes", None, || async { Ok(maps_one_segment("照常")) })
            .await
            .unwrap();
        assert_eq!(out.transcription[0].text, "照常");
    }

    #[test]
    fn only_a_failed_submit_may_be_retried() {
        // 提交没成功 = 云端没有任务，整段重来是安全的。
        assert!(RecognizeFailure::BeforeSubmit(AppError::Pipeline("x".into())).is_resubmittable());
        // 提交成功之后的任何失败（查询超时、解析出错）都不能重来：任务已经在云端
        // 跑着并计费，换个 request_id 重来会变成第二个任务、第二笔账。
        assert!(!RecognizeFailure::AfterSubmit(AppError::Pipeline("x".into())).is_resubmittable());
        // 资源没授权 / Token 不对：再提交一百遍也是同一句话，不必回退重试。
        assert!(!RecognizeFailure::Rejected(AppError::Pipeline("x".into())).is_resubmittable());
    }

    #[test]
    fn both_model_versions_are_tried_with_the_new_one_first() {
        // 控制台现在默认开通 2.0，所以先试 volc.seedasr.auc；被拒再退 1.0。
        // 反过来先试 1.0 的话，新账号每次都要先吃一个 403。
        assert_eq!(
            resource_candidates(None),
            vec![RESOURCE_ID_V2, RESOURCE_ID_V1]
        );
        assert_eq!(RESOURCE_ID_V2, "volc.seedasr.auc");
        assert_eq!(RESOURCE_ID_V1, "volc.bigasr.auc");
        // 已经试通过的那个排最前——分段识别十几段并发提交，别每段都先撞一次 403。
        assert_eq!(
            resource_candidates(Some(RESOURCE_ID_V1)),
            vec![RESOURCE_ID_V1, RESOURCE_ID_V2]
        );
        // 两个都还在候选里：授权被改过（比如 1.0 到期、2.0 开通）时仍能自愈。
        assert_eq!(resource_candidates(Some(RESOURCE_ID_V2)).len(), 2);
    }

    #[test]
    fn a_not_granted_reply_is_told_apart_from_a_credential_typo() {
        // 真实遇到的那一条：403 + 45000030 + "requested resource not granted"。
        assert!(is_resource_not_granted(
            Some("45000030"),
            Some("[resource_id=volc.bigasr.auc] requested resource not granted")
        ));
        // 网关只回 HTTP 403、没带业务码头时，靠消息文本也要认出来。
        assert!(is_resource_not_granted(
            None,
            Some("[resource_id=volc.bigasr.auc] requested resource not granted")
        ));
        // 别的 4 开头错误（参数错）不是资源问题，不该触发换版本重试。
        assert!(!is_resource_not_granted(
            Some("45000001"),
            Some("invalid request")
        ));
        assert!(!is_resource_not_granted(None, None));
    }

    #[test]
    fn the_not_granted_error_names_both_resource_ids() {
        // 报错只写「鉴权失败，请核对 App ID / Token」会把用户带到死胡同：
        // 真实原因只是模型版本和资源 ID 对不上。提示里必须直接给出两个 ID。
        let error = submit_error(
            "submit",
            Some("45000030".into()),
            Some("[resource_id=volc.bigasr.auc] requested resource not granted".into()),
            reqwest::StatusCode::FORBIDDEN,
            RESOURCE_ID_V1,
        )
        .to_string();
        assert!(error.contains("volc.seedasr.auc"), "{error}");
        assert!(error.contains("volc.bigasr.auc"), "{error}");
        assert!(error.contains("45000030"), "{error}");
        assert!(error.contains("模型版本"), "{error}");
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
    fn a_server_side_status_is_a_hiccup_not_a_verdict() {
        // 真实遇到的那一条：55000000，网关取不到到后端的连接（POOL_FAILURE），
        // 几秒后自愈。原来任何不认识的状态码都当场判死——而这一段音频已经付过钱了，
        // 放弃等于把它扔掉，重来还要再付一次；接着问只花几秒。
        assert_eq!(
            classify_poll_status(Some("55000000"), None, reqwest::StatusCode::OK),
            PollAction::Hiccup
        );
        assert_eq!(
            classify_poll_status(Some("55000031"), None, reqwest::StatusCode::BAD_GATEWAY),
            PollAction::Hiccup
        );
    }

    #[test]
    fn a_caller_side_status_is_still_final() {
        // 4 开头是我们自己的问题（参数错、鉴权失败、音频格式不对），再问一百遍
        // 也是同一个答复。把它也当抖动的话，一个必败的请求要空转到轮询上限才收场。
        assert_eq!(
            classify_poll_status(Some("45000001"), None, reqwest::StatusCode::OK),
            PollAction::Fatal
        );
        assert_eq!(
            classify_poll_status(Some("45000151"), None, reqwest::StatusCode::BAD_GATEWAY),
            PollAction::Fatal
        );
        // 正常响应没有业务状态码，或请求本身被拒绝，都没有可等待的任务状态。
        assert_eq!(
            classify_poll_status(None, None, reqwest::StatusCode::OK),
            PollAction::Fatal
        );
        assert_eq!(
            classify_poll_status(None, None, reqwest::StatusCode::UNAUTHORIZED),
            PollAction::Fatal
        );
    }

    #[test]
    fn being_rate_limited_is_waited_out_not_a_verdict() {
        // 真实遇到的那一条：分段识别几路一起轮询，查询被限流。
        assert_eq!(
            classify_poll_status(
                Some("45000292"),
                Some("quota exceeded for types: qps"),
                reqwest::StatusCode::OK
            ),
            PollAction::Throttled
        );
        assert_eq!(
            classify_poll_status(None, None, reqwest::StatusCode::TOO_MANY_REQUESTS),
            PollAction::Throttled
        );
        // 同一个码、超的是别的额度（资源包 / 时长用完）：等多久都不会好。
        assert_eq!(
            classify_poll_status(
                Some("45000292"),
                Some("quota exceeded for types: duration"),
                reqwest::StatusCode::OK
            ),
            PollAction::Fatal
        );
    }

    #[test]
    fn the_quota_errors_explain_what_ran_out() {
        let qps = submit_error(
            "query",
            Some("45000292".into()),
            Some("quota exceeded for types: qps".into()),
            reqwest::StatusCode::OK,
            RESOURCE_ID_V2,
        )
        .to_string();
        assert!(qps.contains("QPS"), "{qps}");
        let used_up = submit_error(
            "submit",
            Some("45000292".into()),
            Some("quota exceeded for types: duration".into()),
            reqwest::StatusCode::OK,
            RESOURCE_ID_V2,
        )
        .to_string();
        assert!(used_up.contains("额度用完"), "{used_up}");
    }

    #[test]
    fn the_pacer_spaces_requests_after_a_throttle_and_relaxes_after_successes() {
        let t0 = std::time::Instant::now();
        let mut pacer = Pacer::new(t0);
        // 平时不限速。
        assert_eq!(pacer.reserve(t0), Duration::ZERO);
        assert_eq!(pacer.reserve(t0), Duration::ZERO);
        pacer.throttled();
        pacer.throttled();
        assert_eq!(pacer.gap, Duration::from_secs(1));
        // 同一时刻三个请求排队：依次错开一个间隔。
        let waits: Vec<_> = (0..3).map(|_| pacer.reserve(t0)).collect();
        assert_eq!(
            waits,
            vec![
                Duration::ZERO,
                Duration::from_secs(1),
                Duration::from_secs(2)
            ]
        );
        for _ in 0..40 {
            pacer.succeeded();
        }
        assert_eq!(pacer.gap, Duration::ZERO);
        for _ in 0..20 {
            pacer.throttled();
        }
        assert_eq!(pacer.gap, PACER_MAX_GAP);
    }

    #[test]
    fn a_throttled_submit_may_be_resubmitted() {
        assert!(RecognizeFailure::Throttled(AppError::Pipeline("x".into())).is_resubmittable());
    }

    #[test]
    fn an_http_gateway_failure_without_a_business_status_is_a_hiccup() {
        for http in [
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            reqwest::StatusCode::BAD_GATEWAY,
            reqwest::StatusCode::SERVICE_UNAVAILABLE,
            reqwest::StatusCode::GATEWAY_TIMEOUT,
        ] {
            assert_eq!(classify_poll_status(None, None, http), PollAction::Hiccup);
        }
    }

    #[test]
    fn the_four_known_statuses_keep_their_meaning() {
        assert_eq!(
            classify_poll_status(Some(STATUS_SUCCESS), None, reqwest::StatusCode::OK),
            PollAction::Take
        );
        assert_eq!(
            classify_poll_status(Some(STATUS_SILENT), None, reqwest::StatusCode::OK),
            PollAction::Silent
        );
        for code in [STATUS_PROCESSING, STATUS_QUEUED] {
            assert_eq!(
                classify_poll_status(Some(code), None, reqwest::StatusCode::OK),
                PollAction::KeepWaiting
            );
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

    /// 分段识别要逐段报进度，谁先认完报谁。此前整段停在开始识别时的进度上，
    /// 两小时的课认好几分钟，看着像卡死。
    #[tokio::test]
    async fn chunk_progress_counts_completed_segments() {
        let seen = std::sync::Mutex::new(Vec::new());
        let sink = |at: f64, message: &str| seen.lock().unwrap().push((at, message.to_string()));
        let results =
            collect_reporting_progress(futures_util::stream::iter(["b", "a", "c"]), 3, Some(&sink))
                .await;
        assert_eq!(results, ["b", "a", "c"]);
        let seen = seen.into_inner().unwrap();
        let fractions: Vec<f64> = seen.iter().map(|(at, _)| *at).collect();
        assert_eq!(fractions, [1.0 / 3.0, 2.0 / 3.0, 1.0]);
        assert_eq!(seen[1].1, "云端分段识别中（火山引擎），已完成 2/3 段");
    }
}
