pub mod ai;
pub mod aliyun_asr;
pub mod aliyun_ocr;
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub mod apple_vision;
pub mod asr;
pub mod asr_cache;
pub mod assistant;
pub mod audio;
pub mod bilibili_cache;
pub mod bilibili_extra;
pub mod concepts;
pub mod crop_detect;
pub mod deepseek_ocr;
pub mod download;
pub mod explain;
pub mod feynman;
pub mod handout;
pub mod highlights;
pub mod llama_asr;
pub mod local_asr;
pub mod media_kind;
pub mod model_store;
pub mod ocr;
pub mod playable;
pub mod quiz;
pub mod rag;
pub mod search_terms;
pub mod sherpa_asr;
pub mod silence;
pub mod slide_match;
pub mod slides;
pub mod subscriptions;
pub mod subtitle;
pub mod transcript_correction;
pub mod translate;
pub mod volcengine_asr;
pub mod volcengine_auc;
pub mod whisper_cleanup;

use crate::commands::courses::AppState;
use crate::commands::videos::Video;
use crate::error::{AppError, AppResult};
use crate::jobs::{self, emit_update, JobEvent};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AsrBackend {
    Whisper,
    Volcengine,
    Aliyun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TranscriptCorrectionOutcome {
    Applied,
    NoProvider,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VolcengineUploadMode {
    WholeFile,
    Chunked,
}

/// 云端整段识别交上去就只能干等，这段进度按耗时往前爬（见 [`ai::creep_while`]）。
/// 每分钟一成，从 28% 起六分钟爬到 88%：和原先前端估算的快慢一样。
const CLOUD_ASR_CREEP: std::time::Duration = std::time::Duration::from_secs(6 * 60);

fn asr_done_message(count: usize, outcome: TranscriptCorrectionOutcome) -> String {
    match outcome {
        TranscriptCorrectionOutcome::Applied => format!("{count} segments"),
        TranscriptCorrectionOutcome::NoProvider => {
            format!("{count} segments；未配置大模型，当前为原始文稿")
        }
        TranscriptCorrectionOutcome::Failed => {
            format!("{count} segments；AI 纠错失败，已保留原始文稿")
        }
    }
}

/// 把用户填的热词（按行，或中英文逗号、顿号分隔）切成去空、去重的词表。
fn split_terms(raw: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    raw.split(['\n', '\r', ',', '，', '、'])
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .filter(|term| seen.insert(term.to_string()))
        .map(str::to_string)
        .collect()
}

fn asr_backend_or_default(value: Option<String>) -> AsrBackend {
    asr_backend_for_os(value, std::env::consts::OS)
}

fn asr_backend_for_os(value: Option<String>, os: &str) -> AsrBackend {
    match value.as_deref().map(str::trim) {
        Some("volcengine") => AsrBackend::Volcengine,
        Some("aliyun") => AsrBackend::Aliyun,
        // 「本地识别」：桌面上 Whisper 和 sherpa 模型都能用，手机上只有 sherpa 模型（SenseVoice / Qwen3-ASR）。
        Some("whisper") => AsrBackend::Whisper,
        _ => default_asr_backend_for_os(os),
    }
}

fn default_asr_backend_for_os(os: &str) -> AsrBackend {
    if is_mobile_os(os) {
        AsrBackend::Aliyun
    } else {
        AsrBackend::Whisper
    }
}

fn is_mobile_os(os: &str) -> bool {
    os == "android" || os == "ios"
}

fn volcengine_upload_mode_for_os(os: &str) -> VolcengineUploadMode {
    if is_mobile_os(os) {
        VolcengineUploadMode::WholeFile
    } else {
        VolcengineUploadMode::Chunked
    }
}

/// 本地识别这次用哪个模型。
#[derive(Debug)]
pub(crate) enum LocalModel {
    Sherpa(&'static local_asr::SherpaModel),
}

impl LocalModel {
    fn id(&self) -> &str {
        match self {
            LocalModel::Sherpa(model) => model.id,
        }
    }
}

/// 没选过模型时的默认值：中文讲课上 SenseVoice 又快又准（docs/asr-benchmark）。
/// 没装它也不要紧——下面会退到已经装好的任何一个模型。
pub(crate) const DEFAULT_LOCAL_MODEL: &str = "sensevoice";

/// 选中的装好了、也认得这门课的语言就用它；否则退到别的已装模型。
///
/// 设置里可能还存着已经不支持的 Whisper 模型（tiny、base…），找不到就当没选，同样退到已装的模型。
/// `models_root` 是模型存放目录（用户可以换到别的盘）。
fn select_local_model(models_root: &Path, preferred_id: &str, language: &str) -> Option<LocalModel> {
    // 手机上看内存：装好了、认得语言，还得放得下——否则 iOS 直接把应用杀掉（闪退）。
    let available_mb = local_asr::available_memory_mb();
    let usable = |model: &'static local_asr::SherpaModel| {
        (local_asr::is_installed(models_root, model)
            && model.supports_language(language)
            && model.fits_memory(available_mb))
        .then_some(LocalModel::Sherpa(model))
    };
    local_asr::find(preferred_id)
        .and_then(usable)
        .or_else(|| local_asr::MODELS.iter().copied().find_map(usable))
}

/// 本地识别用不用 GPU（设置项 `asr_gpu`，默认开）。只影响桌面上的 Qwen3-ASR（llama.cpp）。
async fn asr_use_gpu(db: &crate::db::Db) -> bool {
    setting(db, "asr_gpu").await.ok().flatten().as_deref() != Some("false")
}

/// 本地识别同一时刻只跑一个视频。
///
/// 一个 Qwen3-ASR（llama-server，4 路并发）已经能把显卡吃满；几个视频同时识别时，后起的
/// 抢不到显存会退回 CPU——用户看到的是「GPU 没启动」，整台电脑卡住，总耗时反而更长。
/// SenseVoice 跑在 CPU 上，同时跑几份也只是互相抢核。排队一个个来，其余视频的课件、
/// AI 步骤照常并行。
static LOCAL_ASR: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[allow(clippy::too_many_arguments)]
/// 用选好的本地模型识别一段 16kHz 单声道 WAV。前面有视频在本地识别时先排队，
/// 排队期间调用一次 `on_wait`（流水线拿它把「排队等待本地识别」报给界面）。
async fn run_local_model(
    models_root: &Path,
    model: &LocalModel,
    audio: &Path,
    language: &str,
    hotwords: &[String],
    use_gpu: bool,
    progress: ai::Progress<'_>,
    on_wait: Option<&(dyn Fn() + Send + Sync)>,
) -> AppResult<asr::WhisperJson> {
    let _permit = match LOCAL_ASR.try_acquire() {
        Ok(permit) => permit,
        Err(_) => {
            if let Some(on_wait) = on_wait {
                on_wait();
            }
            LOCAL_ASR
                .acquire()
                .await
                .map_err(|_| AppError::Pipeline("本地识别队列已关闭".into()))?
        }
    };
    match model {
        LocalModel::Sherpa(model) if model.kind == local_asr::SherpaKind::Qwen3AsrGguf => {
            let job = llama_asr::LlamaJob {
                audio: audio.to_path_buf(),
                model_dir: local_asr::model_dir(models_root, model),
                vad: local_asr::vad_path(models_root),
                language: Some(language.to_string()),
                hotwords: local_asr::qwen3_hotwords(hotwords),
                use_gpu,
            };
            let silent = |_: f64, _: &str| {};
            llama_asr::transcribe(job, progress.unwrap_or(&silent)).await
        }
        LocalModel::Sherpa(model) => {
            let job = sherpa_asr::SherpaJob {
                audio: audio.to_path_buf(),
                model,
                model_dir: local_asr::model_dir(models_root, model),
                vad: local_asr::vad_path(models_root),
                language: Some(language.to_string()),
                hotwords: local_asr::qwen3_hotwords(hotwords),
            };
            sherpa_asr::transcribe(job, progress).await
        }
    }
}

fn whisper_language_or_default(value: Option<String>) -> String {
    value
        .filter(|language| !language.trim().is_empty())
        .unwrap_or_else(|| "zh".into())
}

async fn setting(db: &crate::db::Db, key: &str) -> AppResult<Option<String>> {
    Ok(sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key=?")
        .bind(key)
        .fetch_optional(&db.pool)
        .await?)
}

/// 识别一小段录音（费曼复述：用户对着麦克风讲的一两分钟），返回整段文字。
///
/// 走用户在设置里选的同一个识别引擎，但不经过视频处理流水线：没有任务、没有进度、
/// 不落库、不纠错。桌面先用 ffmpeg 转成引擎要的格式；手机上没有 ffmpeg，
/// 录音本身（AAC / WebM）直接交给云端引擎。
pub async fn transcribe_clip(
    app: &tauri::AppHandle,
    db: &crate::db::Db,
    input: &Path,
    mime: &str,
    work_dir: &Path,
) -> AppResult<String> {
    let backend = asr_backend_or_default(setting(db, "asr_backend").await?);
    let mobile = matches!(std::env::consts::OS, "ios" | "android");
    // 手机上没有 ffmpeg：本地识别由原生桥把录音解成 WAV；云端引擎直接收录音本身（AAC / WebM）。
    let (audio_path, audio_mime, audio_format, _temp) = if mobile && backend != AsrBackend::Whisper {
        let format = if mime.contains("webm") { "webm" } else { "m4a" };
        (input.to_path_buf(), mime.to_string(), format.to_string(), None)
    } else {
        let purpose = match backend {
            AsrBackend::Whisper => audio::AudioPurpose::Whisper,
            AsrBackend::Volcengine => audio::AudioPurpose::CloudAsr(audio::CloudAsrProvider::Volcengine),
            AsrBackend::Aliyun => audio::AudioPurpose::CloudAsr(audio::CloudAsrProvider::Aliyun),
        };
        let prepared = audio::prepare_for_asr(app, input, work_dir, purpose).await?;
        let path = prepared.path.clone();
        let (mime, format) = (prepared.mime.clone(), prepared.format.clone());
        (path, mime, format, Some(audio::TempAudio::new(&prepared)))
    };

    let json = match backend {
        AsrBackend::Whisper => {
            let model_id = setting(db, "whisper_model")
                .await?
                .unwrap_or_else(|| DEFAULT_LOCAL_MODEL.into());
            let app_data = app.path().app_data_dir().map_err(|e| AppError::Config(format!("app_data_dir: {e}")))?;
            let app_data = model_store::models_root(db, &app_data).await?;
            let lang = whisper_language_or_default(setting(db, "asr_language").await?);
            let model = select_local_model(&app_data, &model_id, &lang).ok_or_else(|| {
                AppError::Config("还没有可用的本地识别模型（设置 → 语音识别 下载一个）".into())
            })?;
            let hotwords = split_terms(&setting(db, "volcengine_asr_hotwords").await?.unwrap_or_default());
            let use_gpu = asr_use_gpu(db).await;
            run_local_model(&app_data, &model, &audio_path, &lang, &hotwords, use_gpu, None, None)
                .await?
        }
        AsrBackend::Volcengine => {
            let app_id = setting(db, "volcengine_asr_app_id").await?.unwrap_or_default();
            let token = crate::llm::keychain::get_secret_or_legacy(db, "volcengine_asr_access_token")
                .await?
                .unwrap_or_default();
            volcengine_auc::run_volcengine_file(&audio_path, &app_id, &token, None, &audio_format, None).await?
        }
        AsrBackend::Aliyun => {
            let api_key = crate::llm::keychain::get_secret_or_legacy(db, "dashscope_api_key")
                .await?
                .unwrap_or_default();
            let model = setting(db, "aliyun_asr_model")
                .await?
                .unwrap_or_else(|| aliyun_asr::DEFAULT_MODEL.to_string());
            let language = setting(db, "asr_language").await?;
            aliyun_asr::run_aliyun(&audio_path, &audio_mime, &api_key, &model, language.as_deref(), None).await?
        }
    };
    Ok(json
        .transcription
        .iter()
        .map(|segment| segment.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(""))
}

/// 这次处理能不能直接用自带字幕，从而整个跳过语音识别。
///
/// **必须在抽音轨之前调用。** 原来的顺序是先抽再判：一节一小时的课要把整个文件解码
/// 一遍、写出约 115MB 的 WAV，然后才走进这个分支——那份音频一次都没被读过，
/// 用户白等那几十秒。
///
/// 只登记了路径不算数，文件得真的在：字幕是导入时下载到磁盘上的，用户可能把它删了
/// 或者搬走了。那种情况下老老实实去识别，而不是抱着一个不存在的路径往下走。
fn subtitle_shortcut(subtitle_path: Option<&str>) -> Option<std::path::PathBuf> {
    let path = std::path::PathBuf::from(subtitle_path?);
    path.is_file().then_some(path)
}

/// 排队等本地识别时报给界面的话（前端按原文匹配做翻译）。
const LOCAL_ASR_WAITING: &str = "排队等待本地识别";
/// 同时处理的视频数（设置项），默认 2。
const PROCESSING_CONCURRENCY_KEY: &str = "processing_concurrency";
pub const DEFAULT_PROCESSING_CONCURRENCY: usize = 2;
const MAX_PROCESSING_CONCURRENCY: usize = 6;

async fn processing_limit(db: &crate::db::Db) -> usize {
    setting(db, PROCESSING_CONCURRENCY_KEY)
        .await
        .ok()
        .flatten()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(DEFAULT_PROCESSING_CONCURRENCY)
        .clamp(1, MAX_PROCESSING_CONCURRENCY)
}

/// 视频处理的排队闸口：同时最多 N 个视频在跑（设置项，默认 2），其余按点「开始处理」的
/// 先后排队。原来不设上限：一次导入十几个视频就同时抽十几份音轨、起十几个识别，电脑卡死。
///
/// 先来先服务：只有排在队首的才能进；进不去的等「有人离开」的通知（兜底每两秒再看一眼，
/// 用户在设置里把上限调大了也能及时放行）。排队中被取消（任务被中止）时票据自动作废。
#[derive(Default)]
struct ProcessingGate {
    state: std::sync::Mutex<GateState>,
    changed: tokio::sync::Notify,
}

#[derive(Default)]
struct GateState {
    running: usize,
    waiting: std::collections::VecDeque<u64>,
    next_ticket: u64,
}

/// 排队的票据。放行前丢掉 = 离开队伍；放行后丢掉 = 让出名额。
struct GateTicket<'a> {
    gate: &'a ProcessingGate,
    ticket: u64,
    admitted: bool,
}

impl ProcessingGate {
    fn join(&self) -> GateTicket<'_> {
        let mut state = self.state.lock().unwrap();
        let ticket = state.next_ticket;
        state.next_ticket += 1;
        state.waiting.push_back(ticket);
        GateTicket {
            gate: self,
            ticket,
            admitted: false,
        }
    }
}

impl GateTicket<'_> {
    /// 轮到了就放行（返回 None）；否则返回前面还有几个视频在排。
    fn try_admit(&mut self, limit: usize) -> Option<usize> {
        let mut state = self.gate.state.lock().unwrap();
        let ahead = state
            .waiting
            .iter()
            .position(|ticket| *ticket == self.ticket)
            .unwrap_or(0);
        if ahead == 0 && state.running < limit {
            state.waiting.pop_front();
            state.running += 1;
            self.admitted = true;
            drop(state);
            // 队首换人了：让下一个也看一眼（上限可能还有空位）。
            self.gate.changed.notify_waiters();
            return None;
        }
        Some(ahead)
    }

    /// 等到轮到自己。`limit` 每轮重读（设置可能被改），`on_wait` 报「前面还有几个」。
    async fn admit<F, Fut>(&mut self, limit: F, mut on_wait: impl FnMut(usize, usize))
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = usize>,
    {
        let mut reported = None;
        loop {
            let changed = self.gate.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let cap = limit().await;
            let Some(ahead) = self.try_admit(cap) else {
                return;
            };
            if reported != Some((ahead, cap)) {
                on_wait(ahead, cap);
                reported = Some((ahead, cap));
            }
            tokio::select! {
                _ = changed => {}
                _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {}
            }
        }
    }
}

