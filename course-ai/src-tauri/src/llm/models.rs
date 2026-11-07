//! 模型列表：按协议拉取 → 合并内置目录 → 缓存到 settings。
//!
//! 缓存的意义不只是省一次请求：很多兼容端点的 `/models` 要 1–3 秒，设置页一打开就卡住；
//! 而模型清单一天里几乎不变。缓存 24 小时，手动点「刷新」可以绕过。

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::commands::settings::{get_setting, set_setting};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::catalog;
use crate::llm::keychain;
use crate::llm::profiles::{LlmProfile, ProviderKind};

const CACHE_PREFIX: &str = "llm_models_cache:";
/// 模型清单一天内基本不变；手动刷新始终生效。
const CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCapabilities {
    pub vision: bool,
    pub tools: bool,
    pub json: bool,
    pub reasoning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    /// USD / 1M tokens（参考价）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_price: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_price: Option<f64>,
    #[serde(default)]
    pub capabilities: ModelCapabilities,
    /// 元数据从哪来：`provider`（接口自带）/ `catalog`（内置目录）/ `provider+catalog`。
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelList {
    pub models: Vec<ModelInfo>,
    pub cached: bool,
    pub fetched_at: i64,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct Provided {
    id: String,
    display_name: Option<String>,
    context: Option<u32>,
    max_output: Option<u32>,
    input: Option<f64>,
    output: Option<f64>,
    capabilities: Option<ModelCapabilities>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedModels {
    fingerprint: String,
    fetched_at: i64,
    models: Vec<ModelInfo>,
    #[serde(default)]
    note: Option<String>,
}

fn fingerprint(profile: &LlmProfile) -> String {
    // deployment 也算进去：Azure 改 deployment 后清单（或那个手填部署名的提示）会变，
    // 漏掉它就会继续拿旧缓存，设置页看起来像没改成功。
    format!(
        "{:?}|{}|{:?}|{:?}|{:?}",
        profile.kind,
        profile.base_url.trim(),
        profile.api_version,
        profile.models_path,
        profile.deployment
    )
}

fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| AppError::Other(format!("创建 HTTP 客户端失败：{error}")))
}

fn base(profile: &LlmProfile, fallback: &str) -> String {
    let trimmed = profile.base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        fallback.trim_end_matches('/').to_string()
    } else {
        trimmed.to_string()
    }
}

fn join(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

/// 列模型地址：允许填完整 URL（例如各家网关的自定义路径），否则拼在 base 后面。
fn resolve_endpoint(base: &str, path: Option<&str>, fallback: impl FnOnce() -> String) -> String {
    match path {
        Some(path) if path.starts_with("http://") || path.starts_with("https://") => {
            path.to_string()
        }
        Some(path) => join(base, path),
        None => fallback(),
    }
}

fn http_error(protocol: &str, status: reqwest::StatusCode, body: &str) -> AppError {
    let snippet: String = body.chars().take(400).collect();
    let kind = if status == reqwest::StatusCode::UNAUTHORIZED
        || status == reqwest::StatusCode::FORBIDDEN
    {
        "鉴权失败（API Key 不对，或这把 Key 没有权限）"
    } else if status == reqwest::StatusCode::NOT_FOUND {
        "接口不存在（检查 Base URL / 协议是否选对）"
    } else {
        "请求失败"
    };
    AppError::Other(format!("{protocol} 获取模型列表{kind}（HTTP {status}）：{snippet}"))
}

/// 拉取模型列表（或用缓存）。`api_key` 是设置页里刚输入、还没保存的 Key。
pub async fn list(
    db: &Db,
    profile: &LlmProfile,
    api_key: Option<String>,
    refresh: bool,
) -> AppResult<ModelList> {
    let cache_key = format!("{CACHE_PREFIX}{}", profile.id);
    let print = fingerprint(profile);
    if !refresh {
        if let Some(cached) = read_cache(db, &cache_key, &print).await? {
            return Ok(ModelList {
                models: cached.models,
                cached: true,
                fetched_at: cached.fetched_at,
                source: "cache".into(),
                note: cached.note,
            });
        }
    }

    // Key 只在协议真的需要时从钥匙串读。不再「先读出来再判断」：
    // 对 Ollama 这类免 Key 协议，读出来既没必要，也让「草稿 id 撞上已存配置」
    // 多了一条把 Key 取出来的路径。
    let key = match api_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        Some(key) => Some(key),
        None if profile.requires_key() => keychain::get_api_key(db, &profile.id).await?,
        None => None,
    }
    .filter(|key| !key.is_empty());
    if profile.requires_key() && key.is_none() {
        return Err(AppError::Config("还没有填 API Key；获取模型列表需要先填 Key（Ollama 不需要）".into()));
    }

    let (provided, note) = fetch(profile, key.as_deref()).await?;
    let fetched_at = chrono::Utc::now().timestamp_millis();
    let models = enrich_all(profile, provided);
    if !models.is_empty() {
        write_cache(
            db,
            &cache_key,
            &CachedModels {
                fingerprint: print,
                fetched_at,
                models: models.clone(),
                note: note.clone(),
            },
        )
        .await?;
    }
    Ok(ModelList {
        models,
        cached: false,
        fetched_at,
        source: "live".into(),
        note,
    })
}

