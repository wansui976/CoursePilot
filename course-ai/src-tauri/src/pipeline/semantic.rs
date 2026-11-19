//! 语义检索（按意思找）：给讲稿算向量，提问时按意思召回段落，和关键词检索的结果合在一起。
//!
//! 关键词检索一直都在、始终是主干；这里只是加强——问法和讲课用词对不上时也能找到。
//! 没开、模型没装、索引还没建好、算向量出错，一律退回纯关键词，不影响任何功能。
//!
//! 向量从哪来（设置 → 语义检索）：
//! - 本地：llama.cpp 的 llama-server 跑一个 GGUF 嵌入模型（只在电脑上；手机没有 llama-server）。
//!   进程按需启动，闲置几分钟自动退出。
//! - 云端：大模型设置里某个 OpenAI 兼容（或 Azure）配置的 `/embeddings` 接口。
//!
//! 讲稿按相邻段落拼成一百多字的块再算向量：单条字幕只有十来个字，单独算几乎不带语义。
//! 向量存在 `semantic_chunks`，每个视频建到哪一版记在 `semantic_index_state`。讲稿一改
//! （识别、纠错、同步下来），库里的触发器就删掉这个视频的状态行，下次用到时后台重建。

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;

use crate::commands::settings::get_setting;
use crate::commands::transcripts::{list_segments, TranscriptSegment};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::pipeline::local_asr::ModelFile;

// ---------------------------------------------------------------------------
// 本地嵌入模型

/// 一个本地嵌入模型（单个 GGUF 文件）。
#[derive(Debug)]
pub struct LocalEmbedModel {
    /// 设置里存的值，也是向量来源标识的一部分。
    pub id: &'static str,
    pub display_name: &'static str,
    /// 设置页上的一句说明。
    pub description: &'static str,
    /// 装在 `<模型存放目录>/embed/<dir>/` 下。
    pub dir: &'static str,
    pub file: ModelFile,
    /// llama-server 的 `--pooling`。
    pub pooling: &'static str,
    /// 提问那一侧要加的前缀（模型训练时就是这么用的）；讲稿那一侧不加。
    pub query_prefix: &'static str,
}

macro_rules! urls {
    ($($url:expr),+ $(,)?) => { &[$($url),+] };
}

pub const BGE_SMALL_ZH: LocalEmbedModel = LocalEmbedModel {
    id: "bge-small-zh-v1.5",
    display_name: "BGE Small 中文",
    description: "体积小、建索引快，适合中文课程（推荐）",
    dir: "bge-small-zh-v1.5",
    file: ModelFile {
        path: "bge-small-zh-v1.5-q8_0.gguf",
        sha256: "5a88d266870fbd27c6f329df60de80e2d4cf3bbd5e6f080bd5c1b2e5abb12039",
        size: 26_472_640,
        urls: urls![
            "https://hf-mirror.com/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-q8_0.gguf",
            "https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-q8_0.gguf",
        ],
    },
    pooling: "cls",
    query_prefix: "为这个句子生成表示以用于检索相关文章：",
};

pub const QWEN3_EMBEDDING_06B: LocalEmbedModel = LocalEmbedModel {
    id: "qwen3-embedding-0.6b",
    display_name: "Qwen3-Embedding 0.6B",
    description: "中英文和其它语言都认；体积大，建索引慢十几倍",
    dir: "qwen3-embedding-0.6b",
    file: ModelFile {
        path: "Qwen3-Embedding-0.6B-Q8_0.gguf",
        sha256: "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
        size: 639_150_592,
        urls: urls![
            "https://modelscope.cn/models/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/master/Qwen3-Embedding-0.6B-Q8_0.gguf",
            "https://hf-mirror.com/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf",
            "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf",
        ],
    },
    pooling: "last",
    query_prefix: "Instruct: Given a question about a lecture, retrieve transcript passages from the lecture that answer it\nQuery: ",
};

pub const LOCAL_MODELS: &[&LocalEmbedModel] = &[&BGE_SMALL_ZH, &QWEN3_EMBEDDING_06B];

pub fn local_model(id: &str) -> Option<&'static LocalEmbedModel> {
    LOCAL_MODELS.iter().copied().find(|model| model.id == id)
}

/// 本机能不能跑本地嵌入（手机上没有 llama-server）。
pub const LOCAL_SUPPORTED: bool = cfg!(not(any(target_os = "android", target_os = "ios")));

pub fn model_path(models_root: &Path, model: &LocalEmbedModel) -> PathBuf {
    models_root.join("embed").join(model.dir).join(model.file.path)
}

pub fn is_installed(models_root: &Path, model: &LocalEmbedModel) -> bool {
    std::fs::metadata(model_path(models_root, model))
        .is_ok_and(|meta| meta.is_file() && meta.len() == model.file.size)
}

pub fn missing_files(models_root: &Path, model: &'static LocalEmbedModel) -> Vec<(PathBuf, &'static ModelFile)> {
    if is_installed(models_root, model) {
        Vec::new()
    } else {
        vec![(model_path(models_root, model), &model.file)]
    }
}

// ---------------------------------------------------------------------------
// 配置

/// 设置里的键。
pub const SETTING_BACKEND: &str = "semantic_backend";
pub const SETTING_LOCAL_MODEL: &str = "semantic_local_model";
pub const SETTING_CLOUD_PROFILE: &str = "semantic_cloud_profile";
pub const SETTING_CLOUD_MODEL: &str = "semantic_cloud_model";