impl Drop for GateTicket<'_> {
    fn drop(&mut self) {
        let mut state = self.gate.state.lock().unwrap();
        if self.admitted {
            state.running = state.running.saturating_sub(1);
        } else {
            state.waiting.retain(|ticket| *ticket != self.ticket);
        }
        drop(state);
        self.gate.changed.notify_waiters();
    }
}

static PROCESSING_GATE: std::sync::LazyLock<ProcessingGate> =
    std::sync::LazyLock::new(ProcessingGate::default);

async fn run_all(
    app: AppHandle,
    video_id: String,
    slides_cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    slides_done: tokio::sync::oneshot::Sender<()>,
    slides_abort: SlidesAbort,
) -> AppResult<()> {
    let state = app.state::<AppState>();
    let db = state.db.clone();
    let video: Video = sqlx::query_as("SELECT * FROM videos WHERE id=? AND deleted_at IS NULL")
        .bind(&video_id)
        .fetch_one(&db.pool)
        .await?;
    // 手机上锁屏、切走也接着跑；各阶段进度经 jobs::emit_update 报过去。
    let _keep_alive =
        crate::keep_alive::hold(crate::keep_alive::Kind::Processing, &video_id, &video.title);

    let jobs_list = jobs::ensure_jobs(&db, &video_id).await?;
    for job in &jobs_list {
        emit_update(
            &app,
            JobEvent {
                video_id: video_id.clone(),
                job_id: job.id.clone(),
                stage: job.stage.clone(),
                status: job.status.clone(),
                progress: job.progress,
                message: job.message.clone(),
            },
        );
    }

    // 排队：同时处理的视频数有上限，轮到了才开工。排队期间把「排队等待处理」挂在第一个
    // 还没做完的阶段上（界面显示的就是它）；只发事件不落库，开工后自然被真实进度覆盖。
    let mut ticket = PROCESSING_GATE.join();
    let first_open = ["crop", "audio", "slides", "asr"]
        .iter()
        .find_map(|stage| {
            jobs_list
                .iter()
                .find(|job| job.stage == *stage && job.status != "done")
        })
        .cloned();
    ticket
        .admit(
            || processing_limit(&db),
            |_ahead, limit| {
                if let Some(job) = &first_open {
                    emit_stage(
                        &app,
                        &video_id,
                        &job.id,
                        &job.stage,
                        "pending",
                        job.progress,
                        Some(&format!("排队等待处理（同时最多 {limit} 个视频）")),
                    );
                }
            },
        )
        .await;

    sqlx::query("UPDATE videos SET processed_status='processing' WHERE id=?")
        .bind(&video_id)
        .execute(&db.pool)
        .await?;

    // 黑边探测排最前：课件提取要按裁完的几何降采样采样帧，必须在它之前收口。
    // 平时导入后的后台任务已写好缓存，这一步通常只是标 done 跳过。
    run_crop_stage(&app, &db, &video_id, &jobs_list).await;

    // 课件提取与语音识别并行：一个啃画面、一个啃音轨，互不抢资源。句柄留到 AI 步骤前收口。
    let slides_task = {
        let app = app.clone();
        let db = db.clone();
        let video_id = video_id.clone();
        let jobs_list = jobs_list.clone();
        let task = tauri::async_runtime::spawn(async move {
            run_slides_stage(&app, &db, &video_id, &jobs_list, &slides_cancel).await;
            let _ = slides_done.send(());
        });
        // 取消时要能直接掐掉这条支线：它是单独起的任务，中止主任务不会连带它。
        *slides_abort.lock().unwrap() = Some(task.inner().abort_handle());
        task
    };

    let backend = asr_backend_or_default(
        sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key='asr_backend'")
            .fetch_optional(&db.pool)
            .await?,
    );
    let audio_purpose = match backend {
        AsrBackend::Whisper => audio::AudioPurpose::Whisper,
        AsrBackend::Volcengine => {
            audio::AudioPurpose::CloudAsr(audio::CloudAsrProvider::Volcengine)
        }
        AsrBackend::Aliyun => audio::AudioPurpose::CloudAsr(audio::CloudAsrProvider::Aliyun),
    };

    let audio_job = jobs_list
        .iter()
        .find(|job| job.stage == "audio")
        .ok_or_else(|| AppError::Pipeline("missing audio job".into()))?
        .clone();
    let asr_job = jobs_list
        .iter()
        .find(|job| job.stage == "asr")
        .ok_or_else(|| AppError::Pipeline("missing asr job".into()))?
        .clone();

    // 断点续跑：若「识别」已完成（字幕已落库），跳过抽音频 + 识别，直接续跑 AI 步骤。
    if asr_job.status == "done" {
        sqlx::query("UPDATE videos SET processed_status='done' WHERE id=?")
            .bind(&video_id)
            .execute(&db.pool)
            .await?;
        for done_job in [&audio_job, &asr_job] {
            emit_update(
                &app,
                JobEvent {
                    video_id: video_id.clone(),
                    job_id: done_job.id.clone(),
                    stage: done_job.stage.clone(),
                    status: "done".into(),
                    progress: 1.0,
                    message: None,
                },
            );
        }
        // AI 步骤要看到板书文字，等课件那条支线收口再开始。
        let _ = slides_task.await;
        run_ai_followups(&app, &db, &video_id, &jobs_list).await;
        return Ok(());
    }

    // 自带字幕的视频根本不用识别，这一判断必须排在抽音轨**之前**。
    //
    // 原来的顺序是先抽再判：一节一小时的课要把整个文件解码一遍、写出约 115MB 的 WAV，
    // 然后走进这个分支，那份音频一次都没被读过。用户等的那几十秒纯属白等。
    const SUBTITLE_SKIP_AUDIO: &str = "自带字幕，无需抽音轨";
    if let Some(sub_path) = subtitle_shortcut(video.subtitle_path.as_deref()) {
        // 抽音轨这一步没失败，是压根不需要——标成「已跳过」而不是「完成」。
        let _ = jobs::cancel(&db, &audio_job.id, SUBTITLE_SKIP_AUDIO).await;
        emit_update(
            &app,
            JobEvent {
                video_id: video_id.clone(),
                job_id: audio_job.id.clone(),
                stage: "audio".into(),
                status: "canceled".into(),
                progress: 0.0,
                message: Some(SUBTITLE_SKIP_AUDIO.into()),
            },
        );

        jobs::start(&db, &asr_job.id).await?;
        emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.3, "导入 B站自带字幕").await?;
        let srt_text = tokio::fs::read_to_string(&sub_path).await?;

        // 是否对字幕走 AI 纠错：视频级偏好（导入时勾选）> 全局开关，再要求有可用大模型。
        let autocorrect = subtitle::autocorrect_enabled(&db, &video_id).await?;
        let correct = if autocorrect {
            crate::commands::ai::provider_for_db(&db, crate::llm::profiles::AiTask::Correction)
                .await?
        } else {
            None
        };
        if correct.is_some() {
            emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.6, "正在 AI 纠正字幕")
                .await?;
        }
        // 纠错逐批报进度，铺进 0.60–0.99：长字幕要纠好几分钟，不能一直停在 60%。
        let sink = asr_progress_sink(&app, &video_id, &asr_job.id, 0.60, 0.99);

        let count =
            subtitle::ingest_subtitle(&db, &video_id, &srt_text, correct, Some(&sink)).await?;

        // 消化完成：清空 path（保留 lang 作来源展示），标记完成。
        sqlx::query("UPDATE videos SET subtitle_path=NULL, processed_status='done' WHERE id=?")
            .bind(&video_id)
            .execute(&db.pool)
            .await?;
        let msg = format!("{count} segments（来源：B站字幕）");
        jobs::update_progress(&db, &asr_job.id, 1.0, Some(&msg)).await?;
        jobs::finish(&db, &asr_job.id).await?;
        emit_update(
            &app,
            JobEvent {
                video_id: video_id.clone(),
                job_id: asr_job.id.clone(),
                stage: "asr".into(),
                status: "done".into(),
                progress: 1.0,
                message: Some(msg),
            },
        );
        // AI 步骤要看到板书文字，等课件那条支线收口再开始。
        let _ = slides_task.await;
        run_ai_followups(&app, &db, &video_id, &jobs_list).await;
        return Ok(());
    }

    jobs::start(&db, &audio_job.id).await?;
    emit_update(
        &app,
        JobEvent {
            video_id: video_id.clone(),
            job_id: audio_job.id.clone(),
            stage: "audio".into(),
            status: "running".into(),
            progress: 0.0,
            message: None,
        },
    );

    let data_dir = std::path::PathBuf::from(&video.data_dir);
    let prepared_audio = match audio::prepare_for_asr(
        &app,
        std::path::Path::new(&video.file_path),
        &data_dir,
        audio_purpose,
    )
    .await
    {
        Ok(audio) => {
            jobs::finish(&db, &audio_job.id).await?;
            emit_update(
                &app,
                JobEvent {
                    video_id: video_id.clone(),
                    job_id: audio_job.id.clone(),
                    stage: "audio".into(),
                    status: "done".into(),
                    progress: 1.0,
                    message: None,
                },
            );
            audio
        }
        Err(error) => {
            mark_failed(&db, &video_id).await?;
            jobs::fail(&db, &audio_job.id, &error.to_string()).await?;
            emit_update(
                &app,
                JobEvent {
                    video_id,
                    job_id: audio_job.id,
                    stage: "audio".into(),
                    status: "failed".into(),
                    progress: 0.0,
                    message: Some(error.to_string()),
                },
            );
            return Err(error);
        }
    };

    // 从这里往下，无论走哪条路退出，抽出来的音频都要跟着一起清掉——识别之后没有
    // 任何东西会再用它。识别失败、被取消都算，所以挂在 Drop 上而不是末尾显式调用。
    let _temp_audio = audio::TempAudio::new(&prepared_audio);

    jobs::start(&db, &asr_job.id).await?;
    emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.05, "准备识别引擎").await?;

    let audio_path = prepared_audio.path.clone();

    let asr_result = match backend {
        AsrBackend::Whisper => {
            let model_id: String =
                sqlx::query_scalar("SELECT value FROM settings WHERE key='whisper_model'")
                    .fetch_optional(&db.pool)
                    .await?
                    .unwrap_or_else(|| DEFAULT_LOCAL_MODEL.into());
            let lang = whisper_language_or_default(
                sqlx::query_scalar::<_, String>(
                    "SELECT value FROM settings WHERE key='asr_language'",
                )
                .fetch_optional(&db.pool)
                .await?,
            );
            let app_data = app.path().app_data_dir().expect("app_data_dir");
            // 模型存放目录可以换到别的盘；读不到设置就按默认目录找，不为它让整次识别失败。
            let app_data = model_store::models_root(&db, &app_data)
                .await
                .unwrap_or(app_data);
            let Some(model) = select_local_model(&app_data, &model_id, &lang) else {
                return fail_asr(
                    &app,
                    &db,
                    &video_id,
                    &asr_job.id,
                    "还没有可用的本地识别模型：打开 设置 → 语音识别 下载一个（中文课推荐 SenseVoice）".to_string(),
                )
                .await;
            };
            if model.id() != model_id {
                // 选的模型装好了却放不下（手机内存不够）要说清楚，不然用户会以为选择没生效。
                let low_memory = local_asr::find(&model_id).is_some_and(|wanted| {
                    local_asr::is_installed(&app_data, wanted)
                        && !wanted.fits_memory(local_asr::available_memory_mb())
                });
                let message = if low_memory {
                    format!("内存不够跑 {model_id}，改用 {}", model.id())
                } else {
                    format!("使用可用模型：{}", model.id())
                };
                tracing::info!(%model_id, chosen = model.id(), low_memory, "本地识别换了模型");
                emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.08, &message).await?;
            }

            let message = format!("本地识别中（{}，{lang}）", model.id());
            emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.18, &message).await?;
            // 识别边做边报，铺进 0.18–0.88：长课本地转写要好几分钟，
            // 此前从开始到转完一直停在 18%。
            let sink = {
                let app = app.clone();
                let video_id = video_id.clone();
                let job_id = asr_job.id.clone();
                let model_id = model.id().to_string();
                let lang = lang.clone();
                move |at: f64, device: &str| {
                    // 引擎报了跑在哪（「GPU：Apple M4」/「CPU」）就带上，让人看得出 GPU 加速有没有生效。
                    let shown = if device.is_empty() {
                        message.clone()
                    } else {
                        format!("本地识别中（{model_id}，{lang}，{device}）")
                    };
                    emit_stage(
                        &app,
                        &video_id,
                        &job_id,
                        "asr",
                        "running",
                        0.18 + 0.70 * at,
                        Some(&shown),
                    );
                }
            };
            // 用户的热词表（和火山引擎共用一份）：只有 Qwen3-ASR 用得上。
            let hotwords = split_terms(&setting(&db, "volcengine_asr_hotwords").await?.unwrap_or_default());
            let use_gpu = asr_use_gpu(&db).await;
            let on_wait = {
                let app = app.clone();
                let video_id = video_id.clone();
                let job_id = asr_job.id.clone();
                move || {
                    emit_stage(
                        &app,
                        &video_id,
                        &job_id,
                        "asr",
                        "running",
                        0.18,
                        Some(LOCAL_ASR_WAITING),
                    );
                }
            };
            run_local_model(
                &app_data,
                &model,
                &audio_path,
                &lang,
                &hotwords,
                use_gpu,
                Some(&sink),
                Some(&on_wait),
            )
            .await
        }
        AsrBackend::Volcengine => {
            let app_id = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='volcengine_asr_app_id'",
            )
            .fetch_optional(&db.pool)
            .await?
            .unwrap_or_default();
            let access_token =
                crate::llm::keychain::get_secret_or_legacy(&db, "volcengine_asr_access_token")
                    .await?
                    .unwrap_or_default();
            emit_running_progress(
                &app,
                &db,
                &video_id,
                &asr_job.id,
                0.16,
                "切分音频，准备分段上传",
            )
            .await?;
            // 分段并行上传：把长音频切成多段 MP3 分别提交、并行识别，再按时间偏移合并，
            // 比整段上传快很多（服务端并行处理 + 单段体积小，避免 413）。段长/并发可在
            // 设置里覆盖；默认 5 分钟一段、4 路并发，每段指数回退重试两次。
            let chunk_secs = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='volcengine_asr_chunk_secs'",
            )
            .fetch_optional(&db.pool)
            .await?
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(volcengine_auc::DEFAULT_CHUNK_SECS);
            let concurrency = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='volcengine_asr_concurrency'",
            )
            .fetch_optional(&db.pool)
            .await?
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(volcengine_auc::DEFAULT_CONCURRENCY);

            // 热词 + 上下文：默认把「标题 / 课程名」放进上下文，再追加用户在设置里填的
            // 自定义上下文与热词，拼成 request.context 一起下发，帮助模型转录更准。
            let hotwords: Vec<String> = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='volcengine_asr_hotwords'",
            )
            .fetch_optional(&db.pool)
            .await?
            .map(|raw| split_terms(&raw))
            .unwrap_or_default();
            let course_name =
                sqlx::query_scalar::<_, String>("SELECT name FROM courses WHERE id=?")
                    .bind(&video.course_id)
                    .fetch_optional(&db.pool)
                    .await?
                    .unwrap_or_default();
            let custom_context = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='volcengine_asr_context'",
            )
            .fetch_optional(&db.pool)
            .await?
            .unwrap_or_default();
            let mut context_lines: Vec<String> = Vec::new();
            if !video.title.trim().is_empty() {
                context_lines.push(format!("标题：{}", video.title.trim()));
            }
            if !course_name.trim().is_empty() {
                context_lines.push(format!("课程：{}", course_name.trim()));
            }
            context_lines.extend(
                custom_context
                    .lines()
                    .map(|line| line.trim().to_string())
                    .filter(|line| !line.is_empty()),
            );
            let context = volcengine_auc::build_context_json(&hotwords, &context_lines);
            // 断点续跑：认完的结果、已经提交（付过钱）还没等到结果的任务都落库，
            // 中途退出（点停、崩溃、关机、被限流太久）时下次直接取回或接着查。
            // 识别参数拌进键里，改了热词/上下文就不会命中。
            let cache = asr_cache::ChunkCache {
                db: &db,
                video_id: &video_id,
                params: format!("volcengine-auc|{}", context.as_deref().unwrap_or_default()),
            };

            match volcengine_upload_mode_for_os(std::env::consts::OS) {
                VolcengineUploadMode::WholeFile => {
                    let _ = (chunk_secs, concurrency);
                    let message = "云端识别中（火山引擎）";
                    emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.28, message).await?;
                    // 整段交上去就只能干等结果，这段按耗时往 0.88 爬。
                    let sink = asr_progress_sink(&app, &video_id, &asr_job.id, 0.28, 0.88);
                    ai::creep_while(
                        volcengine_auc::run_volcengine_file(
                            &audio_path,
                            &app_id,
                            &access_token,
                            context.as_deref(),
                            &prepared_audio.format,
                            Some(&cache),
                        ),
                        Some(&sink),
                        CLOUD_ASR_CREEP,
                        message,
                    )
                    .await
                }
                VolcengineUploadMode::Chunked => {
                    emit_running_progress(
                        &app,
                        &db,
                        &video_id,
                        &asr_job.id,
                        0.28,
                        "云端分段识别中（火山引擎）",
                    )
                    .await?;
                    // 分段陆续认完，把进度铺进 0.28–0.88：两小时的课切出二十多段，
                    // 此前从开始识别到全部认完一直停在 28%。
                    let sink = asr_progress_sink(&app, &video_id, &asr_job.id, 0.28, 0.88);
                    volcengine_auc::run_volcengine_file_chunked(
                        &audio_path,
                        &app_id,
                        &access_token,
                        chunk_secs,
                        concurrency,
                        context.clone(),
                        Some(&cache),
                        Some(&sink),
                    )
                    .await
                }
            }
        }
        AsrBackend::Aliyun => {
            let api_key = crate::llm::keychain::get_secret_or_legacy(&db, "dashscope_api_key")
                .await?
                .unwrap_or_default();
            let model = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='aliyun_asr_model'",
            )
            .fetch_optional(&db.pool)
            .await?
            .unwrap_or_else(|| aliyun_asr::DEFAULT_MODEL.to_string());
            let language = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='asr_language'",
            )
            .fetch_optional(&db.pool)
            .await?;
            emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.16, "准备上传音频").await?;
            let message = format!("云端识别中（阿里云 {model}）");
            emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.28, &message).await?;
            // 交上去就只能干等结果，这段按耗时往 0.88 爬。
            let sink = asr_progress_sink(&app, &video_id, &asr_job.id, 0.28, 0.88);
            ai::creep_while(
                aliyun_asr::run_aliyun(
                    &audio_path,
                    &prepared_audio.mime,
                    &api_key,
                    &model,
                    language.as_deref(),
                    video.duration_ms,
                ),
                Some(&sink),
                CLOUD_ASR_CREEP,
                &message,
            )
            .await
        }
    };

    match asr_result {
        Ok(json) => {
            // 识别铺到 0.88、纠错从 0.90 起报，这两步得夹在中间：原来报 0.92、0.95，
            // 一开始纠错，进度条就从 95% 退回 90%。
            emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.89, "解析识别结果").await?;
            emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.90, "写入原始文稿").await?;
            let count = asr::store_transcripts_with_raw_backup(&db, &video_id, &json).await?;
            // 整份文稿已经落库，分片断点缓存的使命就结束了。留着的话，用户明确要求
            // 「重新处理」时会静默拿回旧结果——那时他要的恰恰是重认一遍。
            // 清理失败只是留下一点垃圾，不该让这一步失败。
            if let Err(error) = asr_cache::clear(&db, &video_id).await {
                tracing::warn!(%error, "清理分片识别缓存失败");
            }
            let final_message = match crate::commands::ai::provider_for_db(
                &db,
                crate::llm::profiles::AiTask::Correction,
            )
            .await?
            {
                Some((provider, model)) => {
                    emit_running_progress(
                        &app,
                        &db,
                        &video_id,
                        &asr_job.id,
                        0.90,
                        "正在 AI 纠正文稿",
                    )
                    .await?;
                    // 纠错分批跑，每批一次模型往返。把批进度铺进 0.90–0.99：
                    // 长课要纠十几批，此前整段都压在一个静止的 98% 下面。
                    let sink = asr_progress_sink(&app, &video_id, &asr_job.id, 0.90, 0.99);
                    match transcript_correction::autocorrect_transcript(
                        &db,
                        &provider,
                        &model,
                        &video_id,
                        Some(&sink),
                    )
                    .await
                    {
                        Ok(()) => asr_done_message(count, TranscriptCorrectionOutcome::Applied),
                        Err(error) => {
                            eprintln!("transcript correction skipped after failure: {error}");
                            asr_done_message(count, TranscriptCorrectionOutcome::Failed)
                        }
                    }
                }
                None => asr_done_message(count, TranscriptCorrectionOutcome::NoProvider),
            };
            jobs::update_progress(&db, &asr_job.id, 1.0, Some(&final_message)).await?;
            jobs::finish(&db, &asr_job.id).await?;
            emit_update(
                &app,
                JobEvent {
                    video_id: video_id.clone(),
                    job_id: asr_job.id,
                    stage: "asr".into(),
                    status: "done".into(),
                    progress: 1.0,
                    message: Some(final_message),
                },
            );
            sqlx::query("UPDATE videos SET processed_status='done' WHERE id=?")
                .bind(&video_id)
                .execute(&db.pool)
                .await?;
        }
        Err(error) => {
            mark_failed(&db, &video_id).await?;
            jobs::fail(&db, &asr_job.id, &error.to_string()).await?;
            emit_update(
                &app,
                JobEvent {
                    video_id,
                    job_id: asr_job.id,
                    stage: "asr".into(),
                    status: "failed".into(),
                    progress: 0.0,
                    message: Some(error.to_string()),
                },
            );
            return Err(error);
        }
    }

    // 字幕就绪后自动续跑「章节 → 笔记」。这些是增值步骤，失败不影响视频已 done 的状态。
    // AI 步骤要看到板书文字，等课件那条支线收口再开始。
    let _ = slides_task.await;
    run_ai_followups(&app, &db, &video_id, &jobs_list).await;

    Ok(())
}

