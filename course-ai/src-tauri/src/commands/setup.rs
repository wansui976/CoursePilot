//! 首次使用向导用的估算：处理一小时课程大概要花多少 token、多少钱。
//!
//! 有自己的用量记录（至少两讲、合计半小时以上）就按自己的算：只统计处理一讲时自动跑的
//! 那几步（纠错、提要、章节、摘要、笔记、出题、脑图、知识点……），不算问答、助手、
//! 费曼这些按次用的。没有记录时用一组粗估（一小时中文课的讲稿约 1.2 万 token，
//! 纠错要原样写回一遍，其余几步各读一遍讲稿）。
//!
//! 价格和「用量与花费」同一套：DeepSeek 官方按高峰价（宁可估高），本机 Ollama 记 0，
//! 其余查模型目录；查不到价格给 None，前端写「查不到价格」，不当成免费。

use crate::commands::courses::AppState;
use crate::db::Db;
use crate::error::AppResult;
use crate::llm::profiles::ProviderKind;
use crate::usage_log::{estimate_cost_usd, Billing};
use serde::{Deserialize, Serialize};
use tauri::State;

/// 按次用、不属于「处理一讲」的那些调用。
const INTERACTIVE_LABELS: &[&str] = &[
    "assistant",
    "ask",
    "course_chat",
    "course_cover",
    "course_outline",
    "concept_explain",
    "concept_canonical",
    "feynman",
    "handout",
    "history_digest",
    "note_snippet",
    "query_expansion",
    "quiz_grade",
    "review_chapter",
    "review_outline",
    "test",
    "translate",
];

/// 没有记录时的粗估：一小时课。
const DEFAULT_PROMPT_PER_HOUR: i64 = 90_000;
const DEFAULT_COMPLETION_PER_HOUR: i64 = 28_000;

