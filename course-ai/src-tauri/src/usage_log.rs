//! LLM 用量统计，两份：
//!
//! - **进程内按档聚合**（`totals`）：每次调用花了多少 token、多少命中了前缀缓存、多少是
//!   计费却被丢掉的「思考」token。给开发控制台看，重启即清空。
//! - **逐次落库**（`llm_usage` 表）：带上调用时所在的视频 / 课程，按参考价估算花费。
//!   给设置里的「用量与花费」和每个视频的「这节课 AI 花了多少」用，也用来卡每月预算。
//!   调用发生在哪个视频 / 课程，靠 [`scoped`] 设的任务内范围（tokio task-local）传过来，
//!   不用把 id 塞进每一个请求。
//!
//! 只覆盖非流式调用（`Provider::complete`）。流式那条要拿到用量得额外声明
//! `stream_options.include_usage`，而那会改动请求体，对严格的兼容端点是个风险；
//! 而且真正费钱的批量活（五个产物、字幕纠错、提要）本来就都走非流式。

use crate::db::Db;
use crate::error::AppResult;
use crate::llm::Usage;
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Mutex, OnceLock};

/// 某一档（可能跨多个模型）的累计用量。
#[derive(Debug, Clone, Default, Serialize)]
pub struct UsageTotals {
    /// 调用属于哪一档：chapters / notes / correction / assistant …
    pub label: String,
    pub model: String,
    pub calls: i64,
    pub prompt_tokens: i64,
    /// 输入里命中前缀缓存的部分。它和 prompt_tokens 的比值就是这一档的缓存命中率。
    pub cached_tokens: i64,
    pub completion_tokens: i64,
    /// 计费在输出里、但我们只读正式回答、并不使用的思考 token。
    pub reasoning_tokens: i64,
}

type Key = (String, String);

fn store() -> &'static Mutex<HashMap<Key, UsageTotals>> {
    static STORE: OnceLock<Mutex<HashMap<Key, UsageTotals>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 这次调用算在哪：处理某个视频时是 video_id，课程级任务是 course_id，都没有就是「其他」。
#[derive(Debug, Clone, Default)]
pub struct UsageScope {
    pub video_id: Option<String>,
    pub course_id: Option<String>,
}

impl UsageScope {
    pub fn video(video_id: &str) -> Self {
        Self { video_id: Some(video_id.to_string()), course_id: None }
    }
    pub fn course(course_id: &str) -> Self {
        Self { video_id: None, course_id: Some(course_id.to_string()) }
    }
}

tokio::task_local! {
    static SCOPE: UsageScope;
}

/// 在这个范围里跑 `fut`：里面（同一个任务内）发生的大模型调用都记到这个视频 / 课程上。
/// 注意 `spawn` 出去的子任务不继承，要在子任务里再包一层。
pub async fn scoped<F: Future>(scope: UsageScope, fut: F) -> F::Output {
    SCOPE.scope(scope, fut).await
}

fn current_scope() -> UsageScope {
    SCOPE.try_with(Clone::clone).unwrap_or_default()
}

/// 启动时交进来的数据库：`record` 是同步调用，拿不到 State，落库靠它。
static DB: OnceLock<Db> = OnceLock::new();

pub fn attach_db(db: Db) {
    let _ = DB.set(db);
}

/// 这次调用按哪种方式计价。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Billing {
    /// 本机模型（Ollama），不花钱。
    Local,
    /// 直连 DeepSeek 官方（api.deepseek.com）：按官方价表、分高峰 / 空闲时段算。
    DeepSeek,
    /// 其余：按模型目录里的参考价。
    Catalog,
}

/// DeepSeek 官方**高峰**价（USD / 百万 token）：(未命中缓存的输入, 命中缓存的输入, 输出)。
/// 空闲时段一律半价。来源 https://api-docs.deepseek.com/quick_start/pricing（2026-11 核对）。
/// 老名字（deepseek-v4-flash 等）已由 Flash 提供服务、按 Flash 计费，所以不是 Pro 就按 Flash。
fn deepseek_peak_price(model: &str) -> (f64, f64, f64) {
    if model.to_ascii_lowercase().contains("-pro") {
        (1.32, 0.044, 3.96)
    } else {
        (0.3, 0.006, 1.2)
    }
}