/// 自动提取课件是否开启。默认开；设置里显式关掉的课程/用户才跳过。
async fn slides_auto_enabled(db: &crate::db::Db) -> bool {
    let value: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key='slides_auto_extract'")
            .fetch_optional(&db.pool)
            .await
            .ok()
            .flatten();
    !matches!(value.as_deref().map(str::trim), Some("off") | Some("false"))
}

/// 导入后自动跑「提取课件 → 识别课件文字」。与抽音频/语音识别并行（一个啃画面、一个啃音轨），
/// 但在 AI 步骤之前收口，好让总结、出题看得到板书。尽力而为：失败只标记该 job，
/// 不影响字幕与后续 AI。
async fn run_slides_stage(
    app: &AppHandle,
    db: &crate::db::Db,
    video_id: &str,
    jobs_list: &[jobs::Job],
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    let (Some(extract_job), Some(ocr_job)) = (
        jobs_list.iter().find(|job| job.stage == "slides"),
        jobs_list.iter().find(|job| job.stage == "slides_ocr"),
    ) else {
        return;
    };

    if !slides_auto_enabled(db).await {
        for job in [extract_job, ocr_job] {
            let msg = "已在设置里关闭自动提取课件";
            let _ = jobs::cancel(db, &job.id, msg).await;
            emit_stage(
                app,
                video_id,
                &job.id,
                &job.stage,
                "canceled",
                0.0,
                Some(msg),
            );
        }
        return;
    }

    // 播客、录音等纯音频没有画面，课件两步直接跳过（不当成失败标红）。
    if extract_job.status != "done" {
        let path: String = sqlx::query_scalar("SELECT file_path FROM videos WHERE id=?")
            .bind(video_id)
            .fetch_one(&db.pool)
            .await
            .unwrap_or_default();
        if !path.is_empty() && !media_kind::has_video_stream(std::path::Path::new(&path)).await {
            let msg = "音频没有画面，已跳过课件";
            for job in [extract_job, ocr_job] {
                let _ = jobs::cancel(db, &job.id, msg).await;
                emit_stage(
                    app,
                    video_id,
                    &job.id,
                    &job.stage,
                    "canceled",
                    0.0,
                    Some(msg),
                );
            }
            return;
        }
    }

    let state = app.state::<AppState>();

    // 断点续跑：已提取过就不重复通读整段视频，直接数库里的页数进 OCR。
    let pages = if extract_job.status == "done" {
        emit_stage(app, video_id, &extract_job.id, "slides", "done", 1.0, None);
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM slides WHERE video_id=?")
            .bind(video_id)
            .fetch_one(&db.pool)
            .await
            .unwrap_or(0) as usize
    } else {
        let _ = jobs::start(db, &extract_job.id).await;
        emit_stage(
            app,
            video_id,
            &extract_job.id,
            "slides",
            "running",
            0.02,
            Some("提取课件页"),
        );
        // 通读整段视频是耗时大头，截图只占尾巴，进度条按这个比例分。
        let mut on_progress = |progress: slides::ExtractProgress| {
            let ratio = if progress.total == 0 {
                0.0
            } else {
                progress.done as f64 / progress.total as f64
            };
            let value = if progress.phase == "sample" {
                0.02 + 0.68 * ratio
            } else {
                0.70 + 0.30 * ratio
            };
            emit_stage(
                app,
                video_id,
                &extract_job.id,
                "slides",
                "running",
                value,
                None,
            );
        };
        match crate::commands::slides::extract_slides_for_video(
            app,
            &state,
            video_id,
            None,
            &cancel,
            &mut on_progress,
        )
        .await
        {
            Ok(count) => {
                let msg = format!("提取到 {count} 页课件");
                let _ = jobs::finish(db, &extract_job.id).await;
                emit_stage(
                    app,
                    video_id,
                    &extract_job.id,
                    "slides",
                    "done",
                    1.0,
                    Some(&msg),
                );
                count
            }
            Err(error) => {
                // 用户点了「取消处理」时提取也会报错，但那不是失败，别在界面上标红。
                let stopped = cancel.load(std::sync::atomic::Ordering::SeqCst);
                let msg = if stopped {
                    "已取消".to_string()
                } else {
                    error.to_string()
                };
                let status = if stopped { "canceled" } else { "failed" };
                if stopped {
                    let _ = jobs::cancel(db, &extract_job.id, &msg).await;
                } else {
                    let _ = jobs::fail(db, &extract_job.id, &msg).await;
                }
                emit_stage(
                    app,
                    video_id,
                    &extract_job.id,
                    "slides",
                    status,
                    0.0,
                    Some(&msg),
                );
                return;
            }
        }
    };

    // 没有课件页的视频（纯讲授、口播）不必白跑一遍 OCR。
    if pages == 0 {
        let msg = "没有找到课件页，已跳过";
        let _ = jobs::cancel(db, &ocr_job.id, msg).await;
        emit_stage(
            app,
            video_id,
            &ocr_job.id,
            "slides_ocr",
            "canceled",
            0.0,
            Some(msg),
        );
        return;
    }

    let _ = jobs::start(db, &ocr_job.id).await;
    emit_stage(
        app,
        video_id,
        &ocr_job.id,
        "slides_ocr",
        "running",
        0.02,
        Some("识别课件文字"),
    );
    let mut on_progress = |done: usize, total: usize| {
        let value = slides_ocr_progress(done, total);
        emit_stage(
            app,
            video_id,
            &ocr_job.id,
            "slides_ocr",
            "running",
            value,
            None,
        );
    };
    match crate::commands::slides::ocr_slides_for_video(
        &state,
        video_id,
        false,
        &cancel,
        &mut on_progress,
    )
    .await
    {
        // 取消时已认出的页留在库里，标成「已跳过」而不是完成——还有页没认，下次要接着跑。
        Ok(outcome) if outcome.canceled || cancel.load(std::sync::atomic::Ordering::SeqCst) => {
            let msg = format!("已取消，{} 页已认出", outcome.recognized);
            let _ = jobs::cancel(db, &ocr_job.id, &msg).await;
            emit_stage(
                app,
                video_id,
                &ocr_job.id,
                "slides_ocr",
                "canceled",
                0.0,
                Some(&msg),
            );
        }
        // 引擎整体不可用时会止损，不再把同一错误打到剩余几十页。已写库的结果保留，
        // 但作业必须明确失败，不能把未尝试页藏起来再报 done/100%。
        Ok(outcome)
            if outcome.stopped_early
                || (outcome.attempted > 0 && outcome.failed == outcome.attempted) =>
        {
            let remaining = outcome.total.saturating_sub(outcome.attempted);
            let msg = format!(
                "OCR 提前停止：已尝试 {}/{} 页，{} 页认出文字，{} 页失败，剩余 {remaining} 页未尝试：{}",
                outcome.attempted,
                outcome.total,
                outcome.recognized,
                outcome.failed,
                outcome.error.as_deref().unwrap_or("未知错误")
            );
            let _ = jobs::fail(db, &ocr_job.id, &msg).await;
            let progress = if outcome.total == 0 {
                0.0
            } else {
                outcome.attempted as f64 / outcome.total as f64
            };
            emit_stage(
                app,
                video_id,
                &ocr_job.id,
                "slides_ocr",
                "failed",
                progress,
                Some(&msg),
            );
        }
        // 有页失败但不是全军覆没：识别出来的确实写进库了，这一步算完成，
        // 但失败必须写进步骤消息里——不然界面只报「认出 9 页」，另外 90 页的失败无处可查。
        Ok(outcome) if outcome.failed > 0 => {
            let msg = format!(
                "{}/{pages} 页认出文字，{} 页失败：{}",
                outcome.recognized,
                outcome.failed,
                outcome.error.as_deref().unwrap_or("未知错误")
            );
            let _ = jobs::finish(db, &ocr_job.id).await;
            emit_stage(
                app,
                video_id,
                &ocr_job.id,
                "slides_ocr",
                "done",
                1.0,
                Some(&msg),
            );
        }
        Ok(outcome) => {
            let msg = format!("{}/{pages} 页认出文字", outcome.recognized);
            let _ = jobs::finish(db, &ocr_job.id).await;
            emit_stage(
                app,
                video_id,
                &ocr_job.id,
                "slides_ocr",
                "done",
                1.0,
                Some(&msg),
            );
        }
        Err(error) => {
            let msg = error.to_string();
            let _ = jobs::fail(db, &ocr_job.id, &msg).await;
            emit_stage(
                app,
                video_id,
                &ocr_job.id,
                "slides_ocr",
                "failed",
                0.0,
                Some(&msg),
            );
        }
    }
}