/// 当前生效的向量来源。
#[derive(Debug, Clone)]
pub enum Embedder {
    Local {
        model: &'static LocalEmbedModel,
        path: PathBuf,
    },
    Cloud {
        profile_id: String,
        base_url: String,
        model: String,
    },
}

impl Embedder {
    /// 存进库里的「哪个模型算的」。云端用接口地址 + 模型名而不是配置 id：
    /// 同一个接口同一个模型算出来的向量可以互通，配置删了重建也不必重算。
    pub fn id(&self) -> String {
        match self {
            Embedder::Local { model, .. } => format!("local:{}", model.id),
            Embedder::Cloud { base_url, model, .. } => {
                format!("cloud:{}:{}", base_url.trim_end_matches('/'), model)
            }
        }
    }
}

/// 读设置得到当前的向量来源。没开、本地模型没装、云端配置不全，都返回 None（= 只用关键词）。
pub async fn current_embedder(db: &Db) -> AppResult<Option<Embedder>> {
    match get_setting(db, SETTING_BACKEND).await?.as_deref() {
        Some("local") if LOCAL_SUPPORTED => {
            let id = get_setting(db, SETTING_LOCAL_MODEL).await?;
            let Some(model) = id.as_deref().and_then(local_model) else {
                return Ok(None);
            };
            let Ok(root) = crate::pipeline::model_store::current_models_root(db).await else {
                return Ok(None);
            };
            if !is_installed(&root, model) {
                return Ok(None);
            }
            Ok(Some(Embedder::Local {
                model,
                path: model_path(&root, model),
            }))
        }
        Some("cloud") => {
            let profile_id = get_setting(db, SETTING_CLOUD_PROFILE).await?.unwrap_or_default();
            let model = get_setting(db, SETTING_CLOUD_MODEL).await?.unwrap_or_default();
            if profile_id.trim().is_empty() || model.trim().is_empty() {
                return Ok(None);
            }
            let profiles = crate::llm::profiles::parse_profiles(
                get_setting(db, "llm_profiles").await?.as_deref(),
            )?;
            let Some(profile) = profiles.into_iter().find(|profile| profile.id == profile_id) else {
                return Ok(None);
            };
            Ok(Some(Embedder::Cloud {
                profile_id,
                base_url: profile.base_url,
                model: model.trim().to_string(),
            }))
        }
        _ => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// 算向量

/// 算的是提问还是讲稿：部分模型提问一侧要加前缀。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Purpose {
    Query,
    Document,
}

/// 云端一次请求最多送几段。通义的 text-embedding 系列上限是 10，取这个公约数。
const CLOUD_BATCH: usize = 10;
/// 本地一次送几段。
const LOCAL_BATCH: usize = 32;

pub async fn embed(db: &Db, embedder: &Embedder, texts: &[String], purpose: Purpose) -> AppResult<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let mut vectors = match embedder {
        Embedder::Local { model, path } => {
            let inputs: Vec<String> = texts
                .iter()
                .map(|text| match purpose {
                    Purpose::Query => format!("{}{}", model.query_prefix, text),
                    Purpose::Document => text.clone(),
                })
                .collect();
            let mut out = Vec::with_capacity(inputs.len());
            for batch in inputs.chunks(LOCAL_BATCH) {
                out.extend(local_server::embed(model, path, batch).await?);
            }
            out
        }
        Embedder::Cloud { profile_id, model, .. } => {
            let (provider, _) = crate::commands::ai::provider_for_profile(db, profile_id).await?;
            let mut out = Vec::with_capacity(texts.len());
            for batch in texts.chunks(CLOUD_BATCH) {
                let got = provider.embed(model, batch).await?;
                if got.len() != batch.len() {
                    return Err(AppError::Other(format!(
                        "嵌入接口返回了 {} 个向量，送去的是 {} 段",
                        got.len(),
                        batch.len()
                    )));
                }
                out.extend(got);
            }
            out
        }
    };
    for vector in &mut vectors {
        normalize(vector);
    }
    Ok(vectors)
}

fn normalize(vector: &mut [f32]) {
    let norm = vector.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in vector.iter_mut() {
            *x /= norm;
        }
    }
}