/// 至少这么多讲、这么长的记录才按自己的用量算，免得一两次重试把估算带偏。
const MIN_HISTORY_VIDEOS: i64 = 2;
const MIN_HISTORY_MS: i64 = 30 * 60_000;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LectureTokens {
    pub prompt_tokens: i64,
    pub cached_tokens: i64,
    pub completion_tokens: i64,
    /// true：按自己的用量记录算的；false：粗估。
    pub from_history: bool,
    /// 记录里有几讲（粗估时为 0）。
    pub videos: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EstimateModel {
    pub kind: ProviderKind,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LectureEstimate {
    /// 一小时课的 token。
    pub tokens: LectureTokens,
    /// 与请求里的模型一一对应：一小时课的花费（美元），查不到价格为 None。
    pub cost_per_hour_usd: Vec<Option<f64>>,
}

/// 一小时课要多少 token：有足够记录按记录，否则粗估。
pub async fn tokens_per_hour(db: &Db) -> AppResult<LectureTokens> {
    let placeholders = INTERACTIVE_LABELS
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT COUNT(*), COALESCE(SUM(duration_ms),0), COALESCE(SUM(p),0), COALESCE(SUM(c),0),
                COALESCE(SUM(o),0)
         FROM (
           SELECT v.duration_ms AS duration_ms, SUM(u.prompt_tokens) AS p,
                  SUM(u.cached_tokens) AS c, SUM(u.completion_tokens) AS o
           FROM llm_usage u JOIN videos v ON v.id = u.video_id
           WHERE u.label NOT IN ({placeholders}) AND v.duration_ms > 60000
           GROUP BY u.video_id
         )"
    );
    let mut query = sqlx::query_as::<_, (i64, i64, i64, i64, i64)>(&sql);
    for label in INTERACTIVE_LABELS {
        query = query.bind(*label);
    }
    let (videos, duration_ms, prompt, cached, completion) = query.fetch_one(&db.pool).await?;
    if videos < MIN_HISTORY_VIDEOS || duration_ms < MIN_HISTORY_MS {
        return Ok(LectureTokens {
            prompt_tokens: DEFAULT_PROMPT_PER_HOUR,
            cached_tokens: 0,
            completion_tokens: DEFAULT_COMPLETION_PER_HOUR,
            from_history: false,
            videos: 0,
        });
    }
    let per_hour = |tokens: i64| (tokens as f64 * 3_600_000.0 / duration_ms as f64).round() as i64;
    Ok(LectureTokens {
        prompt_tokens: per_hour(prompt),
        cached_tokens: per_hour(cached),
        completion_tokens: per_hour(completion),
        from_history: true,
        videos,
    })
}

fn billing_for(model: &EstimateModel) -> Billing {
    if model.kind == ProviderKind::Ollama {
        Billing::Local
    } else if crate::llm::is_deepseek_official(&model.base_url) {
        Billing::DeepSeek
    } else {
        Billing::Catalog
    }
}

/// DeepSeek 按高峰价估：取一个工作日上午的高峰时刻。
fn peak_time() -> chrono::DateTime<chrono::Utc> {
    use chrono::TimeZone as _;
    chrono::Utc
        .with_ymd_and_hms(2026, 11, 25, 2, 0, 0)
        .single()
        .unwrap_or_else(chrono::Utc::now)
}

pub fn cost_per_hour(model: &EstimateModel, tokens: &LectureTokens) -> Option<f64> {
    let usage = crate::llm::Usage {
        prompt_tokens: tokens.prompt_tokens,
        cached_tokens: tokens.cached_tokens,
        completion_tokens: tokens.completion_tokens,
        ..Default::default()
    };
    estimate_cost_usd(model.model.trim(), &usage, billing_for(model), peak_time())
}

#[tauri::command]
pub async fn cmd_setup_lecture_estimate(
    state: State<'_, AppState>,
    models: Vec<EstimateModel>,
) -> AppResult<LectureEstimate> {
    let tokens = tokens_per_hour(&state.db).await?;
    let cost_per_hour_usd = models.iter().map(|m| cost_per_hour(m, &tokens)).collect();
    Ok(LectureEstimate {
        tokens,
        cost_per_hour_usd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;

    fn model(kind: ProviderKind, base_url: &str, model: &str) -> EstimateModel {
        EstimateModel {
            kind,
            base_url: base_url.into(),
            model: model.into(),
        }
    }

    fn rough() -> LectureTokens {
        LectureTokens {
            prompt_tokens: DEFAULT_PROMPT_PER_HOUR,
            cached_tokens: 0,
            completion_tokens: DEFAULT_COMPLETION_PER_HOUR,
            from_history: false,
            videos: 0,
        }
    }

    #[test]
    fn prices_follow_the_usage_page() {
        let tokens = rough();
        // Ollama 在本机跑，不花钱。
        assert_eq!(
            cost_per_hour(
                &model(
                    ProviderKind::Ollama,
                    "http://127.0.0.1:11434",
                    "llama3.1:8b"
                ),
                &tokens
            ),
            Some(0.0)
        );
        // DeepSeek 官方按高峰价：9 万输入 × 0.3 + 2.8 万输出 × 1.2（美元 / 百万）。
        let deepseek = cost_per_hour(
            &model(
                ProviderKind::Openai,
                "https://api.deepseek.com",
                "deepseek-flash",
            ),
            &tokens,
        )
        .unwrap();
        assert!(
            (deepseek - (0.09 * 0.3 + 0.028 * 1.2)).abs() < 1e-9,
            "{deepseek}"
        );
        // 目录里查得到的模型有价格，查不到的给 None。
        assert!(cost_per_hour(
            &model(ProviderKind::Openai, "https://api.openai.com/v1", "gpt-4o"),
            &tokens
        )
        .is_some_and(|usd| usd > 0.0));
        assert_eq!(
            cost_per_hour(
                &model(
                    ProviderKind::Openai,
                    "https://example.com/v1",
                    "no-such-model-xyz"
                ),
                &tokens
            ),
            None
        );
    }

    async fn insert_video(db: &Db, course_id: &str, duration_ms: i64) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at,duration_ms)
             VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(&id)
        .bind(course_id)
        .bind("v")
        .bind("local")
        .bind("/tmp/v.mp4")
        .bind("/tmp/d")
        .bind(0i64)
        .bind(duration_ms)
        .execute(&db.pool)
        .await
        .unwrap();
        id
    }

    async fn usage(db: &Db, video_id: &str, label: &str, prompt: i64, completion: i64) {
        sqlx::query(
            "INSERT INTO llm_usage(at,video_id,label,model,prompt_tokens,cached_tokens,
               completion_tokens,reasoning_tokens) VALUES (0,?,?,'m',?,0,?,0)",
        )
        .bind(video_id)
        .bind(label)
        .bind(prompt)
        .bind(completion)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn uses_own_history_once_there_is_enough() {
        let db = Db::connect_and_migrate(&crate::db::test_db_path("setup"))
            .await
            .unwrap();
        assert_eq!(
            tokens_per_hour(&db).await.unwrap(),
            rough(),
            "没有记录用粗估"
        );

        let dir = std::env::temp_dir();
        let course = create_course(&db, "c".into(), dir.to_string_lossy().into())
            .await
            .unwrap();
        let a = insert_video(&db, &course.id, 30 * 60_000).await;
        usage(&db, &a, "correction", 20_000, 10_000).await;
        // 问答不算进「处理一讲」。
        usage(&db, &a, "assistant", 500_000, 500_000).await;
        assert!(
            !tokens_per_hour(&db).await.unwrap().from_history,
            "一讲不够"
        );

        let b = insert_video(&db, &course.id, 90 * 60_000).await;
        usage(&db, &b, "other", 60_000, 10_000).await;
        let tokens = tokens_per_hour(&db).await.unwrap();
        assert!(tokens.from_history);
        assert_eq!(tokens.videos, 2);
        // 两讲合计 2 小时：8 万输入、2 万输出 → 每小时 4 万 / 1 万。
        assert_eq!(tokens.prompt_tokens, 40_000);
        assert_eq!(tokens.completion_tokens, 10_000);
    }
}