/// DeepSeek 的高峰时段：北京时间周一至周五 9:00–12:00、14:00–18:00，即 UTC 01–04、06–10 点。
/// 都落在同一个 UTC 日里，按 UTC 判星期就和北京时间一致，不用时区库。
/// 法定节假日官方也按空闲价，但我们不知道哪天放假——那几天按高峰算，宁可估高。
pub fn deepseek_is_peak(at: chrono::DateTime<chrono::Utc>) -> bool {
    use chrono::{Datelike, Timelike};
    if at.weekday().number_from_monday() > 5 {
        return false;
    }
    matches!(at.hour(), 1..=3 | 6..=9)
}

fn priced(fresh: i64, cached: i64, completion: i64, (input, cache, output): (f64, f64, f64)) -> f64 {
    (fresh as f64 * input + cached as f64 * cache + completion as f64 * output) / 1_000_000.0
}

/// 估算一次调用的花费（USD）。命中缓存的输入按缓存价（目录里没有就按普通输入价），
/// 输出里包含思考 token（各家都按输出计费）。查不到价格返回 None——「不知道」不是「免费」。
pub fn estimate_cost_usd(
    model: &str,
    usage: &Usage,
    billing: Billing,
    at: chrono::DateTime<chrono::Utc>,
) -> Option<f64> {
    let cached = usage.cached_tokens.clamp(0, usage.prompt_tokens.max(0));
    let fresh = usage.prompt_tokens.max(0) - cached;
    let completion = usage.completion_tokens.max(0);
    match billing {
        Billing::Local => Some(0.0),
        Billing::DeepSeek => {
            let (input, cache, output) = deepseek_peak_price(model);
            let factor = if deepseek_is_peak(at) { 1.0 } else { 0.5 };
            Some(priced(fresh, cached, completion, (input * factor, cache * factor, output * factor)))
        }
        Billing::Catalog => {
            let entry = crate::llm::catalog::lookup(model)?;
            let (input, output) = (entry.input?, entry.output?);
            Some(priced(fresh, cached, completion, (input, entry.cache_read.unwrap_or(input), output)))
        }
    }
}

/// 记一次调用。端点没报用量时不要调用它——那样会把「没报」记成「零消耗」，
/// 命中率算出来是假的。
pub fn record(label: &str, model: &str, usage: &Usage, billing: Billing) {
    persist(label, model, usage, billing);
    aggregate(label, model, usage);
}

fn persist(label: &str, model: &str, usage: &Usage, billing: Billing) {
    let Some(db) = DB.get().cloned() else { return };
    let scope = current_scope();
    let now = chrono::Utc::now();
    let cost = estimate_cost_usd(model, usage, billing, now);
    let (label, model, usage) = (label.to_string(), model.to_string(), *usage);
    // 写库不挡调用方：调用方正等着拿模型的回答往下走。写失败只记日志，用量少一行不影响功能。
    tauri::async_runtime::spawn(async move {
        let at = now.timestamp_millis();
        if let Err(error) = insert(&db, at, &scope, &label, &model, &usage, cost).await {
            tracing::warn!(%error, "记录大模型用量失败");
        }
    });
}