fn encode(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn decode(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod local_server {
    //! 本地嵌入用的 llama-server：第一次要用时启动，闲置几分钟自动退出；换模型就换进程。

    use super::*;

    /// 闲置多久退出。问答时现起一个进程要一两秒，所以不是用完就关。
    const IDLE_EXIT: Duration = Duration::from_secs(180);
    const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);
    const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

    struct Server {
        model_id: &'static str,
        child: tokio::process::Child,
        base: String,
        last_used: Instant,
    }

    static SERVER: tokio::sync::Mutex<Option<Server>> = tokio::sync::Mutex::const_new(None);
    static REAPER: OnceLock<()> = OnceLock::new();

    fn http() -> &'static reqwest::Client {
        static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
        CLIENT.get_or_init(|| {
            reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .no_proxy()
                .build()
                .unwrap_or_default()
        })
    }

    async fn start(model: &'static LocalEmbedModel, path: &Path) -> AppResult<Server> {
        let binary = crate::sidecar::resolve(&crate::sidecar::LLAMA_SERVER, None)?;
        let port = std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
        let threads = std::thread::available_parallelism()
            .map(|n| (n.get() / 2).clamp(2, 8))
            .unwrap_or(4);
        let mut child = crate::sidecar::command(&binary)
            .arg("-m")
            .arg(path)
            .args(["--embedding", "--pooling", model.pooling])
            .args(["--host", "127.0.0.1", "--port", &port.to_string()])
            // 一块讲稿一百多字，几百个 token；一批 32 块放得下。
            .args(["-c", "8192", "-b", "8192", "-ub", "8192"])
            .args(["-t", &threads.to_string()])
            .args(["-ngl", "999"])
            .arg("--no-webui")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| AppError::Other(format!("启动本地嵌入模型失败：{error}")))?;
        let base = format!("http://127.0.0.1:{port}");
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        loop {
            if let Ok(response) = http().get(format!("{base}/health")).timeout(Duration::from_secs(2)).send().await {
                if response.status().is_success() {
                    break;
                }
            }
            if matches!(child.try_wait(), Ok(Some(_))) || Instant::now() >= deadline {
                return Err(AppError::Other("本地嵌入模型没能启动（模型文件可能损坏，可在设置里删掉重下）".into()));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        Ok(Server {
            model_id: model.id,
            child,
            base,
            last_used: Instant::now(),
        })
    }

    fn ensure_reaper() {
        REAPER.get_or_init(|| {
            tokio::spawn(async {
                loop {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    let mut guard = SERVER.lock().await;
                    if guard.as_ref().is_some_and(|server| server.last_used.elapsed() >= IDLE_EXIT) {
                        if let Some(mut server) = guard.take() {
                            let _ = server.child.kill().await;
                        }
                    }
                }
            });
        });
    }

    pub async fn embed(model: &'static LocalEmbedModel, path: &Path, inputs: &[String]) -> AppResult<Vec<Vec<f32>>> {
        ensure_reaper();
        let base = {
            let mut guard = SERVER.lock().await;
            let alive = guard
                .as_mut()
                .is_some_and(|server| server.model_id == model.id && matches!(server.child.try_wait(), Ok(None)));
            if !alive {
                if let Some(mut old) = guard.take() {
                    let _ = old.child.kill().await;
                }
                *guard = Some(start(model, path).await?);
            }
            let server = guard.as_mut().expect("just started");
            server.last_used = Instant::now();
            server.base.clone()
        };
        let response = http()
            .post(format!("{base}/v1/embeddings"))
            .json(&serde_json::json!({ "input": inputs }))
            .send()
            .await
            .map_err(|error| AppError::Other(format!("本地嵌入模型请求失败：{error}")))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Other(format!("本地嵌入模型返回 {status}：{}", body.chars().take(200).collect::<String>())));
        }
        let value: serde_json::Value = response.json().await.map_err(|error| AppError::Other(error.to_string()))?;
        let mut rows: Vec<(usize, Vec<f32>)> = value["data"]
            .as_array()
            .map(|data| {
                data.iter()
                    .map(|row| {
                        let index = row["index"].as_u64().unwrap_or(0) as usize;
                        let vector = row["embedding"]
                            .as_array()
                            .map(|values| values.iter().map(|v| v.as_f64().unwrap_or(0.0) as f32).collect())
                            .unwrap_or_default();
                        (index, vector)
                    })
                    .collect()
            })
            .unwrap_or_default();
        rows.sort_by_key(|(index, _)| *index);
        if rows.len() != inputs.len() || rows.iter().any(|(_, vector)| vector.is_empty()) {
            return Err(AppError::Other("本地嵌入模型的返回不完整".into()));
        }
        if let Some(server) = SERVER.lock().await.as_mut() {
            server.last_used = Instant::now();
        }
        Ok(rows.into_iter().map(|(_, vector)| vector).collect())
    }

    /// 删模型前先把用着它的进程停掉（Windows 上进程开着文件就删不掉）。
    pub async fn stop() {
        if let Some(mut server) = SERVER.lock().await.take() {
            let _ = server.child.kill().await;
        }
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
mod local_server {
    use super::*;

    pub async fn embed(_model: &'static LocalEmbedModel, _path: &Path, _inputs: &[String]) -> AppResult<Vec<Vec<f32>>> {
        Err(AppError::Other("手机上不能跑本地嵌入模型".into()))
    }

    pub async fn stop() {}
}

pub use local_server::stop as stop_local_server;

// ---------------------------------------------------------------------------
// 分块

/// 一块讲稿至少拼到这么多字。
pub const CHUNK_MIN_CHARS: usize = 120;

#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub idx: i64,
    pub first_segment: i64,
    pub last_segment: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// 相邻段落按顺序拼成块，每块至少 `CHUNK_MIN_CHARS` 字（最后一块可以短）。纯函数，可单测。
pub fn chunk_segments(segments: &[TranscriptSegment]) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut current: Option<Chunk> = None;
    let mut chars = 0usize;
    for segment in segments {
        let text = segment.text.trim();
        if text.is_empty() {
            continue;
        }
        let chunk = current.get_or_insert_with(|| Chunk {
            idx: chunks.len() as i64,
            first_segment: segment.segment_idx,
            last_segment: segment.segment_idx,
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            text: String::new(),
        });
        chunk.text.push_str(text);
        chunk.last_segment = segment.segment_idx;
        chunk.end_ms = segment.end_ms.max(chunk.end_ms);
        chars += text.chars().count();
        if chars >= CHUNK_MIN_CHARS {
            chunks.push(current.take().expect("just filled"));
            chars = 0;
        }
    }
    chunks.extend(current);
    chunks
}