/// 设置页拿「草稿配置」来列模型时，决定真正该用哪份配置发请求。
///
/// 钥匙串里的 Key 属于**已保存**的那份配置。草稿里的 base_url / 协议是前端可改的，
/// 直接拿来用就等于：谁能让 WebView 执行一段脚本，谁就能指定一个地址、借已存的 Key
/// 发一次请求，把 Key 以 Authorization 头的形式送到自己手里。设置页里改错地址后点
/// 「获取模型」也会把旧 Key 发给新主机，同样不该无声发生。
///
/// 规则：
/// - 显式带了 Key：用草稿（Key 是用户刚输入的，发到哪由自己负责）；
/// - 没带 Key 且草稿与已保存配置的连接信息一致：用已保存的配置（请求仍然发往原地址）；
/// - 没带 Key 但连接信息变了：拒绝，要求重新输入 Key；
/// - 草稿本身不需要 Key（Ollama / 显式关掉免 Key）：允许草稿，`list` 也不会去读钥匙串。
pub fn resolve_for_listing(
    draft: &LlmProfile,
    saved: Option<&LlmProfile>,
    has_explicit_key: bool,
) -> AppResult<LlmProfile> {
    if has_explicit_key || !draft.requires_key() {
        return Ok(draft.clone());
    }
    match saved {
        Some(saved) if same_connection(saved, draft) => Ok(saved.clone()),
        Some(_) => Err(AppError::Config(
            "地址或协议已修改：请重新输入 API Key 后再获取模型".into(),
        )),
        None => Ok(draft.clone()),
    }
}

/// 两份配置是否会向同一个地址、按同一种协议发请求。
/// 模型名和展示名不算连接信息：改模型不该逼用户重新输一遍 Key。
pub fn same_connection(a: &LlmProfile, b: &LlmProfile) -> bool {
    let url = |profile: &LlmProfile| {
        profile
            .base_url
            .trim()
            .trim_end_matches('/')
            .to_string()
    };
    let opt = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    a.kind == b.kind
        && url(a) == url(b)
        && opt(&a.api_version) == opt(&b.api_version)
        && opt(&a.deployment) == opt(&b.deployment)
        && opt(&a.models_path) == opt(&b.models_path)
}

pub async fn invalidate(db: &Db, profile_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM settings WHERE key=?")
        .bind(format!("{CACHE_PREFIX}{profile_id}"))
        .execute(&db.pool)
        .await?;
    Ok(())
}

async fn read_cache(db: &Db, key: &str, print: &str) -> AppResult<Option<CachedModels>> {
    let Some(raw) = get_setting(db, key).await? else {
        return Ok(None);
    };
    let Ok(cached) = serde_json::from_str::<CachedModels>(&raw) else {
        return Ok(None);
    };
    let fresh = chrono::Utc::now().timestamp_millis() - cached.fetched_at < CACHE_TTL_MS;
    Ok((fresh && cached.fingerprint == print).then_some(cached))
}