/// 是否已有黑边探测结果（crop_top 非空）。
async fn crop_detected(db: &crate::db::Db, video_id: &str) -> bool {
    sqlx::query_scalar::<_, Option<f64>>("SELECT crop_top FROM videos WHERE id=?")
        .bind(video_id)
        .fetch_optional(&db.pool)
        .await
        .ok()
        .flatten()
        .is_some()
}

/// 「黑边探测」这一阶段，排在最前。课件提取要按裁完的几何降采样采样帧，
/// 探测必须在它之前收口。平时导入后的后台任务已把结果写好，这里通常只是确认缓存。
async fn run_crop_stage(
    app: &AppHandle,
    db: &crate::db::Db,
    video_id: &str,
    jobs_list: &[jobs::Job],
) {
    let Some(crop_job) = jobs_list.iter().find(|job| job.stage == "crop") else {
        return;
    };
    // 已有探测结果：标 done 跳过（导入后台任务可能已测完）。
    if crop_detected(db, video_id).await {
        let _ = jobs::finish(db, &crop_job.id).await;
        emit_stage(app, video_id, &crop_job.id, "crop", "done", 1.0, None);
        return;
    }
    if crop_job.status == "done" {
        return;
    }
    let state = app.state::<AppState>();
    // 用取消登记表去重：导入后台任务（或播放器兜底）可能正在测同一段视频。
    // 已经有人在测就等它收口，别起第二份 ffmpeg。
    let key = crate::pipeline::crop_detect::cancel_key(video_id);
    let Some(cancel) = state.register_cancel_if_free(&key) else {
        for _ in 0..120 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            if crop_detected(db, video_id).await {
                break;
            }
            let status: Option<String> = sqlx::query_scalar(
                "SELECT status FROM processing_jobs WHERE video_id=? AND stage='crop'",
            )
            .bind(video_id)
            .fetch_optional(&db.pool)
            .await
            .ok()
            .flatten();
            if matches!(status.as_deref(), Some("done" | "failed" | "canceled")) {
                break;
            }
        }
        return;
    };
    // 拿到了探测的独占权：自己测一遍（可被 cmd_cancel_crop_detect 收掉）。
    let _ = jobs::start(db, &crop_job.id).await;
    emit_stage(
        app,
        video_id,
        &crop_job.id,
        "crop",
        "running",
        0.1,
        Some("探测黑边"),
    );
    let path: String = sqlx::query_scalar("SELECT file_path FROM videos WHERE id=?")
        .bind(video_id)
        .fetch_one(&db.pool)
        .await
        .unwrap_or_default();
    let _ =
        crate::pipeline::crop_detect::ensure_crop(db, video_id, PathBuf::from(path), &cancel).await;
    let _ = jobs::finish(db, &crop_job.id).await;
    emit_stage(app, video_id, &crop_job.id, "crop", "done", 1.0, None);
    state.unregister_cancel(&key, &cancel);
}

