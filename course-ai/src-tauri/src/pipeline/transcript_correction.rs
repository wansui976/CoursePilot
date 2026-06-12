use crate::commands::transcripts::list_segments;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::Provider;
use futures_util::stream::StreamExt;
use serde::{Deserialize, Serialize};

// 一批的段数。模型只返回需要修改的 patch（按 id 引用）。批越大越容易输出截断、
// id 越界/串位，故取 20 段：上下文够用，又把单批漂移与截断概率压低。
// OpenAI 已不发 max_tokens（无上限）；Anthropic 仍使用请求里的 max_tokens。
const CORRECTION_BATCH_SIZE: usize = 20;
// 默认并发批数；可被设置 asr_correction_concurrency 覆盖。批之间相互独立，
// 并发跑可大幅缩短长视频的纠错耗时。DeepSeek 等高并发模型可调到很大
// （flash 2500 / pro 500）；普通端点保守些以免触发限流。
const DEFAULT_CORRECTION_CONCURRENCY: usize = 8;

/// 读取 AI 纠错并发数设置，限制在 1..=2500（实际有效值还受批数量上限约束）。
async fn correction_concurrency(db: &Db) -> usize {
    crate::commands::settings::get_setting(db, "asr_correction_concurrency")
        .await
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .map(|n| n.clamp(1, 2500))
        .unwrap_or(DEFAULT_CORRECTION_CONCURRENCY)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CorrectionSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

// 发给模型的请求项：只给 id + 文本。模型据 id 引用分段，无需回抄时间戳/原文，
// 从根上消除「时间戳串位 / 原文抄错 / 字段名抄错」这三类批量失败。
#[derive(Debug, Clone, Serialize)]
struct CorrectionRequestItem<'a> {
    id: usize,
    text: &'a str,
}

fn build_batch_request_json(batch: &[CorrectionSegment]) -> AppResult<String> {
    let items: Vec<CorrectionRequestItem> = batch
        .iter()
        .enumerate()
        .map(|(id, seg)| CorrectionRequestItem {
            id,
            text: &seg.text,
        })
        .collect();
    Ok(serde_json::to_string_pretty(&items)?)
}

// 模型回的 patch：只认 id 与 replacedtext。其余字段（哪怕模型多回了原文/时间戳）
// 一律忽略。replacedtext 缺失则该条反序列化失败 → 单条跳过，不会误把整段清空。
#[derive(Debug, Clone, Deserialize)]
struct CorrectionPatch {
    id: usize,
    replacedtext: String,
}

fn load_correction_segments(
    rows: &[crate::commands::transcripts::TranscriptSegment],
) -> Vec<CorrectionSegment> {
    rows.iter()
        .map(|row| CorrectionSegment {
            start_ms: row.start_ms,
            end_ms: row.end_ms,
            text: row.text.clone(),
        })
        .collect()
}

/// 解析模型返回的 patch 列表。按批内 id 定位分段，单条异常（id 越界/重复/字段缺失）
/// 一律跳过而不拖垮整批；只有当整体连合法 JSON 数组都解析不出（多为输出截断）时才报错。
/// 模型只返回需要修改的条目；未返回或被跳过的分段保持原文。
pub fn parse_corrections(
    raw: &[CorrectionSegment],
    content: &str,
) -> AppResult<Vec<CorrectionSegment>> {
    // 宽松解析：先严格 JSON，失败再修复 LaTeX 反斜杠转义后重试（与章节/出题共用）。
    // 先收成 Value 数组，再逐条尝试转 patch——这样单条结构异常不会废掉整批。
    let values: Vec<serde_json::Value> = crate::pipeline::ai::parse_lenient_json(content)?;
    let mut out = raw.to_vec();
    let mut seen = std::collections::HashSet::new();

    for value in values {
        let Ok(patch) = serde_json::from_value::<CorrectionPatch>(value) else {
            continue; // 单条字段缺失/类型不符 → 跳过
        };
        if patch.id >= raw.len() {
            continue; // id 越界（串位/编造）→ 跳过
        }
        if !seen.insert(patch.id) {
            continue; // 同一 id 重复 patch → 只取首次
        }

        let orig = &raw[patch.id];
        // replacedtext 为空是合法的「整段删除」：当一段全是语气词/口头禅（如「哎。」）
        // 时，模型按提示词把它清空。这里保留分段（时间戳不变，满足下游行数一致校验），
        // 只把文本置空——该时间段不再显示字幕，也不污染文稿/笔记。
        out[patch.id] = CorrectionSegment {
            start_ms: orig.start_ms,
            end_ms: orig.end_ms,
            text: patch.replacedtext.trim().to_string(),
        };
    }

    Ok(out)
}