async fn write_cache(db: &Db, key: &str, cached: &CachedModels) -> AppResult<()> {
    let json = serde_json::to_string(cached)?;
    set_setting(db, key, &json).await
}

/// 按协议拉取。返回接口原始条目 + 一段给界面看的说明。
async fn fetch(profile: &LlmProfile, key: Option<&str>) -> AppResult<(Vec<Provided>, Option<String>)> {
    let http = client()?;
    let (mut models, note) = match profile.kind {
        ProviderKind::Openai => (fetch_openai(&http, profile, key).await?, None),
        ProviderKind::Anthropic => (fetch_anthropic(&http, profile, key).await?, None),
        ProviderKind::Gemini => (fetch_gemini(&http, profile, key).await?, None),
        ProviderKind::Ollama => (fetch_ollama(&http, profile).await?, None),
        ProviderKind::AzureOpenai => fetch_azure(&http, profile, key).await?,
    };
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    Ok((models, note))
}

fn path_override(profile: &LlmProfile) -> Option<String> {
    profile.models_path().map(str::to_string)
}

async fn get_json(
    request: reqwest::RequestBuilder,
    protocol: &str,
) -> AppResult<serde_json::Value> {
    let response = request
        .send()
        .await
        .map_err(|error| AppError::Other(format!("{protocol} 获取模型列表失败：{error}")))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(http_error(protocol, status, &body));
    }
    serde_json::from_str(&body)
        .map_err(|error| AppError::Other(format!("{protocol} 模型列表不是合法 JSON：{error}")))
}

async fn fetch_openai(
    http: &reqwest::Client,
    profile: &LlmProfile,
    key: Option<&str>,
) -> AppResult<Vec<Provided>> {
    let input = if profile.base_url.trim().is_empty() {
        "https://api.openai.com/v1"
    } else {
        profile.base_url.trim()
    };
    let base = crate::llm::openai::normalize_openai_base_url(input);
    let url = resolve_endpoint(&base, path_override(profile).as_deref(), || join(&base, "models"));
    let mut request = http.get(url);
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let value = get_json(request, "OpenAI 兼容").await?;
    Ok(parse_openai_models(&value))
}

async fn fetch_anthropic(
    http: &reqwest::Client,
    profile: &LlmProfile,
    key: Option<&str>,
) -> AppResult<Vec<Provided>> {
    let base = base(profile, "https://api.anthropic.com");
    let base = base.trim_end_matches("/messages").trim_end_matches('/').to_string();
    let base = if base.ends_with("/v1") { base } else { format!("{base}/v1") };
    let url = resolve_endpoint(&base, path_override(profile).as_deref(), || {
        format!("{base}/models?limit=1000")
    });
    let mut request = http.get(url).header("anthropic-version", "2023-06-01");
    if let Some(key) = key {
        request = request.header("x-api-key", key);
    }
    let value = get_json(request, "Anthropic").await?;
    Ok(parse_anthropic_models(&value))
}

async fn fetch_gemini(
    http: &reqwest::Client,
    profile: &LlmProfile,
    key: Option<&str>,
) -> AppResult<Vec<Provided>> {
    let base = base(profile, "https://generativelanguage.googleapis.com");
    let base = if base.ends_with("/v1beta") || base.ends_with("/v1") {
        base
    } else {
        format!("{base}/v1beta")
    };
    let url = resolve_endpoint(&base, path_override(profile).as_deref(), || {
        format!("{base}/models?pageSize=1000")
    });
    let mut request = http.get(url);
    if let Some(key) = key {
        request = request.header("x-goog-api-key", key);
    }
    let value = get_json(request, "Gemini").await?;
    Ok(parse_gemini_models(&value))
}

async fn fetch_ollama(http: &reqwest::Client, profile: &LlmProfile) -> AppResult<Vec<Provided>> {
    let base = base(profile, "http://127.0.0.1:11434");
    let url = resolve_endpoint(&base, path_override(profile).as_deref(), || join(&base, "api/tags"));
    let value = get_json(http.get(url), "Ollama").await?;
    Ok(parse_ollama_models(&value))
}