pub async fn insert(
    db: &Db,
    at: i64,
    scope: &UsageScope,
    label: &str,
    model: &str,
    usage: &Usage,
    cost_usd: Option<f64>,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO llm_usage(at,video_id,course_id,label,model,prompt_tokens,cached_tokens,
           completion_tokens,reasoning_tokens,cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(at)
    .bind(&scope.video_id)
    .bind(&scope.course_id)
    .bind(label)
    .bind(model)
    .bind(usage.prompt_tokens)
    .bind(usage.cached_tokens)
    .bind(usage.completion_tokens)
    .bind(usage.reasoning_tokens)
    .bind(cost_usd)
    .execute(&db.pool)
    .await?;
    Ok(())
}

fn aggregate(label: &str, model: &str, usage: &Usage) {
    let mut guard = store().lock().unwrap_or_else(|e| e.into_inner());
    let entry = guard
        .entry((label.to_string(), model.to_string()))
        .or_insert_with(|| UsageTotals {
            label: label.to_string(),
            model: model.to_string(),
            ..Default::default()
        });
    entry.calls += 1;
    entry.prompt_tokens += usage.prompt_tokens;
    entry.cached_tokens += usage.cached_tokens;
    entry.completion_tokens += usage.completion_tokens;
    entry.reasoning_tokens += usage.reasoning_tokens;
}

/// 各档累计用量，输入 token 多的排前面（花钱多的先看见）。
pub fn totals() -> Vec<UsageTotals> {
    let mut out: Vec<UsageTotals> = store()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .cloned()
        .collect();
    out.sort_by(|a, b| {
        b.prompt_tokens
            .cmp(&a.prompt_tokens)
            .then(a.label.cmp(&b.label))
    });
    out
}

pub fn clear() {
    store().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

#[tauri::command]
pub async fn cmd_llm_usage() -> crate::error::AppResult<Vec<UsageTotals>> {
    Ok(totals())
}

#[tauri::command]
pub async fn cmd_clear_llm_usage() -> crate::error::AppResult<()> {
    clear();
    Ok(())
}

// ---------------------------------------------------------------- 落库的用量：查询与预算

/// 每月预算（USD），设置项；空或 0 = 不设。
pub const BUDGET_SETTING: &str = "ai_monthly_budget_usd";

#[derive(Debug, Clone, Default, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    /// 分组键：档位 / 模型 / 课程 id（课程那组另带名字）。
    pub key: String,
    pub name: Option<String>,
    pub calls: i64,
    pub prompt_tokens: i64,
    pub cached_tokens: i64,
    pub completion_tokens: i64,
    /// 能估出价格的那部分调用的花费合计。
    pub cost_usd: f64,
    /// 查不到价格、没算进花费的调用次数。
    pub unpriced_calls: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub since_ms: i64,
    pub total: UsageRow,
    pub by_label: Vec<UsageRow>,
    pub by_model: Vec<UsageRow>,
    pub by_course: Vec<UsageRow>,
    /// 本自然月（本地时区）到现在的花费。
    pub month_cost_usd: f64,
    pub budget_usd: Option<f64>,
}

const SUMS: &str = "COUNT(*) AS calls, COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
    COALESCE(SUM(cached_tokens),0) AS cached_tokens, COALESCE(SUM(completion_tokens),0) AS completion_tokens,
    COALESCE(SUM(cost_usd),0.0) AS cost_usd, COALESCE(SUM(cost_usd IS NULL),0) AS unpriced_calls";

/// 本地时区的本月 1 日 0 点（毫秒）。
pub fn month_start_ms(now: chrono::DateTime<chrono::Local>) -> i64 {
    use chrono::{Datelike, TimeZone};
    chrono::Local
        .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
        .earliest()
        .map(|t| t.timestamp_millis())
        .unwrap_or(0)
}

pub async fn month_cost_usd(db: &Db) -> AppResult<f64> {
    let since = month_start_ms(chrono::Local::now());
    Ok(sqlx::query_scalar("SELECT COALESCE(SUM(cost_usd),0.0) FROM llm_usage WHERE at>=?")
        .bind(since)
        .fetch_one(&db.pool)
        .await?)
}

pub async fn budget_usd(db: &Db) -> Option<f64> {
    crate::commands::settings::get_setting(db, BUDGET_SETTING)
        .await
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
}

/// 本月花费到了预算就返回说明（给流水线跳过自动 AI 步骤用）；没设预算或没超返回 None。
/// 只管自动跑的步骤：用户自己点「生成」「提问」时照常执行。
pub async fn over_budget_message(db: &Db) -> Option<String> {
    let budget = budget_usd(db).await?;
    let spent = month_cost_usd(db).await.ok()?;
    (spent >= budget).then(|| {
        format!(
            "已跳过：本月 AI 花费约 ${spent:.2}，已到预算 ${budget:.2}。可在 设置 → 大模型 调高预算，或在各面板里手动生成。"
        )
    })
}

async fn grouped(db: &Db, since: i64, select_key: &str, join: &str, group: &str) -> AppResult<Vec<UsageRow>> {
    let sql = format!(
        "SELECT {select_key}, {SUMS} FROM llm_usage u {join} WHERE u.at>=? GROUP BY {group}
         ORDER BY cost_usd DESC, prompt_tokens DESC"
    );
    Ok(sqlx::query_as(&sql).bind(since).fetch_all(&db.pool).await?)
}

pub async fn summary(db: &Db, days: i64) -> AppResult<UsageSummary> {
    let now = chrono::Utc::now().timestamp_millis();
    let since = now - days.clamp(1, 3650) * 86_400_000;
    let total: UsageRow = sqlx::query_as(&format!(
        "SELECT '' AS key, NULL AS name, {SUMS} FROM llm_usage u WHERE u.at>=?"
    ))
    .bind(since)
    .fetch_one(&db.pool)
    .await?;
    let by_label = grouped(db, since, "u.label AS key, NULL AS name", "", "u.label").await?;
    let by_model = grouped(db, since, "u.model AS key, NULL AS name", "", "u.model").await?;
    // 视频的课程现查：视频可能被移到别的课程。删掉的课程 / 视频归到「其他」。
    let by_course = grouped(
        db,
        since,
        "COALESCE(c.id,'') AS key, c.name AS name",
        "LEFT JOIN videos v ON v.id=u.video_id
         LEFT JOIN courses c ON c.id=COALESCE(v.course_id,u.course_id)",
        "COALESCE(c.id,'')",
    )
    .await?;
    Ok(UsageSummary {
        since_ms: since,
        total,
        by_label,
        by_model,
        by_course,
        month_cost_usd: month_cost_usd(db).await?,
        budget_usd: budget_usd(db).await,
    })
}

pub async fn video_usage(db: &Db, video_id: &str) -> AppResult<UsageRow> {
    Ok(sqlx::query_as(&format!(
        "SELECT '' AS key, NULL AS name, {SUMS} FROM llm_usage u WHERE u.video_id=?"
    ))
    .bind(video_id)
    .fetch_one(&db.pool)
    .await?)
}

/// 只留一年：一节课几十次调用，几年下来也就几万行，但没必要无限长。
pub async fn prune(db: &Db) -> AppResult<()> {
    let cutoff = chrono::Utc::now().timestamp_millis() - 365 * 86_400_000;
    sqlx::query("DELETE FROM llm_usage WHERE at<?").bind(cutoff).execute(&db.pool).await?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_ai_usage_summary(
    state: tauri::State<'_, crate::commands::courses::AppState>,
    days: Option<i64>,
) -> AppResult<UsageSummary> {
    summary(&state.db, days.unwrap_or(30)).await
}

#[tauri::command]
pub async fn cmd_video_ai_usage(
    state: tauri::State<'_, crate::commands::courses::AppState>,
    video_id: String,
) -> AppResult<UsageRow> {
    video_usage(&state.db, &video_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(prompt: i64, cached: i64, completion: i64, reasoning: i64) -> Usage {
        Usage {
            prompt_tokens: prompt,
            cached_tokens: cached,
            completion_tokens: completion,
            reasoning_tokens: reasoning,
        }
    }

    /// 这几条测试都读写同一个进程级的聚合表，并行跑会互相 clear 掉对方的数据。
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn totals_accumulate_per_label_and_model() {
        let _serial = serial();
        clear();
        record("notes", "deepseek-chat", &usage(1000, 0, 300, 0), Billing::Catalog);
        record("notes", "deepseek-chat", &usage(1000, 900, 280, 0), Billing::Catalog);
        record("quiz", "deepseek-chat", &usage(1000, 900, 400, 0), Billing::Catalog);

        let totals = totals();
        let notes = totals.iter().find(|t| t.label == "notes").unwrap();
        assert_eq!(notes.calls, 2);
        assert_eq!(notes.prompt_tokens, 2000);
        // 第一次没命中、第二次命中——这正是「共享前缀有没有生效」看得见的样子。
        assert_eq!(notes.cached_tokens, 900);
        assert_eq!(notes.completion_tokens, 580);
        assert_eq!(totals.iter().find(|t| t.label == "quiz").unwrap().calls, 1);
        clear();
    }

    #[test]
    fn the_same_label_on_a_different_model_is_counted_separately() {
        // 换了模型缓存就不共享了，混在一起算命中率会把问题盖掉。
        let _serial = serial();
        clear();
        record("notes", "model-a", &usage(100, 0, 10, 0), Billing::Catalog);
        record("notes", "model-b", &usage(100, 0, 10, 0), Billing::Catalog);

        assert_eq!(totals().len(), 2);
        clear();
    }

    #[test]
    fn reasoning_tokens_are_tracked_separately_from_the_answer() {
        // 推理模型的思考过程按输出计费，而我们只读正式回答、把它整个丢掉。
        // 不单独记的话，这笔钱在账面上和有用的输出长得一模一样。
        let _serial = serial();
        clear();
        record("correction", "reasoner", &usage(500, 0, 900, 800), Billing::Catalog);

        let totals = totals();
        assert_eq!(totals[0].completion_tokens, 900);
        assert_eq!(totals[0].reasoning_tokens, 800);
        clear();
    }

    fn utc(s: &str) -> chrono::DateTime<chrono::Utc> {
        s.parse().unwrap()
    }

    #[test]
    fn cost_counts_cache_hits_at_the_cache_price() {
        // deepseek-flash 的目录价：输入 0.3、缓存 0.006、输出 1.2（USD / 百万 token）。
        let at = utc("2026-11-17T02:00:00Z");
        let cost = estimate_cost_usd("deepseek-flash", &usage(1_000_000, 900_000, 100_000, 0), Billing::Catalog, at)
            .unwrap();
        let expected = (100_000.0 * 0.3 + 900_000.0 * 0.006 + 100_000.0 * 1.2) / 1_000_000.0;
        assert!((cost - expected).abs() < 1e-9, "{cost} vs {expected}");
        // 没有缓存价的模型按普通输入价算（宁可估高）；查不到价格的是「未知」，不是 0。
        assert!(estimate_cost_usd("no-such-model-xyz", &usage(10, 0, 10, 0), Billing::Catalog, at).is_none());
        // 本机模型不花钱，哪怕目录里有同名模型的价。
        assert_eq!(estimate_cost_usd("deepseek-flash", &usage(10, 0, 10, 0), Billing::Local, at), Some(0.0));
    }

    #[test]
    fn deepseek_peak_hours_follow_beijing_weekdays() {
        // 2026-11-17 是周二。北京 9:00 = UTC 01:00。
        assert!(!deepseek_is_peak(utc("2026-11-17T00:59:00Z")), "北京 8:59 还是空闲");
        assert!(deepseek_is_peak(utc("2026-11-17T01:00:00Z")), "北京 9:00 进高峰");
        assert!(deepseek_is_peak(utc("2026-11-17T03:59:00Z")), "北京 11:59");
        assert!(!deepseek_is_peak(utc("2026-11-17T04:00:00Z")), "北京 12:00 午间空闲");
        assert!(deepseek_is_peak(utc("2026-11-17T06:00:00Z")), "北京 14:00");
        assert!(!deepseek_is_peak(utc("2026-11-17T10:00:00Z")), "北京 18:00 收工");
        assert!(!deepseek_is_peak(utc("2026-11-21T02:00:00Z")), "周六北京 10:00 也是空闲");
        // 北京周一凌晨 = UTC 周日傍晚，空闲。
        assert!(!deepseek_is_peak(utc("2026-11-22T17:00:00Z")));
    }

    #[test]
    fn deepseek_official_is_half_price_off_peak_and_pro_has_its_own_table() {
        let u = usage(1_000_000, 0, 1_000_000, 0);
        let peak = utc("2026-11-17T02:00:00Z");
        let idle = utc("2026-11-17T12:00:00Z");
        let flash_peak = estimate_cost_usd("deepseek-flash", &u, Billing::DeepSeek, peak).unwrap();
        assert!((flash_peak - 1.5).abs() < 1e-9, "{flash_peak}");
        let flash_idle = estimate_cost_usd("deepseek-flash", &u, Billing::DeepSeek, idle).unwrap();
        assert!((flash_idle - 0.75).abs() < 1e-9, "{flash_idle}");
        // 老名字按 Flash 计费。
        let legacy = estimate_cost_usd("deepseek-v4-flash", &u, Billing::DeepSeek, idle).unwrap();
        assert!((legacy - flash_idle).abs() < 1e-9);
        let pro_peak = estimate_cost_usd("deepseek-v4-pro", &u, Billing::DeepSeek, peak).unwrap();
        assert!((pro_peak - (1.32 + 3.96)).abs() < 1e-9, "{pro_peak}");
        // 缓存价也减半。
        let cached = estimate_cost_usd("deepseek-flash", &usage(1_000_000, 1_000_000, 0, 0), Billing::DeepSeek, idle)
            .unwrap();
        assert!((cached - 0.003).abs() < 1e-9, "{cached}");
    }

    #[tokio::test]
    async fn scope_is_visible_inside_and_gone_outside() {
        let inside = scoped(UsageScope::video("v1"), async { current_scope() }).await;
        assert_eq!(inside.video_id.as_deref(), Some("v1"));
        assert!(current_scope().video_id.is_none());
    }

    #[tokio::test]
    async fn summary_groups_by_course_through_the_video_and_budget_trips_at_the_limit() {
        use crate::commands::courses::create_course;
        use crate::commands::videos::add_local_video;
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db")).await.unwrap();
        let course = create_course(&db, "机器学习".into(), dir.path().to_string_lossy().into()).await.unwrap();
        let path = dir.path().join("v.mp4");
        std::fs::write(&path, b"x").unwrap();
        let video = add_local_video(&db, &course.id, path, None).await.unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let u = usage(1000, 0, 100, 0);
        insert(&db, now, &UsageScope::video(&video.id), "notes", "m", &u, Some(0.30)).await.unwrap();
        insert(&db, now, &UsageScope::video(&video.id), "quiz", "m", &u, Some(0.20)).await.unwrap();
        insert(&db, now, &UsageScope::default(), "assistant", "m", &u, None).await.unwrap();
        // 一年多以前的不算进「最近 30 天」。
        insert(&db, now - 400 * 86_400_000, &UsageScope::video(&video.id), "notes", "m", &u, Some(9.0)).await.unwrap();

        let s = summary(&db, 30).await.unwrap();
        assert_eq!(s.total.calls, 3);
        assert!((s.total.cost_usd - 0.5).abs() < 1e-9);
        assert_eq!(s.total.unpriced_calls, 1);
        let ml = s.by_course.iter().find(|r| r.key == course.id).unwrap();
        assert_eq!(ml.name.as_deref(), Some("机器学习"));
        assert_eq!(ml.calls, 2);
        assert!(s.by_course.iter().any(|r| r.key.is_empty() && r.calls == 1), "不属于课程的归到「其他」");
        assert_eq!(video_usage(&db, &video.id).await.unwrap().calls, 3);

        assert!(over_budget_message(&db).await.is_none(), "没设预算不拦");
        crate::commands::settings::set_setting(&db, BUDGET_SETTING, "1").await.unwrap();
        assert!(over_budget_message(&db).await.is_none(), "本月 $0.50 < $1");
        crate::commands::settings::set_setting(&db, BUDGET_SETTING, "0.5").await.unwrap();
        assert!(over_budget_message(&db).await.unwrap().contains("$0.50"));

        prune(&db).await.unwrap();
        assert_eq!(video_usage(&db, &video.id).await.unwrap().calls, 2, "一年前的清掉了");
    }
}