// ---------------------------------------------------------------------------
// 向量的内存缓存：问答时不必每次把整门课的向量从库里读一遍。

struct VideoVectors {
    indexed_at: i64,
    dim: usize,
    chunks: Vec<Chunk>,
    /// 按块顺序摊平的向量（每块 dim 个数）。
    matrix: Vec<f32>,
}

type CacheKey = (String, String);

fn cache() -> &'static Mutex<HashMap<CacheKey, Arc<VideoVectors>>> {
    static CACHE: OnceLock<Mutex<HashMap<CacheKey, Arc<VideoVectors>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn load_vectors(db: &Db, video_id: &str, embedder: &str, indexed_at: i64) -> AppResult<Arc<VideoVectors>> {
    let key = (video_id.to_string(), embedder.to_string());
    if let Some(hit) = cache().lock().unwrap().get(&key) {
        if hit.indexed_at == indexed_at {
            return Ok(hit.clone());
        }
    }
    let rows: Vec<(i64, i64, i64, i64, i64, String, Vec<u8>)> = sqlx::query_as(
        "SELECT chunk_idx, first_segment, last_segment, start_ms, end_ms, text, vector
         FROM semantic_chunks WHERE video_id=? AND embedder=? ORDER BY chunk_idx",
    )
    .bind(video_id)
    .bind(embedder)
    .fetch_all(&db.pool)
    .await?;
    let mut dim = 0;
    let mut chunks = Vec::with_capacity(rows.len());
    let mut matrix = Vec::new();
    for (idx, first_segment, last_segment, start_ms, end_ms, text, vector) in rows {
        let vector = decode(&vector);
        if dim == 0 {
            dim = vector.len();
        }
        if vector.len() != dim {
            continue;
        }
        matrix.extend(vector);
        chunks.push(Chunk { idx, first_segment, last_segment, start_ms, end_ms, text });
    }
    let loaded = Arc::new(VideoVectors { indexed_at, dim, chunks, matrix });
    cache().lock().unwrap().insert(key, loaded.clone());
    Ok(loaded)
}

// ---------------------------------------------------------------------------
// 检索

#[derive(Debug, Clone)]
pub struct SemanticHit {
    pub video_id: String,
    pub chunk: Chunk,
    pub score: f32,
}

/// 按意思找最像的 `top_k` 块。范围里还没建好索引的视频会被排进后台建索引，这一次先跳过。
/// 没开语义检索时返回空列表。
pub async fn search(db: &Db, videos: &[String], query: &str, top_k: usize) -> AppResult<Vec<SemanticHit>> {
    let Some(embedder) = current_embedder(db).await? else {
        return Ok(Vec::new());
    };
    let embedder_id = embedder.id();
    let scope = serde_json::to_string(videos)?;
    let states: Vec<(String, i64)> = sqlx::query_as(
        "SELECT video_id, indexed_at FROM semantic_index_state
         WHERE embedder=? AND video_id IN (SELECT value FROM json_each(?))",
    )
    .bind(&embedder_id)
    .bind(&scope)
    .fetch_all(&db.pool)
    .await?;
    let indexed: HashSet<&str> = states.iter().map(|(id, _)| id.as_str()).collect();
    let missing: Vec<String> = videos.iter().filter(|id| !indexed.contains(id.as_str())).cloned().collect();
    if !missing.is_empty() {
        enqueue(missing);
    }
    if states.is_empty() {
        return Ok(Vec::new());
    }
    let query_vector = embed(db, &embedder, &[query.to_string()], Purpose::Query)
        .await?
        .pop()
        .unwrap_or_default();
    let mut hits = Vec::new();
    for (video_id, indexed_at) in &states {
        let vectors = load_vectors(db, video_id, &embedder_id, *indexed_at).await?;
        if vectors.dim != query_vector.len() {
            continue;
        }
        for (i, chunk) in vectors.chunks.iter().enumerate() {
            let row = &vectors.matrix[i * vectors.dim..(i + 1) * vectors.dim];
            let score: f32 = row.iter().zip(&query_vector).map(|(a, b)| a * b).sum();
            hits.push(SemanticHit { video_id: video_id.clone(), chunk: chunk.clone(), score });
        }
    }
    hits.sort_by(|a, b| b.score.total_cmp(&a.score));
    hits.truncate(top_k);
    Ok(hits)
}

/// 和 [`search`] 一样，但最多等 `limit`：问答不能因为加强功能而卡住。
/// 超时或出错都只记日志、返回空列表（= 这一次只用关键词）。
pub async fn search_or_skip(db: &Db, videos: &[String], query: &str, top_k: usize) -> Vec<SemanticHit> {
    const LIMIT: Duration = Duration::from_secs(10);
    match tokio::time::timeout(LIMIT, search(db, videos, query, top_k)).await {
        Ok(Ok(hits)) => hits,
        Ok(Err(error)) => {
            tracing::warn!(%error, "语义检索失败，这次只用关键词");
            Vec::new()
        }
        Err(_) => {
            tracing::warn!("语义检索超时，这次只用关键词");
            Vec::new()
        }
    }
}