/// 本机默认地址上的 Ollama 在不在跑、装了哪些模型。没在跑（连不上、超时、不是 Ollama）返回 None。
///
/// 只探 127.0.0.1:11434 这一个默认地址、1.5 秒超时：这是打开设置页时顺手做的检测，
/// 不能让没装 Ollama 的人干等。手机上不探——Ollama 跑在电脑上，手机的本机地址上不会有它。
pub async fn detect_local_ollama() -> Option<Vec<String>> {
    if matches!(std::env::consts::OS, "ios" | "android") {
        return None;
    }
    detect_ollama_at(LOCAL_OLLAMA).await
}

async fn detect_ollama_at(base: &str) -> Option<Vec<String>> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .no_proxy()
        .build()
        .ok()?;
    let value = get_json(http.get(format!("{base}/api/tags")), "Ollama").await.ok()?;
    // 不是 Ollama 的服务碰巧占了这个端口：没有 models 数组就当没检测到。
    value.get("models")?.as_array()?;
    Some(parse_ollama_models(&value).into_iter().map(|model| model.id).collect())
}

pub const LOCAL_OLLAMA: &str = "http://127.0.0.1:11434";

async fn fetch_azure(
    http: &reqwest::Client,
    profile: &LlmProfile,
    key: Option<&str>,
) -> AppResult<(Vec<Provided>, Option<String>)> {
    let endpoint = base(profile, "");
    if endpoint.is_empty() {
        return Err(AppError::Config("Azure OpenAI 需要填资源端点，例如 https://xxx.openai.azure.com".into()));
    }
    let version = profile
        .api_version
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("2024-10-21");
    let url = resolve_endpoint(&endpoint, path_override(profile).as_deref(), || {
        format!("{endpoint}/openai/models?api-version={version}")
    });
    let mut request = http.get(url);
    if let Some(key) = key {
        request = request.header("api-key", key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| AppError::Other(format!("Azure OpenAI 获取模型列表失败：{error}")))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status.is_success() {
        let value: serde_json::Value = serde_json::from_str(&body)
            .map_err(|error| AppError::Other(format!("Azure OpenAI 模型列表不是合法 JSON：{error}")))?;
        return Ok((parse_openai_models(&value), None));
    }
    // 只有「这个接口/版本不存在」才退化成手填；401、网络错误必须原样报出去，
    // 否则用户会以为连接正常、只是 Azure 不给列表。
    if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::BAD_REQUEST {
        return Ok((
            vec![Provided {
                id: profile.deployment.clone().unwrap_or_else(|| profile.model.clone()),
                display_name: None,
                context: None,
                max_output: None,
                input: None,
                output: None,
                capabilities: None,
            }],
            Some("Azure 不提供 deployment 列表，下面显示的是当前部署名；部署名请按 Azure 门户里填。".into()),
        ));
    }
    Err(http_error("Azure OpenAI", status, &body))
}

fn u32_of(value: &serde_json::Value) -> Option<u32> {
    value
        .as_u64()
        .map(|v| v as u32)
        .or_else(|| value.as_f64().map(|v| v as u32))
}

fn price_per_million(value: &serde_json::Value) -> Option<f64> {
    let per_token = value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))?;
    Some((per_token * 1_000_000.0 * 10_000.0).round() / 10_000.0)
}