/// 后台跑一次黑边探测（导入后 / 播放器发现没有记录时触发）。
///
/// 用取消登记表去重：同一视频已有探测在跑就不再起一份，避免两份 ffmpeg 抢同一段
/// 视频。结果写库后，前端轮询 `cmd_ensure_crop` 就能读到。探测期间可被
/// `cmd_cancel_crop_detect` 收掉（切走视频时）。
pub fn spawn_crop_detection(app: AppHandle, video_id: String) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let db = state.db.clone();
        let Some(video) =
            sqlx::query_as::<_, Video>("SELECT * FROM videos WHERE id=? AND deleted_at IS NULL")
                .bind(&video_id)
                .fetch_optional(&db.pool)
                .await
                .ok()
                .flatten()
        else {
            return;
        };
        if video.crop_top.is_some() {
            return; // 已有缓存
        }
        let key = crate::pipeline::crop_detect::cancel_key(&video_id);
        let Some(cancel) = state.register_cancel_if_free(&key) else {
            return; // 已在测
        };
        let _ = jobs::ensure_crop_job(&db, &video_id).await;
        let Some(job) = sqlx::query_as::<_, jobs::Job>(
            "SELECT * FROM processing_jobs WHERE video_id=? AND stage='crop'",
        )
        .bind(&video_id)
        .fetch_optional(&db.pool)
        .await
        .ok()
        .flatten() else {
            state.unregister_cancel(&key, &cancel);
            return;
        };
        let _ = jobs::start(&db, &job.id).await;
        emit_stage(
            &app,
            &video_id,
            &job.id,
            "crop",
            "running",
            0.1,
            Some("探测黑边"),
        );
        let _ = crate::pipeline::crop_detect::ensure_crop(
            &db,
            &video_id,
            PathBuf::from(&video.file_path),
            &cancel,
        )
        .await;
        let _ = jobs::finish(&db, &job.id).await;
        emit_stage(&app, &video_id, &job.id, "crop", "done", 1.0, None);
        state.unregister_cancel(&key, &cancel);
    });
}

/// 后台抓取 B 站视频的弹幕与评论区并写库（导入后 / 重连时触发）。
///
/// 尽力而为：网络失败只记日志，不影响视频可用。同一个视频重复触发时，
/// `ensure_*` 内部按「库里已有数据就返回」去重，不会重复请求。
pub fn spawn_bilibili_extras(app: AppHandle, video_id: String) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let db = state.db.clone();
        let Some(video) =
            sqlx::query_as::<_, Video>("SELECT * FROM videos WHERE id=? AND deleted_at IS NULL")
                .bind(&video_id)
                .fetch_optional(&db.pool)
                .await
                .ok()
                .flatten()
        else {
            return;
        };
        if video.source_type != "bilibili" {
            return;
        }
        let cookies = crate::commands::settings::get_setting(&db, "bilibili_cookies")
            .await
            .ok()
            .flatten()
            .and_then(|raw| {
                crate::pipeline::bilibili_extra::cookie_header_from_setting(Some(&raw))
            });
        let (source_type, source_uri, cid) = (
            video.source_type.clone(),
            video.source_uri.clone(),
            video.bilibili_cid.clone(),
        );
        let _ = crate::pipeline::bilibili_extra::ensure_danmaku(
            &db,
            &video.id,
            &source_type,
            source_uri.as_deref(),
            cid.as_deref(),
            cookies.as_deref(),
        )
        .await;
        let _ = crate::pipeline::bilibili_extra::ensure_comments(
            &db,
            &video.id,
            &source_type,
            video.source_uri.as_deref(),
            video.bilibili_cid.as_deref(),
            cookies.as_deref(),
        )
        .await;
    });
}

/// 账号级问题（余额、密钥、权限）把后面几步一并跳过时给出的说明。
const AI_HALTED_MESSAGE: &str =
    "已跳过：上一步因账号问题失败（余额、密钥或权限），接着跑也是同样结果。处理好之后，可在各面板右下角手动生成。";
const AI_DEPENDENCY_HALTED_MESSAGE: &str =
    "已跳过：生成讲稿提要的模型因账号问题失败，后续任务依赖同一份提要。处理好该 Profile 后，可在各面板右下角手动生成。";

fn remember_failed_profile(
    halted_profiles: &mut HashSet<String>,
    halted_dependency_profile: &mut Option<String>,
    profile_id: &str,
    error: &AppError,
) {
    if error.is_account_failure() {
        let failed_profile = error.account_profile_id().unwrap_or(profile_id);
        halted_profiles.insert(failed_profile.to_string());
        // 只有嵌套路由会给错误附 profile_id；当前唯一的嵌套 LLM 任务是所有产物
        // 共用的讲稿 Digest。它失败后没有缓存，后续任务继续跑只会再次撞同一账号。
        if error.account_profile_id().is_some() {
            *halted_dependency_profile = Some(failed_profile.to_string());
        }
    }
}