pub async fn overwrite_transcript_texts(
    db: &Db,
    video_id: &str,
    corrected: &[CorrectionSegment],
) -> AppResult<()> {
    let rows = list_segments(db, video_id).await?;
    if rows.len() != corrected.len() {
        return Err(AppError::Other("transcript row count mismatch".into()));
    }

    for (row, segment) in rows.iter().zip(corrected) {
        if row.start_ms != segment.start_ms || row.end_ms != segment.end_ms {
            return Err(AppError::Other("transcript timestamp mismatch".into()));
        }
        sqlx::query("UPDATE transcripts SET text=? WHERE id=?")
            .bind(segment.text.trim())
            .bind(row.id)
            .execute(&db.pool)
            .await?;
    }
    Ok(())
}

// 每批的最大尝试次数。失败（限流/超时/解析不符）后重试，给一次机会，
// 而不是一遇错就保留原文导致「只处理了一部分」。
const CORRECTION_MAX_ATTEMPTS: usize = 3;

/// 单次尝试：调用模型并解析，结果记入开发控制台（含第几次尝试）。
async fn correct_batch_once(
    provider: &Provider,
    model: &str,
    video_id: &str,
    batch: &[CorrectionSegment],
    batch_json: &str,
    attempt: usize,
) -> AppResult<Vec<CorrectionSegment>> {
    let req = crate::llm::prompts::transcript_correction_request(model, batch_json);
    match provider.complete(&req).await {
        Ok(resp) => {
            let parsed = parse_corrections(batch, &resp.content);
            let status = match &parsed {
                Ok(_) if attempt == 1 => "已应用".to_string(),
                Ok(_) => format!("已应用（第 {attempt} 次重试成功）"),
                Err(error) => format!("解析失败（第 {attempt} 次）: {error}"),
            };
            crate::dev_log::record(
                "transcript_correction",
                video_id,
                batch_json,
                &resp.content,
                &status,
            );
            parsed
        }
        Err(error) => {
            crate::dev_log::record(
                "transcript_correction",
                video_id,
                batch_json,
                &format!("<调用失败> {error}"),
                &format!("调用失败（第 {attempt} 次）"),
            );
            Err(error)
        }
    }
}