fn strings_of(value: &serde_json::Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// 通用 OpenAI 兼容 `/models`：多数端点只给 id；OpenRouter 这类会给上下文、价格和能力。
pub(crate) fn parse_openai_models(value: &serde_json::Value) -> Vec<Provided> {
    let items = value
        .get("data")
        .and_then(serde_json::Value::as_array)
        .or_else(|| value.as_array())
        .cloned()
        .unwrap_or_default();
    items
        .into_iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(serde_json::Value::as_str)?.trim();
            if id.is_empty() {
                return None;
            }
            let parameters = strings_of(&item["supported_parameters"]);
            let modalities = strings_of(&item["architecture"]["input_modalities"]);
            let has_capability_data = !parameters.is_empty() || !modalities.is_empty();
            Some(Provided {
                id: id.to_string(),
                display_name: item
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                context: u32_of(&item["context_length"]).or_else(|| u32_of(&item["context_window"])),
                max_output: u32_of(&item["max_output_tokens"]).or_else(|| u32_of(&item["top_provider"]["max_completion_tokens"])),
                input: price_per_million(&item["pricing"]["prompt"]),
                output: price_per_million(&item["pricing"]["completion"]),
                capabilities: has_capability_data.then(|| ModelCapabilities {
                    vision: modalities.iter().any(|m| m == "image"),
                    tools: parameters.iter().any(|p| p == "tools" || p == "tool_choice"),
                    json: parameters
                        .iter()
                        .any(|p| p == "response_format" || p == "structured_outputs"),
                    reasoning: parameters.iter().any(|p| p == "reasoning"),
                }),
            })
        })
        .collect()
}