// ---------------------------------------------------------------------------
// 后台建索引

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub running: bool,
    /// 队列里还剩几个视频（含正在建的）。
    pub pending: usize,
    /// 这一轮已建好几个。
    pub done: usize,
    pub current_title: Option<String>,
    pub last_error: Option<String>,
}

struct Indexer {
    app: Option<tauri::AppHandle>,
    db: Db,
    queue: Mutex<VecDeque<String>>,
    queued: Mutex<HashSet<String>>,
    progress: Mutex<IndexProgress>,
    wake: tokio::sync::Notify,
    /// 设置一变就 +1：正在建的那个视频算完后发现代数变了，就不往库里写（向量来源已经不是它了）。
    generation: std::sync::atomic::AtomicU64,
}

static INDEXER: OnceLock<Arc<Indexer>> = OnceLock::new();

pub const PROGRESS_EVENT: &str = "semantic-index:progress";

/// 应用启动时调用一次：起后台线程，并把还没建索引的视频排进去。
pub fn init(app: tauri::AppHandle, db: Db) {
    init_inner(Some(app), db);
    enqueue_all_missing();
}

fn init_inner(app: Option<tauri::AppHandle>, db: Db) -> Arc<Indexer> {
    INDEXER
        .get_or_init(|| {
            let indexer = Arc::new(Indexer {
                app,
                db,
                queue: Mutex::new(VecDeque::new()),
                queued: Mutex::new(HashSet::new()),
                progress: Mutex::new(IndexProgress::default()),
                wake: tokio::sync::Notify::new(),
                generation: std::sync::atomic::AtomicU64::new(0),
            });
            let worker = indexer.clone();
            tauri::async_runtime::spawn(async move { worker.run().await });
            indexer
        })
        .clone()
}

/// 把这些视频排进建索引队列（已在队列里的跳过）。
pub fn enqueue(videos: Vec<String>) {
    let Some(indexer) = INDEXER.get() else { return };
    let mut added = false;
    {
        let mut queue = indexer.queue.lock().unwrap();
        let mut queued = indexer.queued.lock().unwrap();
        for video in videos {
            if queued.insert(video.clone()) {
                queue.push_back(video);
                added = true;
            }
        }
    }
    if added {
        indexer.update(|progress| progress.pending = indexer.queue.lock().unwrap().len());
        indexer.wake.notify_one();
    }
}

/// 设置改了：清空队列、作废正在建的那个，再把当前来源下还没建的全排进去。
pub fn restart() {
    let Some(indexer) = INDEXER.get() else { return };
    indexer.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    indexer.queue.lock().unwrap().clear();
    indexer.queued.lock().unwrap().clear();
    indexer.update(|progress| *progress = IndexProgress::default());
    enqueue_all_missing();
}

/// 上一轮因为出错停下了：清掉错误，把没建的重新排上（设置页的「重试」）。
pub fn resume() {
    if let Some(indexer) = INDEXER.get() {
        indexer.update(|progress| progress.last_error = None);
    }
    enqueue_all_missing();
}

/// 当前来源下还没建索引（或讲稿改过）的视频全排进队列。
pub fn enqueue_all_missing() {
    let Some(indexer) = INDEXER.get().cloned() else { return };
    tauri::async_runtime::spawn(async move {
        match missing_videos(&indexer.db).await {
            Ok(videos) => enqueue(videos),
            Err(error) => tracing::warn!(%error, "列出待建索引的视频失败"),
        }
    });
}

async fn missing_videos(db: &Db) -> AppResult<Vec<String>> {
    let Some(embedder) = current_embedder(db).await? else {
        return Ok(Vec::new());
    };
    Ok(sqlx::query_scalar(
        "SELECT v.id FROM videos v
         WHERE v.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM transcripts t WHERE t.video_id = v.id)
           AND NOT EXISTS (SELECT 1 FROM semantic_index_state s WHERE s.video_id = v.id AND s.embedder = ?)
         ORDER BY v.created_at DESC",
    )
    .bind(embedder.id())
    .fetch_all(&db.pool)
    .await?)
}

pub fn progress() -> IndexProgress {
    INDEXER
        .get()
        .map(|indexer| indexer.progress.lock().unwrap().clone())
        .unwrap_or_default()
}

impl Indexer {
    fn update(&self, change: impl FnOnce(&mut IndexProgress)) {
        let snapshot = {
            let mut progress = self.progress.lock().unwrap();
            change(&mut progress);
            progress.clone()
        };
        if let Some(app) = &self.app {
            app.emit(PROGRESS_EVENT, snapshot).ok();
        }
    }