async fn correct_batch(
    provider: &Provider,
    model: &str,
    video_id: &str,
    batch: &[CorrectionSegment],
) -> AppResult<Vec<CorrectionSegment>> {
    let batch_json = build_batch_request_json(batch)?;
    let mut last_err: Option<AppError> = None;
    for attempt in 1..=CORRECTION_MAX_ATTEMPTS {
        match correct_batch_once(provider, model, video_id, batch, &batch_json, attempt).await {
            Ok(fixed) => return Ok(fixed),
            Err(error) => {
                last_err = Some(error);
                if attempt < CORRECTION_MAX_ATTEMPTS {
                    // 退避，缓解限流：第 1 次失败等 0.5s，第 2 次等 1s。
                    tokio::time::sleep(std::time::Duration::from_millis(500 * attempt as u64))
                        .await;
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::Pipeline("transcript correction failed".into())))
}

fn assemble_corrections(
    results: Vec<(bool, Vec<CorrectionSegment>)>,
) -> AppResult<Vec<CorrectionSegment>> {
    let failed_count = results.iter().filter(|(ok, _)| !*ok).count();
    // 仅当「全部批次」都失败时才整体报错（多为模型/网络不可用）。
    // 否则：成功批应用纠正结果，失败批沿用其原始分段，二者按顺序拼回——
    // 失败批保留原文，但已识别成功的批次照常落库，不再因个别批失败而整篇放弃。
    if failed_count == results.len() {
        return Err(AppError::Pipeline(
            "所有分段纠错均失败（模型输出可能被截断或格式不符）".into(),
        ));
    }
    if failed_count > 0 {
        eprintln!(
            "transcript correction: {failed_count} batch(es) failed and kept raw; applying the rest"
        );
    }

    let mut corrected = Vec::new();
    for (_, part) in results {
        corrected.extend(part);
    }
    Ok(corrected)
}

#[derive(Deserialize)]
struct RawBackupSegment {
    segment_idx: i64,
    text: String,
}

/// 把最近一份原始 ASR 快照（transcript_backups source=raw_asr）写回 transcripts.text。
/// 用于「仅重新纠错」：先回到原始稿，再重跑纠错，避免在已纠错文本上反复改写。
/// 没有备份时返回 false（沿用当前文本）。
pub async fn restore_raw_transcript(db: &Db, video_id: &str) -> AppResult<bool> {
    let raw: Option<String> = sqlx::query_scalar(
        "SELECT segments_json FROM transcript_backups
         WHERE video_id=? AND source='raw_asr' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(video_id)
    .fetch_optional(&db.pool)
    .await?;
    let Some(json) = raw else {
        return Ok(false);
    };
    let segments: Vec<RawBackupSegment> = serde_json::from_str(&json)?;
    for segment in &segments {
        sqlx::query("UPDATE transcripts SET text=? WHERE video_id=? AND segment_idx=?")
            .bind(segment.text.trim())
            .bind(video_id)
            .bind(segment.segment_idx)
            .execute(&db.pool)
            .await?;
    }
    Ok(true)
}

pub async fn autocorrect_transcript(
    db: &Db,
    provider: &Provider,
    model: &str,
    video_id: &str,
) -> AppResult<()> {
    let rows = list_segments(db, video_id).await?;
    if rows.is_empty() {
        return Err(AppError::NotFound(format!("no transcript for {video_id}")));
    }

    let concurrency = correction_concurrency(db).await;
    let segments = load_correction_segments(&rows);
    // 用拥有所有权的批，避免在 async 闭包里借用引用形参（HRTB 生命周期问题）。
    let batches: Vec<Vec<CorrectionSegment>> = segments
        .chunks(CORRECTION_BATCH_SIZE)
        .map(<[_]>::to_vec)
        .collect();

    // 并发跑各批（buffered 保持原顺序）：批之间独立，并发后 1 小时视频快很多。
    // 任一批失败（截断/格式不符/调用出错）都不落库部分成果，避免正式文稿半纠错半原文。
    let results: Vec<(bool, Vec<CorrectionSegment>)> = futures_util::stream::iter(batches)
        .map(|batch| async move {
            match correct_batch(provider, model, video_id, &batch).await {
                Ok(fixed) => (true, fixed),
                Err(error) => {
                    eprintln!(
                        "transcript correction batch failed, keeping raw transcript: {error}"
                    );
                    (false, batch)
                }
            }
        })
        .buffered(concurrency)
        .collect()
        .await;

    let corrected = assemble_corrections(results)?;

    overwrite_transcript_texts(db, video_id, &corrected).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::videos::add_local_video;
    use tempfile::tempdir;

    async fn seed_video_with_transcript() -> (Db, String, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course = create_course(&db, "c".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let vpath = dir.path().join("v.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = add_local_video(&db, &course.id, vpath, None).await.unwrap();
        sqlx::query(
            "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text) VALUES (?,0,0,5000,?)",
        )
        .bind(&video.id)
        .bind("讲解第一部分")
        .execute(&db.pool)
        .await
        .unwrap();
        (db, video.id, dir)
    }

    #[test]
    fn parse_corrections_applies_patch_when_original_matches() {
        let raw = vec![
            CorrectionSegment {
                start_ms: 0,
                end_ms: 1000,
                text: "原文".into(),
            },
            CorrectionSegment {
                start_ms: 1000,
                end_ms: 2000,
                text: "不用修改".into(),
            },
        ];

        let out = parse_corrections(&raw, r#"[{"id":0,"replacedtext":"纠正文"}]"#).unwrap();

        assert_eq!(out.len(), 2);
        assert_eq!(out[0].start_ms, 0);
        assert_eq!(out[0].end_ms, 1000);
        assert_eq!(out[0].text, "纠正文");
        assert_eq!(out[1].text, "不用修改");
    }

    #[test]
    fn parse_corrections_skips_out_of_range_id() {
        let raw = vec![CorrectionSegment {
            start_ms: 0,
            end_ms: 1000,
            text: "原文".into(),
        }];

        // id 越界（模型串位/编造）：跳过该条，整批不失败，分段保持原文。
        let out = parse_corrections(&raw, r#"[{"id":5,"replacedtext":"纠正文"}]"#).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "原文");
    }

    #[test]
    fn parse_corrections_skips_malformed_item_keeps_valid() {
        let raw = vec![
            CorrectionSegment {
                start_ms: 0,
                end_ms: 1000,
                text: "第一段".into(),
            },
            CorrectionSegment {
                start_ms: 1000,
                end_ms: 2000,
                text: "第二段".into(),
            },
        ];

        // 第二条缺 replacedtext（结构异常）→ 单条跳过；第一条照常应用。
        let out = parse_corrections(
            &raw,
            r#"[{"id":0,"replacedtext":"改了"},{"id":1}]"#,
        )
        .unwrap();
        assert_eq!(out[0].text, "改了");
        assert_eq!(out[1].text, "第二段");
    }

    #[test]
    fn parse_corrections_repairs_unescaped_latex_backslashes() {
        let raw = vec![CorrectionSegment {
            start_ms: 0,
            end_ms: 1000,
            text: "原文".into(),
        }];
        // 真实失败样本：LaTeX 反斜杠没按 JSON 转义（单反斜杠），严格解析会 invalid escape。
        let content = r#"[{"id":0,"replacedtext":"速度 \(\sqrt{1-v^2/c^2}\)"}]"#;
        let out = parse_corrections(&raw, content).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, r"速度 \(\sqrt{1-v^2/c^2}\)");
    }

    #[test]
    fn parse_corrections_errors_on_non_json_output() {
        let raw = vec![CorrectionSegment {
            start_ms: 0,
            end_ms: 1000,
            text: "原文".into(),
        }];
        // 整体不是合法 JSON 数组（多为输出截断）→ 本批失败，交由上层保留原文。
        let err = parse_corrections(&raw, "对不起，我无法处理").unwrap_err();
        assert!(!err.to_string().is_empty());
    }

    #[test]
    fn parse_corrections_allows_empty_replacement_to_drop_filler() {
        // 整段是语气词时模型回空串 → 视为删除，该段文本置空、分段保留。
        let raw = vec![
            CorrectionSegment {
                start_ms: 0,
                end_ms: 1000,
                text: "哎。".into(),
            },
            CorrectionSegment {
                start_ms: 1000,
                end_ms: 2000,
                text: "正文".into(),
            },
        ];
        let out = parse_corrections(&raw, r#"[{"id":0,"replacedtext":""}]"#).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].text, "");
        assert_eq!(out[0].start_ms, 0);
        assert_eq!(out[0].end_ms, 1000);
        // 未被 patch 的分段保持原样。
        assert_eq!(out[1].text, "正文");
    }

    #[test]
    fn assemble_corrections_applies_successful_batches_on_partial_failure() {
        // 一批成功一批失败：成功批用纠正结果，失败批沿用原文，整体仍应用（不再整篇放弃）。
        let out = assemble_corrections(vec![
            (
                true,
                vec![CorrectionSegment {
                    start_ms: 0,
                    end_ms: 1000,
                    text: "第一段已纠正".into(),
                }],
            ),
            (
                false,
                vec![CorrectionSegment {
                    start_ms: 1000,
                    end_ms: 2000,
                    text: "第二段原文".into(),
                }],
            ),
        ])
        .unwrap();

        assert_eq!(out.len(), 2);
        assert_eq!(out[0].text, "第一段已纠正");
        assert_eq!(out[1].text, "第二段原文");
    }

    #[test]
    fn assemble_corrections_errors_only_when_all_failed() {
        let err = assemble_corrections(vec![(
            false,
            vec![CorrectionSegment {
                start_ms: 0,
                end_ms: 1000,
                text: "原文".into(),
            }],
        )])
        .unwrap_err();
        assert!(err.to_string().contains("所有分段纠错均失败"));
    }

    #[tokio::test]
    async fn autocorrect_applies_corrected_text_via_mock() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        let provider = Provider::Mock {
            canned: r#"[{"id":0,"replacedtext":"纠正后的第一部分"}]"#.into(),
        };
        autocorrect_transcript(&db, &provider, "m", &vid)
            .await
            .unwrap();
        let joined = crate::pipeline::ai::transcript_text(&db, &vid)
            .await
            .unwrap();
        assert!(joined.contains("纠正后的第一部分"));
    }

    #[tokio::test]
    async fn restore_raw_transcript_writes_backup_text_back() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        // 模拟一份原始 ASR 备份，文本与当前不同。
        let backup = r#"[{"segment_idx":0,"start_ms":0,"end_ms":5000,"text":"原始未纠错文本","words_json":"[]"}]"#;
        sqlx::query(
            "INSERT INTO transcript_backups(video_id,source,segments_json,created_at) VALUES (?,?,?,?)",
        )
        .bind(&vid)
        .bind("raw_asr")
        .bind(backup)
        .bind(1_i64)
        .execute(&db.pool)
        .await
        .unwrap();

        let restored = restore_raw_transcript(&db, &vid).await.unwrap();
        assert!(restored);
        let joined = crate::pipeline::ai::transcript_text(&db, &vid)
            .await
            .unwrap();
        assert!(joined.contains("原始未纠错文本"));
    }

    #[tokio::test]
    async fn restore_raw_transcript_is_noop_without_backup() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        assert!(!restore_raw_transcript(&db, &vid).await.unwrap());
    }

    #[tokio::test]
    async fn autocorrect_errs_and_keeps_original_when_all_batches_fail() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        let provider = Provider::Mock {
            canned: "这不是 JSON".into(),
        };
        let err = autocorrect_transcript(&db, &provider, "m", &vid)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("所有分段纠错均失败"));
        // 原始文稿未被破坏。
        let joined = crate::pipeline::ai::transcript_text(&db, &vid)
            .await
            .unwrap();
        assert!(joined.contains("讲解第一部分"));
    }

    #[tokio::test]
    async fn overwrite_transcript_texts_updates_transcript_text_reader() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        overwrite_transcript_texts(
            &db,
            &vid,
            &[CorrectionSegment {
                start_ms: 0,
                end_ms: 5000,
                text: "纠正后的讲解第一部分".into(),
            }],
        )
        .await
        .unwrap();

        let joined = crate::pipeline::ai::transcript_text(&db, &vid)
            .await
            .unwrap();
        assert!(joined.contains("纠正后的讲解第一部分"));
    }
}