pub(crate) fn parse_anthropic_models(value: &serde_json::Value) -> Vec<Provided> {
    value["data"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id").and_then(serde_json::Value::as_str)?.trim();
                    if id.is_empty() {
                        return None;
                    }
                    Some(Provided {
                        id: id.to_string(),
                        display_name: item
                            .get("display_name")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string),
                        context: None,
                        max_output: None,
                        input: None,
                        output: None,
                        capabilities: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn parse_gemini_models(value: &serde_json::Value) -> Vec<Provided> {
    value["models"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    let methods = strings_of(&item["supportedGenerationMethods"]);
                    methods.is_empty() || methods.iter().any(|m| m == "generateContent")
                })
                .filter_map(|item| {
                    let name = item.get("name").and_then(serde_json::Value::as_str)?;
                    let id = name.strip_prefix("models/").unwrap_or(name).trim();
                    if id.is_empty() {
                        return None;
                    }
                    Some(Provided {
                        id: id.to_string(),
                        display_name: item
                            .get("displayName")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string),
                        context: u32_of(&item["inputTokenLimit"]),
                        max_output: u32_of(&item["outputTokenLimit"]),
                        input: None,
                        output: None,
                        capabilities: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn parse_ollama_models(value: &serde_json::Value) -> Vec<Provided> {
    value["models"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = item
                        .get("name")
                        .or_else(|| item.get("model"))
                        .and_then(serde_json::Value::as_str)?
                        .trim();
                    if name.is_empty() {
                        return None;
                    }
                    Some(Provided {
                        id: name.to_string(),
                        display_name: None,
                        context: None,
                        max_output: None,
                        input: None,
                        output: None,
                        capabilities: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 把接口条目与内置目录合并：接口有的优先，缺的用目录补。
pub(crate) fn enrich(profile: &LlmProfile, provided: Provided) -> ModelInfo {
    let entry = catalog::lookup(&provided.id);
    let from_provider = provided.context.is_some()
        || provided.input.is_some()
        || provided.capabilities.is_some();
    let mut capabilities = provided.capabilities.unwrap_or_default();
    if provided.capabilities.is_none() {
        capabilities = ModelCapabilities {
            vision: entry.is_some_and(|e| e.vision),
            tools: entry.is_some_and(|e| e.tools),
            json: entry.is_some_and(|e| e.json),
            reasoning: entry.is_some_and(|e| e.reasoning),
        };
    }
    let models_in_catalog = entry.is_some();
    ModelInfo {
        id: provided.id,
        display_name: provided.display_name,
        context_window: provided.context.or(entry.and_then(|e| e.context)),
        max_output_tokens: provided
            .max_output
            .or(profile.max_output_tokens)
            .or(entry.and_then(|e| e.max_output)),
        input_price: provided.input.or(entry.and_then(|e| e.input)),
        output_price: provided.output.or(entry.and_then(|e| e.output)),
        capabilities,
        source: match (from_provider, models_in_catalog) {
            (true, true) => "provider+catalog",
            (true, false) => "provider",
            (false, true) => "catalog",
            (false, false) => "unknown",
        }
        .into(),
    }
}

fn enrich_all(profile: &LlmProfile, provided: Vec<Provided>) -> Vec<ModelInfo> {
    provided
        .into_iter()
        .map(|model| enrich(profile, model))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回一段固定 HTTP 响应的一次性本机服务，返回它的地址。
    async fn serve_once(status: &'static str, body: &'static str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0u8; 2048];
                let _ = socket.read(&mut buf).await;
                let reply = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn a_running_ollama_reports_its_installed_models() {
        let base = serve_once(
            "200 OK",
            r#"{"models":[{"name":"qwen2.5:7b"},{"name":"nomic-embed-text:latest"}]}"#,
        )
        .await;
        assert_eq!(
            detect_ollama_at(&base).await,
            Some(vec!["qwen2.5:7b".to_string(), "nomic-embed-text:latest".to_string()])
        );
    }

    #[tokio::test]
    async fn ollama_running_without_models_is_still_detected() {
        let base = serve_once("200 OK", r#"{"models":[]}"#).await;
        assert_eq!(detect_ollama_at(&base).await, Some(Vec::new()));
    }

    #[tokio::test]
    async fn something_else_on_the_port_or_nothing_at_all_is_not_ollama() {
        let base = serve_once("200 OK", r#"{"hello":"world"}"#).await;
        assert_eq!(detect_ollama_at(&base).await, None);
        let base = serve_once("404 Not Found", "").await;
        assert_eq!(detect_ollama_at(&base).await, None);
        // 端口上没人听：连不上就是没在跑。
        let free = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = free.local_addr().unwrap();
        drop(free);
        assert_eq!(detect_ollama_at(&format!("http://{addr}")).await, None);
    }

    #[test]
    fn openai_lists_parse_ids_and_rich_metadata() {
        let value = serde_json::json!({
            "data": [
                { "id": "gpt-4o" },
                {
                    "id": "openrouter/some-model",
                    "name": "Some Model",
                    "context_length": 200000,
                    "pricing": { "prompt": "0.000001", "completion": "0.000002" },
                    "supported_parameters": ["tools", "response_format"],
                    "architecture": { "input_modalities": ["text", "image"] }
                }
            ]
        });
        let models = parse_openai_models(&value);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gpt-4o");
        assert!(models[0].context.is_none());
        assert_eq!(models[1].context, Some(200_000));
        assert!((models[1].input.unwrap() - 1.0).abs() < 0.001);
        let caps = models[1].capabilities.unwrap();
        assert!(caps.tools && caps.vision && caps.json && !caps.reasoning);
    }

    #[test]
    fn anthropic_gemini_and_ollama_lists_parse() {
        let anthropic = serde_json::json!({
            "data": [{ "id": "claude-sonnet-4-6", "display_name": "Claude Sonnet 4.6" }]
        });
        assert_eq!(parse_anthropic_models(&anthropic)[0].id, "claude-sonnet-4-6");

        let gemini = serde_json::json!({
            "models": [
                { "name": "models/gemini-2.5-pro", "displayName": "Gemini 2.5 Pro",
                  "inputTokenLimit": 1048576, "outputTokenLimit": 65536,
                  "supportedGenerationMethods": ["generateContent", "countTokens"] },
                { "name": "models/text-embedding-004", "supportedGenerationMethods": ["embedContent"] }
            ]
        });
        let gemini_models = parse_gemini_models(&gemini);
        assert_eq!(gemini_models.len(), 1, "embedding 模型不该出现在对话模型列表里");
        assert_eq!(gemini_models[0].id, "gemini-2.5-pro");
        assert_eq!(gemini_models[0].context, Some(1_048_576));

        let ollama = serde_json::json!({ "models": [{ "name": "llama3.1:8b" }, { "model": "qwen3:8b" }] });
        assert_eq!(parse_ollama_models(&ollama).len(), 2);
    }

    #[test]
    fn catalog_fills_missing_metadata_and_flags_provider_metadata() {
        let profile = LlmProfile {
            kind: ProviderKind::Openai,
            base_url: "u".into(),
            ..Default::default()
        };
        let model = enrich(
            &profile,
            Provided {
                id: "gpt-4o".into(),
                display_name: None,
                context: None,
                max_output: None,
                input: None,
                output: None,
                capabilities: None,
            },
        );
        assert!(model.context_window.unwrap_or(0) >= 100_000);
        assert!(model.input_price.is_some());
        assert!(model.capabilities.tools);
        assert_eq!(model.source, "catalog");

        let unknown = enrich(
            &profile,
            Provided {
                id: "my-private-model".into(),
                display_name: None,
                context: Some(8192),
                max_output: None,
                input: None,
                output: None,
                capabilities: Some(ModelCapabilities::default()),
            },
        );
        assert_eq!(unknown.context_window, Some(8192));
        assert_eq!(unknown.input_price, None);
        assert_eq!(unknown.source, "provider");
    }

    #[test]
    fn models_path_accepts_relative_or_full_url() {
        assert_eq!(
            resolve_endpoint("https://api.example.com/v1", Some("models"), || "unused".into()),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            resolve_endpoint("https://api.example.com/v1", Some("https://gw.example.com/models"), || "unused".into()),
            "https://gw.example.com/models"
        );
        assert_eq!(
            resolve_endpoint("https://api.example.com/v1", None, || "https://api.example.com/v1/models".into()),
            "https://api.example.com/v1/models"
        );
    }

    #[test]
    fn cache_fingerprint_changes_when_endpoint_changes() {
        let mut profile = LlmProfile {
            kind: ProviderKind::Openai,
            base_url: "https://a".into(),
            ..Default::default()
        };
        let before = fingerprint(&profile);
        profile.base_url = "https://b".into();
        assert_ne!(before, fingerprint(&profile));
    }

    #[test]
    fn cache_fingerprint_changes_when_azure_deployment_changes() {
        let mut profile = LlmProfile {
            kind: ProviderKind::AzureOpenai,
            base_url: "https://x.openai.azure.com".into(),
            deployment: Some("a".into()),
            ..Default::default()
        };
        let before = fingerprint(&profile);
        profile.deployment = Some("b".into());
        assert_ne!(before, fingerprint(&profile));
    }

    fn openai_profile(id: &str, base_url: &str) -> LlmProfile {
        LlmProfile {
            id: id.into(),
            name: id.into(),
            kind: ProviderKind::Openai,
            base_url: base_url.into(),
            model: "m".into(),
            ..Default::default()
        }
    }

    #[test]
    fn listing_never_uses_a_saved_key_for_a_changed_draft_endpoint() {
        let saved = openai_profile("p", "https://api.example.com/v1");

        // 地址没变：用已保存的配置，请求仍然发往原地址。
        let mut draft = saved.clone();
        draft.model = "another-model".into();
        let resolved = resolve_for_listing(&draft, Some(&saved), false).unwrap();
        assert_eq!(resolved.base_url, "https://api.example.com/v1");
        assert_eq!(resolved.model, "m");

        // 地址变了、又没重新输 Key：拒绝，别把已存 Key 发到新地址。
        let mut changed = saved.clone();
        changed.base_url = "https://attacker.example/v1".into();
        let error = resolve_for_listing(&changed, Some(&saved), false).unwrap_err();
        assert!(error.to_string().contains("重新输入"));

        // 显式输入了 Key：允许用草稿（用户知道 Key 会发到哪）。
        let resolved = resolve_for_listing(&changed, Some(&saved), true).unwrap();
        assert_eq!(resolved.base_url, "https://attacker.example/v1");
    }

    #[test]
    fn listing_allows_a_draft_that_does_not_need_a_key() {
        let local = LlmProfile {
            key_required: Some(false),
            ..openai_profile("local", "http://127.0.0.1:1234/v1")
        };
        let resolved = resolve_for_listing(&local, None, false).unwrap();
        assert_eq!(resolved.base_url, "http://127.0.0.1:1234/v1");
    }
}