    async fn run(self: Arc<Self>) {
        loop {
            let next = self.queue.lock().unwrap().front().cloned();
            let Some(video_id) = next else {
                self.update(|progress| {
                    progress.running = false;
                    progress.pending = 0;
                    progress.current_title = None;
                });
                self.wake.notified().await;
                continue;
            };
            let generation = self.generation.load(std::sync::atomic::Ordering::SeqCst);
            let title: Option<String> = sqlx::query_scalar("SELECT title FROM videos WHERE id=?")
                .bind(&video_id)
                .fetch_optional(&self.db.pool)
                .await
                .ok()
                .flatten();
            self.update(|progress| {
                progress.running = true;
                progress.current_title = title;
            });
            let result = index_video(&self.db, &video_id, Some((self.as_ref(), generation))).await;
            {
                let mut queue = self.queue.lock().unwrap();
                if queue.front() == Some(&video_id) {
                    queue.pop_front();
                }
                self.queued.lock().unwrap().remove(&video_id);
            }
            let pending = self.queue.lock().unwrap().len();
            match result {
                Ok(_) => self.update(|progress| {
                    progress.done += 1;
                    progress.pending = pending;
                    progress.last_error = None;
                }),
                Err(error) => {
                    tracing::warn!(%error, %video_id, "建语义索引失败");
                    // 配置性错误（Key 不对、接口不支持嵌入）每个视频都会一样失败：整轮停下，别刷屏也别白花钱。
                    let message = error.to_string();
                    self.queue.lock().unwrap().clear();
                    self.queued.lock().unwrap().clear();
                    self.update(|progress| {
                        progress.pending = 0;
                        progress.last_error = Some(message);
                    });
                }
            }
        }
    }

    fn stale(&self, generation: u64) -> bool {
        self.generation.load(std::sync::atomic::Ordering::SeqCst) != generation
    }
}

/// 立刻给一个视频建索引（不经后台队列）。测试和以后的「处理完就建」用。
pub async fn index_video_now(db: &Db, video_id: &str) -> AppResult<usize> {
    index_video(db, video_id, None).await
}

/// 给一个视频建（或重建）索引。返回块数。
async fn index_video(db: &Db, video_id: &str, guard: Option<(&Indexer, u64)>) -> AppResult<usize> {
    let Some(embedder) = current_embedder(db).await? else {
        return Ok(0);
    };
    let embedder_id = embedder.id();
    let segments = list_segments(db, video_id).await?;
    let chunks = chunk_segments(&segments);
    // 记下动手时讲稿的样子：算向量要一会儿，期间讲稿若被改过，这份向量就不该落库。
    let started_at = chrono::Utc::now().timestamp_millis();
    let texts: Vec<String> = chunks.iter().map(|chunk| chunk.text.clone()).collect();
    let vectors = embed(db, &embedder, &texts, Purpose::Document).await?;
    if guard.is_some_and(|(indexer, generation)| indexer.stale(generation)) {
        return Ok(0);
    }
    let mut tx = db.begin_write().await?;
    // 讲稿在算向量期间变了（重新识别、纠错）：这份向量对应的是旧讲稿，丢掉，等下一轮。
    // 在同一个事务里比，比完到提交之间讲稿不会再变。
    let now: Vec<(i64, String)> =
        sqlx::query_as("SELECT segment_idx, text FROM transcripts WHERE video_id=? ORDER BY segment_idx")
            .bind(video_id)
            .fetch_all(&mut *tx)
            .await?;
    let unchanged = now.len() == segments.len()
        && now
            .iter()
            .zip(&segments)
            .all(|((idx, text), segment)| *idx == segment.segment_idx && *text == segment.text);
    if !unchanged {
        return Ok(0);
    }
    sqlx::query("DELETE FROM semantic_chunks WHERE video_id=? AND embedder=?")
        .bind(video_id)
        .bind(&embedder_id)
        .execute(&mut *tx)
        .await?;
    for (chunk, vector) in chunks.iter().zip(&vectors) {
        sqlx::query(
            "INSERT INTO semantic_chunks(video_id, embedder, chunk_idx, first_segment, last_segment, start_ms, end_ms, text, vector)
             VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .bind(video_id)
        .bind(&embedder_id)
        .bind(chunk.idx)
        .bind(chunk.first_segment)
        .bind(chunk.last_segment)
        .bind(chunk.start_ms)
        .bind(chunk.end_ms)
        .bind(&chunk.text)
        .bind(encode(vector))
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "INSERT INTO semantic_index_state(video_id, embedder, chunks, indexed_at) VALUES (?,?,?,?)
         ON CONFLICT(video_id, embedder) DO UPDATE SET chunks=excluded.chunks, indexed_at=excluded.indexed_at",
    )
    .bind(video_id)
    .bind(&embedder_id)
    .bind(chunks.len() as i64)
    .bind(started_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(chunks.len())
}

/// 当前来源下建好索引的视频数 / 有讲稿的视频数。
pub async fn index_counts(db: &Db) -> AppResult<(i64, i64)> {
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM videos v WHERE v.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM transcripts t WHERE t.video_id = v.id)",
    )
    .fetch_one(&db.pool)
    .await?;
    let Some(embedder) = current_embedder(db).await? else {
        return Ok((0, total));
    };
    let indexed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM semantic_index_state s JOIN videos v ON v.id = s.video_id
         WHERE s.embedder = ? AND v.deleted_at IS NULL",
    )
    .bind(embedder.id())
    .fetch_one(&db.pool)
    .await?;
    Ok((indexed, total))
}

/// 删掉当前来源下的全部索引并重建。
pub async fn rebuild(db: &Db) -> AppResult<()> {
    if let Some(embedder) = current_embedder(db).await? {
        let id = embedder.id();
        sqlx::query("DELETE FROM semantic_index_state WHERE embedder=?").bind(&id).execute(&db.pool).await?;
        sqlx::query("DELETE FROM semantic_chunks WHERE embedder=?").bind(&id).execute(&db.pool).await?;
        cache().lock().unwrap().retain(|(_, embedder), _| embedder != &id);
    }
    restart();
    Ok(())
}