/// ASR 之后自动生成章节、笔记。尽力而为：未配置大模型或单步失败都只标记该 job，
/// 不回滚视频状态、不中断其余步骤。
///
/// 唯一的例外是账号级的错误。余额耗尽时，剩下四个任务会各自把讲稿重新分块压缩一遍，
/// 再撞上同一个 402——用户等来的是五条一模一样的报错，和五轮白花的时间。
async fn run_ai_followups(
    app: &AppHandle,
    db: &crate::db::Db,
    video_id: &str,
    jobs_list: &[jobs::Job],
) {
    use crate::llm::profiles::AiTask;
    let mut halted_profiles = HashSet::new();
    let mut halted_dependency_profile = None;
    for (stage, task) in [
        ("chapters", AiTask::Chapters),
        ("summary", AiTask::Summary),
        ("notes", AiTask::Notes),
        ("quiz", AiTask::Quiz),
        ("mindmap", AiTask::Mindmap),
    ] {
        let Some(job) = jobs_list.iter().find(|j| j.stage == stage) else {
            continue;
        };
        // 断点续跑：该步骤已完成则跳过，不重复调用大模型（也避免重复写库）。
        if job.status == "done" {
            emit_stage(app, video_id, &job.id, stage, "done", 1.0, None);
            continue;
        }
        if halted_dependency_profile.is_some() {
            let _ = jobs::cancel(db, &job.id, AI_DEPENDENCY_HALTED_MESSAGE).await;
            emit_stage(
                app,
                video_id,
                &job.id,
                stage,
                "canceled",
                0.0,
                Some(AI_DEPENDENCY_HALTED_MESSAGE),
            );
            continue;
        }
        let resolved = match crate::commands::ai::resolved_provider_for_db(db, task).await {
            Ok(Some(resolved)) => resolved,
            Ok(None) => {
                let msg = "未配置大模型，已跳过自动生成（可在设置→大模型配置后手动生成）";
                let _ = jobs::cancel(db, &job.id, msg).await;
                emit_stage(app, video_id, &job.id, stage, "canceled", 0.0, Some(msg));
                continue;
            }
            Err(error) => {
                let msg = error.to_string();
                let _ = jobs::fail(db, &job.id, &msg).await;
                emit_stage(app, video_id, &job.id, stage, "failed", 0.0, Some(&msg));
                continue;
            }
        };
        if halted_profiles.contains(&resolved.profile_id) {
            // 标成 canceled 而不是 failed：它没失败，是这个 Profile 已经确定不可用，根本没发请求。
            let _ = jobs::cancel(db, &job.id, AI_HALTED_MESSAGE).await;
            emit_stage(
                app,
                video_id,
                &job.id,
                stage,
                "canceled",
                0.0,
                Some(AI_HALTED_MESSAGE),
            );
            continue;
        }
        let _ = jobs::start(db, &job.id).await;
        emit_stage(
            app,
            video_id,
            &job.id,
            stage,
            "running",
            0.02,
            Some("排队中"),
        );

        let profile_id = resolved.profile_id;
        let provider = resolved.provider;
        let model = resolved.model;

        // 步骤内进度直接转成事件。这里只发事件不落库（与课件提取那条支线一致）：
        // 一次生成会报十几次，每次都写库既无必要又会和 finish 抢同一行。
        let sink = {
            let app = app.clone();
            let video_id = video_id.to_string();
            let job_id = job.id.clone();
            let stage = stage.to_string();
            move |at: f64, message: &str| {
                emit_stage(
                    &app,
                    &video_id,
                    &job_id,
                    &stage,
                    "running",
                    at,
                    Some(message),
                );
            }
        };
        let progress: ai::Progress<'_> = Some(&sink);

        let result = match task {
            AiTask::Chapters => ai::generate_chapters(db, &provider, &model, video_id, progress)
                .await
                .map(|_| ()),
            AiTask::Summary => {
                ai::generate_summary(db, &provider, &model, video_id, progress).await
            }
            AiTask::Notes => ai::generate_notes(db, &provider, &model, video_id, progress).await,
            AiTask::Quiz => ai::generate_quiz(db, &provider, &model, video_id, progress).await,
            AiTask::Mindmap => {
                ai::generate_mindmap(db, &provider, &model, video_id, progress).await
            }
            _ => Ok(()),
        };
        match result {
            Ok(()) => {
                let _ = jobs::finish(db, &job.id).await;
                emit_stage(app, video_id, &job.id, stage, "done", 1.0, None);
            }
            Err(error) => {
                let msg = error.to_string();
                let _ = jobs::fail(db, &job.id, &msg).await;
                emit_stage(app, video_id, &job.id, stage, "failed", 0.0, Some(&msg));
                // 只有同一个 Profile 的账号级错误才连坐。请求内容或其他 Profile
                // 不受影响，仍有机会正常生成。
                remember_failed_profile(
                    &mut halted_profiles,
                    &mut halted_dependency_profile,
                    &profile_id,
                    &error,
                );
            }
        }
    }
}

fn emit_stage(
    app: &AppHandle,
    video_id: &str,
    job_id: &str,
    stage: &str,
    status: &str,
    progress: f64,
    message: Option<&str>,
) {
    emit_update(
        app,
        JobEvent {
            video_id: video_id.to_string(),
            job_id: job_id.to_string(),
            stage: stage.to_string(),
            status: status.to_string(),
            progress,
            message: message.map(str::to_string),
        },
    );
}

/// 课件文字识别的进度。开始时已经报过 2%（「识别课件文字」），逐页进度接在它后面；
/// 直接用 done/total 的话，第一条 0/n 就把进度拉回 0。
fn slides_ocr_progress(done: usize, total: usize) -> f64 {
    if total == 0 {
        1.0
    } else {
        0.02 + 0.98 * done as f64 / total as f64
    }
}

/// 把识别任务里一段子进度（0..1）铺进它进度条的 [from, to]。和别处的细进度一样只发事件、
/// 不落库，库里只留阶段里程碑。
fn asr_progress_sink(
    app: &AppHandle,
    video_id: &str,
    job_id: &str,
    from: f64,
    to: f64,
) -> impl Fn(f64, &str) + Send + Sync {
    let app = app.clone();
    let video_id = video_id.to_string();
    let job_id = job_id.to_string();
    move |at: f64, message: &str| {
        emit_stage(
            &app,
            &video_id,
            &job_id,
            "asr",
            "running",
            from + (to - from) * at,
            Some(message),
        );
    }
}

async fn fail_asr<T>(
    app: &AppHandle,
    db: &crate::db::Db,
    video_id: &str,
    job_id: &str,
    message: String,
) -> AppResult<T> {
    mark_failed(db, video_id).await?;
    jobs::fail(db, job_id, &message).await?;
    emit_update(
        app,
        JobEvent {
            video_id: video_id.to_string(),
            job_id: job_id.to_string(),
            stage: "asr".into(),
            status: "failed".into(),
            progress: 0.0,
            message: Some(message.clone()),
        },
    );
    Err(AppError::Pipeline(message))
}

async fn emit_running_progress(
    app: &AppHandle,
    db: &crate::db::Db,
    video_id: &str,
    job_id: &str,
    progress: f64,
    message: &str,
) -> AppResult<()> {
    jobs::update_progress(db, job_id, progress, Some(message)).await?;
    emit_update(
        app,
        JobEvent {
            video_id: video_id.to_string(),
            job_id: job_id.to_string(),
            stage: "asr".into(),
            status: "running".into(),
            progress,
            message: Some(message.to_string()),
        },
    );
    Ok(())
}