/// 测试用：本地起一个假的 OpenAI 兼容 `/embeddings` 接口，再把设置指向它。
/// 向量按「几组同义词各出现没有」来算——用词不同、意思相同的两句话得到同一个方向，
/// 正好用来验证「关键词对不上也能按意思找到」。
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// 每组是一个「意思」：组里任一个词出现，这一维就是 1。
    pub const CONCEPTS: &[&[&str]] = &[
        &["学习率", "步长", "步子"],
        &["过拟合", "死记硬背", "泛化"],
        &["梯度", "下降最快"],
    ];

    pub fn fake_vector(text: &str) -> Vec<f32> {
        let mut vector: Vec<f32> = CONCEPTS
            .iter()
            .map(|words| if words.iter().any(|word| text.contains(word)) { 1.0 } else { 0.0 })
            .collect();
        vector.push(0.05);
        vector
    }

    /// 起服务、写好设置（云端来源），返回服务收到的请求数计数器。
    pub async fn use_fake_cloud(db: &Db) -> Arc<std::sync::atomic::AtomicUsize> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let counter = requests.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let counter = counter.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 8192];
                    let body = loop {
                        let n = socket.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        let text = String::from_utf8_lossy(&buf).to_string();
                        if let Some(split) = text.find("\r\n\r\n") {
                            let length = text[..split]
                                .lines()
                                .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                                .unwrap_or(0);
                            if buf.len() >= split + 4 + length {
                                break String::from_utf8_lossy(&buf[split + 4..split + 4 + length]).to_string();
                            }
                        }
                    };
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let request: serde_json::Value = serde_json::from_str(&body).unwrap();
                    let data: Vec<serde_json::Value> = request["input"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .enumerate()
                        .map(|(index, text)| serde_json::json!({ "index": index, "embedding": fake_vector(text.as_str().unwrap()) }))
                        .collect();
                    let reply = serde_json::json!({ "data": data }).to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                        reply.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        let profiles = serde_json::json!([{
            "id": "fake", "name": "假接口", "kind": "openai",
            "base_url": format!("http://{addr}/v1"), "model": "chat", "key_required": false
        }]);
        crate::commands::settings::set_setting(db, "llm_profiles", &profiles.to_string()).await.unwrap();
        crate::commands::settings::set_setting(db, SETTING_BACKEND, "cloud").await.unwrap();
        crate::commands::settings::set_setting(db, SETTING_CLOUD_PROFILE, "fake").await.unwrap();
        crate::commands::settings::set_setting(db, SETTING_CLOUD_MODEL, "fake-embedding").await.unwrap();
        requests
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn video_with_transcript(db: &Db, lines: &[&str]) -> String {
        let dir = tempfile::tempdir().unwrap();
        let course = crate::commands::courses::create_course(db, "c".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let path = dir.path().join("a.mp4");
        std::fs::write(&path, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(db, &course.id, path, None).await.unwrap();
        for (i, line) in lines.iter().enumerate() {
            sqlx::query("INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text) VALUES (?,?,?,?,?)")
                .bind(&video.id)
                .bind(i as i64)
                .bind(i as i64 * 60_000)
                .bind(i as i64 * 60_000 + 50_000)
                .bind(line)
                .execute(&db.pool)
                .await
                .unwrap();
        }
        std::mem::forget(dir);
        video.id
    }

    fn padded(text: &str) -> String {
        // 每段凑够一块的长度，一段就是一块，好断言是哪一块被找到。
        format!("{text}{}", "。".repeat(CHUNK_MIN_CHARS))
    }

    #[tokio::test]
    async fn indexed_chunks_are_found_by_meaning_and_go_stale_when_the_transcript_changes() {
        let db = Db::connect_and_migrate(&crate::db::test_db_path("semantic")).await.unwrap();
        let requests = test_support::use_fake_cloud(&db).await;
        let video = video_with_transcript(
            &db,
            &[&padded("学习率设得太大，参数会在谷底两边来回震荡"), &padded("模型在训练集上死记硬背，换了数据就不行")],
        )
        .await;

        assert_eq!(index_video_now(&db, &video).await.unwrap(), 2);
        assert_eq!(index_counts(&db).await.unwrap(), (1, 1));

        // 用词完全对不上，意思是第二段。
        let hits = search(&db, &[video.clone()], "为什么换一批题就做不对了，泛化能力差", 1).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].chunk.first_segment, 1);
        assert!(requests.load(std::sync::atomic::Ordering::SeqCst) >= 2);

        // 讲稿一改，触发器删掉状态行：这个视频不再参与语义检索，直到重建。
        sqlx::query("UPDATE transcripts SET text=? WHERE video_id=? AND segment_idx=0")
            .bind(padded("学习率改小一点就稳了"))
            .bind(&video)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(index_counts(&db).await.unwrap(), (0, 1));
        assert!(search(&db, &[video.clone()], "泛化能力差", 3).await.unwrap().is_empty());

        assert_eq!(index_video_now(&db, &video).await.unwrap(), 2);
        assert_eq!(search(&db, &[video.clone()], "泛化能力差", 3).await.unwrap().len(), 2);
    }

    /// 真模型、真讲稿（手动跑）：本机 llama-server + BGE Small，给开发库副本里的几个视频建索引再按意思搜。
    /// `SEMANTIC_DB=/tmp/x.db SEMANTIC_MODELS=/dir/with/embed cargo test --lib real_local_embedding -- --ignored --nocapture`
    /// 模型放在 `$SEMANTIC_MODELS/embed/bge-small-zh-v1.5/bge-small-zh-v1.5-q8_0.gguf`。
    #[tokio::test]
    #[ignore = "需要真模型、llama-server 和一份开发库副本"]
    async fn real_local_embedding() {
        let binaries = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let shim = tempfile::tempdir().unwrap();
        let target = std::fs::read_dir(&binaries)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.file_name().is_some_and(|name| name.to_string_lossy().starts_with("llama-server")))
            .expect("binaries/ 里没有 llama-server");
        std::os::unix::fs::symlink(&target, shim.path().join("llama-server")).unwrap();
        std::env::set_var("PATH", format!("{}:{}", shim.path().display(), std::env::var("PATH").unwrap_or_default()));

        let db = Db::connect_and_migrate(std::path::Path::new(&std::env::var("SEMANTIC_DB").unwrap())).await.unwrap();
        let models = std::env::var("SEMANTIC_MODELS").unwrap();
        crate::pipeline::model_store::remember_app_data(std::path::Path::new(&models));
        crate::commands::settings::set_setting(&db, crate::pipeline::model_store::MODELS_DIR_SETTING, &models).await.unwrap();
        crate::commands::settings::set_setting(&db, SETTING_BACKEND, "local").await.unwrap();
        crate::commands::settings::set_setting(&db, SETTING_LOCAL_MODEL, BGE_SMALL_ZH.id).await.unwrap();
        assert!(current_embedder(&db).await.unwrap().is_some(), "模型没装好");

        let videos: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM videos v WHERE deleted_at IS NULL AND EXISTS(SELECT 1 FROM transcripts t WHERE t.video_id=v.id) LIMIT 5",
        )
        .fetch_all(&db.pool)
        .await
        .unwrap();
        let started = Instant::now();
        let mut chunks = 0;
        for video in &videos {
            chunks += index_video_now(&db, video).await.unwrap();
        }
        eprintln!("indexed {} videos / {chunks} chunks in {:?}", videos.len(), started.elapsed());
        for query in ["考试时字数不够怎么办", "面试时坐姿有什么讲究", "材料里第一段一般写什么"] {
            let started = Instant::now();
            let hits = search(&db, &videos, query, 2).await.unwrap();
            eprintln!("{query} ({:?})", started.elapsed());
            for hit in hits {
                eprintln!("  {:.3} {}", hit.score, hit.chunk.text.chars().take(60).collect::<String>());
            }
        }
        stop_local_server().await;
    }

    #[tokio::test]
    async fn without_a_configured_source_nothing_is_indexed_or_searched() {
        let db = Db::connect_and_migrate(&crate::db::test_db_path("semantic_off")).await.unwrap();
        let video = video_with_transcript(&db, &["学习率"]).await;
        assert!(current_embedder(&db).await.unwrap().is_none());
        assert_eq!(index_video_now(&db, &video).await.unwrap(), 0);
        assert!(search(&db, &[video], "步长", 3).await.unwrap().is_empty());
    }

    fn segment(idx: i64, text: &str) -> TranscriptSegment {
        TranscriptSegment {
            id: idx,
            video_id: "v".into(),
            segment_idx: idx,
            start_ms: idx * 1000,
            end_ms: idx * 1000 + 900,
            text: text.into(),
        }
    }

    #[test]
    fn segments_are_joined_into_chunks_of_at_least_the_minimum_length() {
        let long = "字".repeat(50);
        let segments: Vec<_> = (0..7).map(|i| segment(i, &long)).collect();
        let chunks = chunk_segments(&segments);
        // 50 + 50 + 50 = 150 ≥ 120 → 每三段一块，最后剩一段单独成块。
        assert_eq!(chunks.len(), 3);
        assert_eq!((chunks[0].first_segment, chunks[0].last_segment), (0, 2));
        assert_eq!((chunks[2].first_segment, chunks[2].last_segment), (6, 6));
        assert_eq!(chunks[1].start_ms, 3000);
        assert_eq!(chunks[1].end_ms, 5900);
        assert_eq!(chunks.iter().map(|c| c.idx).collect::<Vec<_>>(), [0, 1, 2]);
    }

    #[test]
    fn blank_segments_do_not_start_or_pad_chunks() {
        let chunks = chunk_segments(&[segment(0, "  "), segment(1, "有内容"), segment(2, "")]);
        assert_eq!(chunks.len(), 1);
        assert_eq!((chunks[0].first_segment, chunks[0].last_segment), (1, 1));
        assert_eq!(chunks[0].text, "有内容");
    }

    #[test]
    fn vectors_round_trip_through_the_blob_encoding() {
        let mut vector = vec![3.0f32, 4.0];
        normalize(&mut vector);
        assert_eq!(decode(&encode(&vector)), vec![0.6, 0.8]);
    }

    #[test]
    fn cloud_vectors_are_keyed_by_endpoint_and_model_not_by_profile() {
        let a = Embedder::Cloud { profile_id: "p1".into(), base_url: "https://x/v1/".into(), model: "m".into() };
        let b = Embedder::Cloud { profile_id: "p2".into(), base_url: "https://x/v1".into(), model: "m".into() };
        assert_eq!(a.id(), b.id());
    }
}