async fn mark_failed(db: &crate::db::Db, video_id: &str) -> AppResult<()> {
    sqlx::query("UPDATE videos SET processed_status='failed' WHERE id=?")
        .bind(video_id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

pub async fn recover_interrupted_processing(db: &crate::db::Db) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut tx = db.pool.begin().await?;
    sqlx::query(
        "UPDATE processing_jobs
         SET status='failed', message='应用已重启，处理被中断，请重试', finished_at=?
         WHERE status='running'",
    )
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE videos SET processed_status='failed'
         WHERE processed_status='processing'",
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// 正在运行的流水线任务句柄，按 video_id 索引，用于取消。
#[derive(Default)]
pub struct ProcessingTasks {
    tasks: std::sync::Mutex<std::collections::HashMap<String, ProcessingTask>>,
    transition: tokio::sync::Mutex<()>,
}

struct ProcessingTask {
    run_id: String,
    handle: tauri::async_runtime::JoinHandle<()>,
    slides_cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    slides_done: tokio::sync::oneshot::Receiver<()>,
    slides_abort: SlidesAbort,
}

/// 课件支线任务的中止句柄：支线起了以后由 run_all 填进来。
type SlidesAbort = std::sync::Arc<std::sync::Mutex<Option<tokio::task::AbortHandle>>>;

/// 停止处理时，给主任务 / 课件支线各自收口的时间。课件支线看到取消标志会把已认出的页
/// 留在库里、把步骤标成「已取消」；等不到就直接中止（子进程 kill_on_drop 跟着被杀）。
const STOP_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

impl ProcessingTasks {
    fn video_ids(&self) -> Vec<String> {
        self.tasks.lock().unwrap().keys().cloned().collect()
    }

    fn take(&self, video_id: &str) -> Option<ProcessingTask> {
        self.tasks.lock().unwrap().remove(video_id)
    }

    fn insert(&self, video_id: String, task: ProcessingTask) {
        self.tasks.lock().unwrap().insert(video_id, task);
    }

    fn remove_if_current(&self, video_id: &str, run_id: &str) {
        let mut tasks = self.tasks.lock().unwrap();
        let is_current = tasks
            .get(video_id)
            .map(|task| task.run_id == run_id)
            .unwrap_or(false);
        if is_current {
            tasks.remove(video_id);
        }
    }
}

/// 某视频的流水线是否还在跑（批量导入的处理调度据此决定什么时候起下一个）。
pub fn is_processing(app: &AppHandle, video_id: &str) -> bool {
    app.state::<ProcessingTasks>()
        .tasks
        .lock()
        .unwrap()
        .contains_key(video_id)
}

/// 停掉某视频正在跑的处理。**必须在有限时间内返回**：调用方（取消、删除、重新处理）
/// 都拿着全局的 transition 锁，原来这里无限期地等课件支线收口——某一页 OCR 卡住时
/// 支线永远不收口，锁永远不放，之后的取消、删除全部挂住，只能重启应用。
async fn stop_processing_task(task: ProcessingTask) {
    let ProcessingTask {
        handle,
        slides_cancel,
        slides_done,
        slides_abort,
        ..
    } = task;
    slides_cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    handle.abort();
    let _ = tokio::time::timeout(STOP_GRACE, handle).await;
    if tokio::time::timeout(STOP_GRACE, slides_done).await.is_err() {
        if let Some(abort) = slides_abort.lock().unwrap().take() {
            abort.abort();
        }
    }
}

#[tauri::command]
pub async fn cmd_list_processing_videos(app: AppHandle) -> AppResult<Vec<Video>> {
    let active_ids: HashSet<String> = app
        .state::<ProcessingTasks>()
        .video_ids()
        .into_iter()
        .collect();
    let db = app.state::<AppState>().db.clone();
    list_processing_videos_for_queue(&db, &active_ids).await
}

async fn list_processing_videos_for_queue(
    db: &crate::db::Db,
    active_ids: &HashSet<String>,
) -> AppResult<Vec<Video>> {
    let mut videos: Vec<Video> =
        sqlx::query_as("SELECT * FROM videos WHERE deleted_at IS NULL ORDER BY created_at DESC")
            .fetch_all(&db.pool)
            .await?;
    videos.retain(|video| {
        active_ids.contains(&video.id)
            || video.processed_status == "processing"
            || video.processed_status == "failed"
    });
    Ok(videos)
}

/// Hide a failed queue item persistently without deleting the video or its diagnostic jobs.
#[tauri::command]
pub async fn cmd_dismiss_processing_video(app: AppHandle, video_id: String) -> AppResult<()> {
    let db = app.state::<AppState>().db.clone();
    dismiss_processing_video(&db, &video_id).await
}

async fn dismiss_processing_video(db: &crate::db::Db, video_id: &str) -> AppResult<()> {
    let result = sqlx::query(
        "UPDATE videos SET processed_status='pending'
         WHERE id=? AND deleted_at IS NULL AND processed_status='failed'",
    )
    .bind(video_id)
    .execute(&db.pool)
    .await?;
    if result.rows_affected() == 0 {
        // 视频存在但已不在 failed（可能已被删除/移入回收站，或状态已经变过）：
        // 队列项可能比视频活得久，「移除」的目的就是让它消失，对象不在了也算达成。
        // 但 id 完全不存在时必须报错——传错 id 不能假装成功。
        let known: Option<Option<i64>> =
            sqlx::query_scalar("SELECT deleted_at FROM videos WHERE id=?")
                .bind(video_id)
                .fetch_optional(&db.pool)
                .await?;
        if known.is_none() {
            return Err(AppError::NotFound(format!("video {video_id}")));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_process_video(app: AppHandle, video_id: String) -> AppResult<()> {
    let db = app.state::<AppState>().db.clone();
    let active: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM videos WHERE id=? AND deleted_at IS NULL)")
            .bind(&video_id)
            .fetch_one(&db.pool)
            .await?;
    if !active {
        return Err(AppError::NotFound(format!("video {video_id}")));
    }

    // Treat take/abort/insert as one lifecycle transition. Without this lock, two
    // concurrent commands can both observe an empty slot and run against the same jobs.
    let tasks = app.state::<ProcessingTasks>();
    let _transition = tasks.transition.lock().await;
    // Wait for both the main task and its independently spawned slides branch.
    if let Some(old) = tasks.take(&video_id) {
        stop_processing_task(old).await;
    }
    let task_app = app.clone();
    let task_video = video_id.clone();
    let run_id = Uuid::new_v4().to_string();
    let task_run_id = run_id.clone();
    let (start_tx, start_rx) = tokio::sync::oneshot::channel::<()>();
    let slides_cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let task_slides_cancel = slides_cancel.clone();
    let (slides_done_tx, slides_done_rx) = tokio::sync::oneshot::channel::<()>();
    let slides_abort: SlidesAbort = Default::default();
    let task_slides_abort = slides_abort.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let _ = start_rx.await;
        if let Err(error) = run_all(
            task_app.clone(),
            task_video.clone(),
            task_slides_cancel,
            slides_done_tx,
            task_slides_abort,
        )
        .await
        {
            tracing::error!("pipeline failed: {error:?}");
        }
        task_app
            .state::<ProcessingTasks>()
            .remove_if_current(&task_video, &task_run_id);
    });
    tasks.insert(
        video_id,
        ProcessingTask {
            run_id,
            handle,
            slides_cancel,
            slides_done: slides_done_rx,
            slides_abort,
        },
    );
    let _ = start_tx.send(());
    Ok(())
}

/// 仅重新 AI 纠错：视频已有字幕时用。以原始字幕快照生成候选结果，模型成功且
/// 当前文稿仍与请求开始时一致时才原子替换；不重新抽音频、不重新识别。
#[tauri::command]
pub async fn cmd_recorrect_transcript(
    state: tauri::State<'_, AppState>,
    video_id: String,
) -> AppResult<()> {
    let db = state.db.clone();
    let (provider, model) =
        crate::commands::ai::provider_for_db(&db, crate::llm::profiles::AiTask::Correction)
            .await?
            .ok_or_else(|| {
                AppError::Config("未配置大模型，无法纠错（请到设置 → 大模型 配置）".into())
            })?;
    transcript_correction::recorrect_transcript(&db, &provider, &model, &video_id, None).await
}

/// 取消某视频正在进行的处理：先中止并等待任务退出，再把 running/pending 步骤标为「已取消」
/// （ffmpeg/whisper 子进程因 kill_on_drop 会被杀掉）。
pub async fn cancel_processing(app: &AppHandle, video_id: &str) -> AppResult<()> {
    let tasks = app.state::<ProcessingTasks>();
    let _transition = tasks.transition.lock().await;
    // 已提取的页与已认出的文字都留在库里，下次续跑。
    if let Some(task) = tasks.take(video_id) {
        stop_processing_task(task).await;
    }
    let db = app.state::<AppState>().db.clone();
    for job in jobs::list_for_video(&db, video_id).await? {
        if job.status == "running" || job.status == "pending" {
            jobs::cancel(&db, &job.id, "已取消").await?;
            emit_stage(
                app,
                video_id,
                &job.id,
                &job.stage,
                "canceled",
                job.progress,
                Some("已取消"),
            );
        }
    }
    sqlx::query(
        "UPDATE videos SET processed_status='pending' WHERE id=? AND processed_status='processing'",
    )
    .bind(video_id)
    .execute(&db.pool)
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_cancel_processing(app: AppHandle, video_id: String) -> AppResult<()> {
    cancel_processing(&app, &video_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::videos::add_local_video;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tempfile::tempdir;

    #[test]
    fn ai_account_failures_only_halt_the_profile_that_failed() {
        let mut halted = HashSet::new();
        let mut dependency = None;

        remember_failed_profile(
            &mut halted,
            &mut dependency,
            "profile-a",
            &AppError::account("余额不足".into()),
        );
        remember_failed_profile(
            &mut halted,
            &mut dependency,
            "profile-b",
            &AppError::Permanent("请求格式错误".into()),
        );

        assert!(halted.contains("profile-a"));
        assert!(!halted.contains("profile-b"));
        assert!(dependency.is_none());

        let mut routed = HashSet::new();
        let mut routed_dependency = None;
        let digest_error =
            AppError::account("摘要账号余额不足".into()).with_account_profile(Some("profile-b"));
        remember_failed_profile(
            &mut routed,
            &mut routed_dependency,
            "profile-a",
            &digest_error,
        );
        assert!(!routed.contains("profile-a"));
        assert!(routed.contains("profile-b"));
        assert_eq!(routed_dependency.as_deref(), Some("profile-b"));
    }

    #[tokio::test]
    async fn stopping_processing_task_waits_for_detached_slides_branch() {
        let slides_cancel = Arc::new(AtomicBool::new(false));
        let slides_exited = Arc::new(AtomicBool::new(false));
        let child_cancel = slides_cancel.clone();
        let child_exited = slides_exited.clone();
        let (slides_started_tx, slides_started_rx) = tokio::sync::oneshot::channel();
        let (slides_done_tx, slides_done_rx) = tokio::sync::oneshot::channel();

        let handle = tauri::async_runtime::spawn(async move {
            let _slides = tauri::async_runtime::spawn(async move {
                let _ = slides_started_tx.send(());
                while !child_cancel.load(Ordering::SeqCst) {
                    tokio::task::yield_now().await;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                child_exited.store(true, Ordering::SeqCst);
                let _ = slides_done_tx.send(());
            });
            std::future::pending::<()>().await;
        });
        slides_started_rx.await.unwrap();

        stop_processing_task(ProcessingTask {
            run_id: "run".into(),
            handle,
            slides_cancel,
            slides_done: slides_done_rx,
            slides_abort: Default::default(),
        })
        .await;

        assert!(slides_exited.load(Ordering::SeqCst));
    }

    /// 课件支线卡在一页 OCR 上、根本不看取消标志时，停止处理也必须在有限时间内返回，
    /// 并把这条支线掐掉——否则调用方拿着的 transition 锁永远不放，取消、删除全部挂住。
    #[tokio::test]
    async fn processing_gate_admits_in_order_up_to_the_limit() {
        let gate = ProcessingGate::default();
        let mut first = gate.join();
        let mut second = gate.join();
        let mut third = gate.join();
        assert_eq!(first.try_admit(1), None);
        // 名额满了：第二个排在队首但进不去；第三个前面还有一个。
        assert_eq!(second.try_admit(1), Some(0));
        assert_eq!(third.try_admit(1), Some(1));
        // 第一个做完让出名额，第二个进去；第三个仍要等。
        drop(first);
        assert_eq!(second.try_admit(1), None);
        assert_eq!(third.try_admit(1), Some(0));
        // 上限调大，不用等别人做完也能进。
        assert_eq!(third.try_admit(2), None);
        assert_eq!(gate.state.lock().unwrap().running, 2);
    }

    #[tokio::test]
    async fn a_canceled_waiter_leaves_the_queue() {
        let gate = ProcessingGate::default();
        let mut running = gate.join();
        assert_eq!(running.try_admit(1), None);
        let waiting = gate.join();
        let mut later = gate.join();
        assert_eq!(later.try_admit(1), Some(1));
        // 排队中被取消：票据丢掉就离队，后面的人往前挪。
        drop(waiting);
        assert_eq!(later.try_admit(1), Some(0));
        drop(running);
        assert_eq!(later.try_admit(1), None);
    }

    #[tokio::test]
    async fn waiting_for_the_gate_wakes_up_when_a_slot_frees() {
        let gate: &'static ProcessingGate = Box::leak(Box::default());
        let mut holder = gate.join();
        assert_eq!(holder.try_admit(1), None);
        let waits = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = waits.clone();
        let waiter = tokio::spawn(async move {
            let mut ticket = gate.join();
            ticket
                .admit(|| async { 1 }, move |ahead, limit| seen.lock().unwrap().push((ahead, limit)))
                .await;
            ticket
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!waiter.is_finished());
        assert_eq!(*waits.lock().unwrap(), [(0, 1)]);
        let started = std::time::Instant::now();
        drop(holder);
        let ticket = waiter.await.unwrap();
        // 靠通知唤醒，不用等两秒的兜底轮询。
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert!(ticket.admitted);
    }

    #[tokio::test]
    async fn stopping_processing_task_aborts_a_stuck_slides_branch() {
        let (slides_done_tx, slides_done_rx) = tokio::sync::oneshot::channel::<()>();
        let dropped = Arc::new(AtomicBool::new(false));
        struct SetOnDrop(Arc<AtomicBool>);
        impl Drop for SetOnDrop {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let guard = SetOnDrop(dropped.clone());
        let stuck = tauri::async_runtime::spawn(async move {
            let _guard = guard;
            let _done = slides_done_tx; // 永远不发、也不提前放掉
            std::future::pending::<()>().await;
        });
        let slides_abort: SlidesAbort = Default::default();
        *slides_abort.lock().unwrap() = Some(stuck.inner().abort_handle());
        let handle = tauri::async_runtime::spawn(std::future::pending::<()>());

        let started = std::time::Instant::now();
        stop_processing_task(ProcessingTask {
            run_id: "run".into(),
            handle,
            slides_cancel: Arc::new(AtomicBool::new(false)),
            slides_done: slides_done_rx,
            slides_abort,
        })
        .await;
        assert!(started.elapsed() < STOP_GRACE * 3, "{:?}", started.elapsed());
        // 被中止的任务会把自己的局部变量丢掉：守卫的 Drop 证明支线确实停了。
        for _ in 0..50 {
            if dropped.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(dropped.load(Ordering::SeqCst), "卡住的课件支线没有被中止");
    }

    #[tokio::test]
    async fn slides_auto_extract_is_on_unless_explicitly_turned_off() {
        let dir = tempdir().unwrap();
        let db = crate::db::Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        // 没设置过：默认开，导入后自动提取课件。
        assert!(slides_auto_enabled(&db).await);

        for (value, expected) in [("off", false), ("on", true), ("false", false)] {
            sqlx::query(
                "INSERT OR REPLACE INTO settings(key,value) VALUES ('slides_auto_extract',?)",
            )
            .bind(value)
            .execute(&db.pool)
            .await
            .unwrap();
            assert_eq!(slides_auto_enabled(&db).await, expected, "value={value}");
        }
    }

    #[test]
    fn a_video_with_its_own_subtitle_needs_no_audio_track() {
        // 这个判断必须排在抽音轨之前。原来是先抽再判：一小时的课整个解码一遍、写出
        // 约 115MB 的 WAV，然后走进「用自带字幕」的分支——那份音频一次都没被读过。
        let dir = tempdir().unwrap();
        let srt = dir.path().join("sub.srt");
        std::fs::write(&srt, "1\n00:00:00,000 --> 00:00:01,000\n你好\n").unwrap();

        assert_eq!(
            subtitle_shortcut(Some(srt.to_str().unwrap())),
            Some(srt.clone())
        );
        // 没登记字幕的视频照常走识别。
        assert_eq!(subtitle_shortcut(None), None);
        // 登记了但文件已经不在（用户删了或搬走了）：也得老老实实去识别，
        // 而不是抱着一个不存在的路径往下走。
        let gone = dir.path().join("missing.srt");
        assert_eq!(subtitle_shortcut(Some(gone.to_str().unwrap())), None);
    }

    #[test]
    fn slides_stages_run_before_the_ai_stages() {
        // 顺序不只是显示：AI 步骤要看得到板书文字，课件两步必须排在它们之前。
        let position = |stage: &str| jobs::STAGES.iter().position(|s| *s == stage).unwrap();
        assert!(position("slides") < position("chapters"));
        assert!(position("slides_ocr") < position("chapters"));
        assert!(position("slides") < position("slides_ocr"));
    }

    #[tokio::test]
    async fn startup_recovery_keeps_interrupted_work_visible_until_dismissed() {
        let dir = tempdir().unwrap();
        let db = crate::db::Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        let course = create_course(&db, "c".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let video_path = dir.path().join("v.mp4");
        std::fs::write(&video_path, b"fake").unwrap();
        let video = add_local_video(&db, &course.id, video_path, None)
            .await
            .unwrap();
        sqlx::query("UPDATE videos SET processed_status='processing' WHERE id=?")
            .bind(&video.id)
            .execute(&db.pool)
            .await
            .unwrap();
        let job_list = jobs::ensure_jobs(&db, &video.id).await.unwrap();
        let audio = job_list.iter().find(|job| job.stage == "audio").unwrap();
        jobs::start(&db, &audio.id).await.unwrap();

        recover_interrupted_processing(&db).await.unwrap();

        let video_status: String =
            sqlx::query_scalar("SELECT processed_status FROM videos WHERE id=?")
                .bind(&video.id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(video_status, "failed");
        let recovered = jobs::list_for_video(&db, &video.id).await.unwrap();
        let audio = recovered.iter().find(|job| job.stage == "audio").unwrap();
        assert_eq!(audio.status, "failed");
        assert!(audio
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("应用已重启"));

        let queued = list_processing_videos_for_queue(&db, &HashSet::new())
            .await
            .unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].id, video.id);

        dismiss_processing_video(&db, &video.id).await.unwrap();
        let dismissed_status: String =
            sqlx::query_scalar("SELECT processed_status FROM videos WHERE id=?")
                .bind(&video.id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(dismissed_status, "pending");
        assert!(list_processing_videos_for_queue(&db, &HashSet::new())
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn dismissing_a_queue_item_whose_video_is_gone_is_idempotent() {
        let dir = tempdir().unwrap();
        let db = crate::db::Db::connect_and_migrate(&dir.path().join("test.db"))
            .await
            .unwrap();
        let course = create_course(&db, "c".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let video_path = dir.path().join("v.mp4");
        std::fs::write(&video_path, b"fake").unwrap();
        let video = add_local_video(&db, &course.id, video_path, None)
            .await
            .unwrap();
        sqlx::query("UPDATE videos SET deleted_at=1 WHERE id=?")
            .bind(&video.id)
            .execute(&db.pool)
            .await
            .unwrap();

        // 视频被删了，队列里那一条还留着；「移除」必须成功，否则这条永远消不掉。
        dismiss_processing_video(&db, &video.id).await.unwrap();
        // 但一个根本不存在的 id 不能假装成功：那是调用方传错了对象。
        assert!(matches!(
            dismiss_processing_video(&db, "no-such-video").await,
            Err(AppError::NotFound(_))
        ));
    }

    fn install_sherpa(app_data: &Path, model: &local_asr::SherpaModel) {
        let dir = local_asr::model_dir(app_data, model);
        for file in model.files {
            let path = dir.join(file.path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::File::create(&path).unwrap().set_len(file.size).unwrap();
        }
        let vad = local_asr::vad_path(app_data);
        std::fs::File::create(&vad).unwrap().set_len(local_asr::VAD.size).unwrap();
    }

    #[test]
    fn local_model_selection_prefers_the_choice_then_any_installed_model() {
        let dir = tempdir().unwrap();
        let app = dir.path();
        install_sherpa(app, &local_asr::SENSE_VOICE);

        // 选中且装好、语言也认得：就用它。
        assert!(matches!(select_local_model(app, "sensevoice", "zh"), Some(LocalModel::Sherpa(m)) if m.id == "sensevoice"));
        // 选了没装的 Qwen3-ASR：退到装好的 SenseVoice。
        assert!(matches!(select_local_model(app, "qwen3-asr", "zh"), Some(LocalModel::Sherpa(m)) if m.id == "sensevoice"));
        // 设置里还存着已经不支持的 Whisper 模型：当没选，用装好的模型，而不是报「没有可用模型」。
        for stale in ["tiny", "base", "large-v3-turbo"] {
            assert!(matches!(select_local_model(app, stale, "zh"), Some(LocalModel::Sherpa(m)) if m.id == "sensevoice"));
        }
        // SenseVoice 不认法语、又没装别的：没有能用的本地模型。
        assert!(select_local_model(app, "sensevoice", "fr").is_none());
    }

    #[test]
    fn nothing_installed_means_no_local_model() {
        let dir = tempdir().unwrap();
        assert!(select_local_model(dir.path(), DEFAULT_LOCAL_MODEL, "zh").is_none());
    }

    #[test]
    fn slides_ocr_progress_starts_where_the_stage_start_left_off() {
        // 开始时报的是 2%：逐页进度不能再从 0 起，否则一开始识别进度条就往回退。
        let values: Vec<f64> = (0..=4).map(|done| slides_ocr_progress(done, 4)).collect();
        assert_eq!(values[0], 0.02);
        assert!(
            values.windows(2).all(|pair| pair[0] < pair[1]),
            "{values:?}"
        );
        assert_eq!(values[4], 1.0);
        assert_eq!(slides_ocr_progress(0, 0), 1.0);
    }

    #[test]
    fn pipeline_errors_read_without_a_type_prefix() {
        let error = AppError::Pipeline("volcengine submit 失败：鉴权失败".into());
        assert_eq!(error.to_string(), "volcengine submit 失败：鉴权失败");
    }

    #[test]
    fn whisper_language_defaults_to_chinese() {
        assert_eq!(whisper_language_or_default(None), "zh");
        assert_eq!(whisper_language_or_default(Some("".into())), "zh");
        assert_eq!(whisper_language_or_default(Some("en".into())), "en");
    }

    #[test]
    fn asr_backend_defaults_to_whisper() {
        assert_eq!(asr_backend_or_default(None), AsrBackend::Whisper);
        assert_eq!(asr_backend_or_default(Some("".into())), AsrBackend::Whisper);
        assert_eq!(
            asr_backend_or_default(Some("volcengine".into())),
            AsrBackend::Volcengine
        );
        assert_eq!(
            asr_backend_or_default(Some("unknown".into())),
            AsrBackend::Whisper
        );
    }

    #[test]
    fn android_asr_backend_defaults_to_aliyun() {
        assert_eq!(default_asr_backend_for_os("android"), AsrBackend::Aliyun);
        assert_eq!(default_asr_backend_for_os("ios"), AsrBackend::Aliyun);
        assert_eq!(default_asr_backend_for_os("macos"), AsrBackend::Whisper);
    }

    #[test]
    fn mobile_accepts_volcengine_cloud_asr_selection() {
        assert_eq!(
            asr_backend_for_os(Some("volcengine".into()), "ios"),
            AsrBackend::Volcengine
        );
        assert_eq!(
            asr_backend_for_os(Some("volcengine".into()), "android"),
            AsrBackend::Volcengine
        );
        // 手机上也能选本地识别了（sherpa 模型）。
        assert_eq!(
            asr_backend_for_os(Some("whisper".into()), "ios"),
            AsrBackend::Whisper
        );
    }

    #[test]
    fn mobile_uses_whole_file_for_volcengine_upload() {
        assert_eq!(
            volcengine_upload_mode_for_os("ios"),
            VolcengineUploadMode::WholeFile
        );
        assert_eq!(
            volcengine_upload_mode_for_os("android"),
            VolcengineUploadMode::WholeFile
        );
        assert_eq!(
            volcengine_upload_mode_for_os("macos"),
            VolcengineUploadMode::Chunked
        );
    }

    #[test]
    fn asr_done_message_mentions_raw_transcript_when_no_provider_exists() {
        let msg = asr_done_message(12, TranscriptCorrectionOutcome::NoProvider);
        assert_eq!(msg, "12 segments；未配置大模型，当前为原始文稿");
    }
}
