use crate::commands::transcripts::{list_segments, TranscriptSegment};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::Provider;
use futures_util::stream::StreamExt;
use serde::{Deserialize, Serialize};

// 一批的段数。模型只返回需要修改的 patch（按 id 引用）。
//
// 原来是 20，顾虑是「批越大越容易输出截断、id 越界/串位」。这两条现在不对称了：
// 截断那半条基本消失——出站请求根本不发 max_tokens，输出预算是模型自己的，
// 一批四十段的 patch 离任何现代模型的上限都还很远；而 id 串位那半条仍然成立，
// 靠的是解析时的逐条校验（越界跳过、重复只取首次），错了会漏改而不会改错人。
// 于是取 40：往返次数减半，风险仍由校验兜住。再往上就要先有真实数据支撑了。
const CORRECTION_BATCH_SIZE: usize = 40;
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

// 模型回的 patch 有两种形状，都只认 id 加各自那两个字段；其余字段（哪怕模型多回了
// 原文/时间戳）一律忽略。字段缺失则该条反序列化失败 → 单条跳过，不会误把整段清空。
//
// 局部替换：只回被改的那一小截。一段四十字的话里认错两个字，原来要把整段四十字
// 重新写回来，现在只付那两个字加上下文的钱——输出是这条链路上最贵的部分。
#[derive(Debug, Clone, Deserialize)]
struct ReplacePatch {
    id: usize,
    from: String,
    to: String,
}

// 整段重写：改动铺满全段时（断句重排之类）用它。这种情况下局部替换反而更贵——
// from 要把原文整段抄一遍，等于新旧各付一份。
#[derive(Debug, Clone, Deserialize)]
struct RewritePatch {
    id: usize,
    replacedtext: String,
}

/// 一段上要做的改动。
enum Edit {
    Replace { from: String, to: String },
    Rewrite(String),
}

/// 把若干「把 from 换成 to」应用到一段文本上。
///
/// 全部按**原文**定位、校验完再一次性替换。逐条替换会互相干扰：前一条改完之后，
/// 后一条的 from 可能不再匹配，更糟的是可能匹配到刚刚新造出来的位置上，改错地方。
///
/// 每条 from 必须在原文里**恰好出现一次**。出现零次说明模型抄错了原文，出现多次
/// 说明不知道它指的是哪一处——两种都跳过、保留原文。宁可漏掉一处该改的，
/// 也不能把不该动的地方改了：这份文稿会进笔记、出题和检索。
fn apply_replacements(original: &str, edits: &[(String, String)]) -> String {
    let mut spans: Vec<(usize, usize, &str)> = Vec::new();
    for (from, to) in edits {
        if from.is_empty() {
            continue; // 空的 from 无从定位
        }
        let mut hits = original.match_indices(from.as_str());
        let Some((start, matched)) = hits.next() else {
            continue; // 对不上原文
        };
        if hits.next().is_some() {
            continue; // 不止一处，说不清改哪个
        }
        spans.push((start, start + matched.len(), to.as_str()));
    }
    spans.sort_by_key(|(start, _, _)| *start);

    let mut out = String::with_capacity(original.len());
    let mut cursor = 0usize;
    for (start, end, to) in spans {
        if start < cursor {
            continue; // 与前一处改动重叠，跳过后来的这条
        }
        out.push_str(&original[cursor..start]);
        out.push_str(to);
        cursor = end;
    }
    out.push_str(&original[cursor..]);
    out
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
    let mut edits: std::collections::HashMap<usize, Vec<Edit>> = std::collections::HashMap::new();

    for value in values {
        // 先按局部替换认，认不出再按整段重写认。两种都不是 → 跳过这一条。
        let (id, edit) = if let Ok(patch) = serde_json::from_value::<ReplacePatch>(value.clone()) {
            (
                patch.id,
                Edit::Replace {
                    from: patch.from,
                    to: patch.to,
                },
            )
        } else if let Ok(patch) = serde_json::from_value::<RewritePatch>(value) {
            (patch.id, Edit::Rewrite(patch.replacedtext))
        } else {
            continue; // 单条字段缺失/类型不符 → 跳过
        };
        if id >= raw.len() {
            continue; // id 越界（串位/编造）→ 跳过
        }
        edits.entry(id).or_default().push(edit);
    }

    for (id, edits) in edits {
        let orig = &raw[id];
        // 同一段既给了整段重写又给了局部替换时以整段重写为准（取第一条）：
        // 两种混着往同一段上招呼，结果取决于顺序，不如挑一个说得清的规则。
        let rewritten = edits.iter().find_map(|edit| match edit {
            Edit::Rewrite(text) => Some(text.clone()),
            Edit::Replace { .. } => None,
        });
        let text = match rewritten {
            Some(text) => text,
            None => {
                let pairs: Vec<(String, String)> = edits
                    .into_iter()
                    .filter_map(|edit| match edit {
                        Edit::Replace { from, to } => Some((from, to)),
                        Edit::Rewrite(_) => None,
                    })
                    .collect();
                apply_replacements(&orig.text, &pairs)
            }
        };
        // 文本为空是合法的「整段删除」：当一段全是语气词/口头禅（如「哎。」）时，
        // 模型按提示词把它清空。这里保留分段（时间戳不变，满足下游行数一致校验），
        // 只把文本置空——该时间段不再显示字幕，也不污染文稿/笔记。
        out[id] = CorrectionSegment {
            start_ms: orig.start_ms,
            end_ms: orig.end_ms,
            text: text.trim().to_string(),
        };
    }

    Ok(out)
}

pub async fn overwrite_transcript_texts(
    db: &Db,
    video_id: &str,
    corrected: &[CorrectionSegment],
) -> AppResult<()> {
    let mut tx = db.pool.begin().await?;
    let rows: Vec<TranscriptSegment> = sqlx::query_as(
        "SELECT id,video_id,segment_idx,start_ms,end_ms,text
         FROM transcripts WHERE video_id=? ORDER BY segment_idx",
    )
    .bind(video_id)
    .fetch_all(&mut *tx)
    .await?;
    if rows.len() != corrected.len() {
        return Err(AppError::Other("transcript row count mismatch".into()));
    }

    for (row, segment) in rows.iter().zip(corrected) {
        if row.start_ms != segment.start_ms || row.end_ms != segment.end_ms {
            return Err(AppError::Other("transcript timestamp mismatch".into()));
        }
    }
    for (row, segment) in rows.iter().zip(corrected) {
        let result = sqlx::query("UPDATE transcripts SET text=? WHERE id=?")
            .bind(segment.text.trim())
            .bind(row.id)
            .execute(&mut *tx)
            .await?;
        if result.rows_affected() != 1 {
            return Err(AppError::Other(
                "transcript changed while correcting".into(),
            ));
        }
    }
    tx.commit().await?;
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

/// 把最近一份原始快照写回 transcripts.text。
/// 用于「仅重新纠错」：先回到原始稿，再重跑纠错，避免在已纠错文本上反复改写。
/// 没有任何备份时返回 false（沿用当前文本）。
///
/// 优先取原始 ASR 稿；没有就退到最近的一份**任何来源**的备份——视频自带字幕
/// （B 站/本地 SRT）走的是导入而不是语音识别，备份记的是 `bilibili_sub` 之类的来源。
/// 只认 raw_asr 的话，这类视频每次「重新纠错」都是在上一次的纠错结果上再纠一遍，
/// 改动会一轮轮累积漂移。
pub async fn restore_raw_transcript(db: &Db, video_id: &str) -> AppResult<bool> {
    let mut tx = db.pool.begin().await?;
    let raw: Option<String> = sqlx::query_scalar(
        "SELECT segments_json FROM transcript_backups
         WHERE video_id=?
         ORDER BY (source='raw_asr') DESC, created_at DESC
         LIMIT 1",
    )
    .bind(video_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(json) = raw else {
        return Ok(false);
    };
    let segments: Vec<RawBackupSegment> = serde_json::from_str(&json)?;
    let current_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM transcripts WHERE video_id=?")
            .bind(video_id)
            .fetch_one(&mut *tx)
            .await?;
    if current_count != segments.len() as i64 {
        return Err(AppError::Other(
            "raw transcript backup row count mismatch".into(),
        ));
    }
    for segment in &segments {
        let result =
            sqlx::query("UPDATE transcripts SET text=? WHERE video_id=? AND segment_idx=?")
                .bind(segment.text.trim())
                .bind(video_id)
                .bind(segment.segment_idx)
                .execute(&mut *tx)
                .await?;
        if result.rows_affected() != 1 {
            return Err(AppError::Other(
                "raw transcript backup does not match current segments".into(),
            ));
        }
    }
    tx.commit().await?;
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
        // 说人话并给出下一步。这是「重新纠错」最后的一道拦截，用户看到的就是这句话；
        // 原来吐的是 `no transcript for <一串 id>`，既看不懂也不知道该干什么。
        return Err(AppError::NotFound(
            "这个视频还没有文稿，先「开始处理」生成字幕之后才能纠错".into(),
        ));
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

    fn seg(start_ms: i64, end_ms: i64, text: &str) -> CorrectionSegment {
        CorrectionSegment {
            start_ms,
            end_ms,
            text: text.into(),
        }
    }

    #[test]
    fn a_local_patch_only_touches_the_span_it_names() {
        // 输出是这条链路上最贵的部分。一段四十字的话里认错两个字，原来要把整段
        // 四十字重新写回来；现在只回那一小截，其余原样保留。
        let raw = vec![seg(0, 5000, "所以 m 零 是静止质量，这一点要记住")];

        let out = parse_corrections(&raw, r#"[{"id":0,"from":"m 零","to":"\\(m_0\\)"}]"#).unwrap();

        assert_eq!(out[0].text, "所以 \\(m_0\\) 是静止质量，这一点要记住");
        assert_eq!(out[0].start_ms, 0);
    }

    #[test]
    fn several_patches_on_one_segment_all_land() {
        let raw = vec![seg(0, 5000, "嗯，那个速度是 v 方，对吧")];

        let out = parse_corrections(
            &raw,
            r#"[{"id":0,"from":"嗯，那个","to":""},{"id":0,"from":"v 方","to":"v²"},{"id":0,"from":"，对吧","to":""}]"#,
        )
        .unwrap();

        assert_eq!(out[0].text, "速度是 v²");
    }

    #[test]
    fn patches_are_located_against_the_original_not_each_other() {
        // 逐条替换会互相干扰：改完第一处之后，第二处的 from 可能匹配到刚刚新造出来的
        // 位置上，改错地方。所以全部按原文定位、一次性替换。
        let raw = vec![seg(0, 5000, "AB")];

        // 若逐条应用：先 A→B 得到 "BB"，再把 B→C 就会撞上两个 B。按原文定位则各改各的。
        let out = parse_corrections(
            &raw,
            r#"[{"id":0,"from":"A","to":"B"},{"id":0,"from":"B","to":"C"}]"#,
        )
        .unwrap();

        assert_eq!(out[0].text, "BC");
    }

    #[test]
    fn a_patch_that_does_not_match_the_original_is_dropped() {
        // 模型把原文抄错了。宁可漏掉这处改动，也不能猜着往上安——这份文稿会进
        // 笔记、出题和检索。
        let raw = vec![seg(0, 5000, "静止质量是 m 零")];

        let out =
            parse_corrections(&raw, r#"[{"id":0,"from":"静止質量","to":"静止质量"}]"#).unwrap();

        assert_eq!(out[0].text, "静止质量是 m 零", "对不上原文就保持原样");
    }

    #[test]
    fn an_ambiguous_patch_is_dropped_rather_than_guessed() {
        // 「的」在这段里出现两次，模型没说清改哪一个。改错位置比不改更糟。
        let raw = vec![seg(0, 5000, "他的书和她的书")];

        let out = parse_corrections(&raw, r#"[{"id":0,"from":"的","to":"地"}]"#).unwrap();

        assert_eq!(out[0].text, "他的书和她的书");
    }

    #[test]
    fn overlapping_patches_keep_the_first_and_drop_the_rest() {
        let raw = vec![seg(0, 5000, "abcdef")];

        let out = parse_corrections(
            &raw,
            r#"[{"id":0,"from":"bcd","to":"X"},{"id":0,"from":"cde","to":"Y"}]"#,
        )
        .unwrap();

        assert_eq!(out[0].text, "aXef");
    }

    #[test]
    fn a_whole_segment_rewrite_still_works() {
        // 改动铺满全段时（断句重排之类）局部替换反而更贵：from 要把原文整段抄一遍。
        // 这种情况仍然可以整段回。
        let raw = vec![seg(0, 5000, "然后 呢 我们 来 看 这个 题")];

        let out = parse_corrections(&raw, r#"[{"id":0,"replacedtext":"我们来看这道题"}]"#).unwrap();

        assert_eq!(out[0].text, "我们来看这道题");
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
        let out = parse_corrections(&raw, r#"[{"id":0,"replacedtext":"改了"},{"id":1}]"#).unwrap();
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
    async fn recorrecting_a_subtitle_video_starts_from_the_imported_text() {
        // 自带字幕的视频（B 站/本地 SRT）走的是导入而不是语音识别，备份来源不是
        // raw_asr。只认 raw_asr 的话，每次「重新纠错」都是在上一次的结果上再纠一遍，
        // 改动会一轮轮累积漂移。
        let (db, vid, _dir) = seed_video_with_transcript().await;
        let segments = vec![crate::pipeline::asr::StoredSegment {
            start_ms: 0,
            end_ms: 5_000,
            text: "导入时的原始字幕".into(),
            words_json: "[]".into(),
        }];
        crate::pipeline::asr::store_segments_with_backup(&db, &vid, "bilibili_sub", &segments)
            .await
            .unwrap();
        // 上一轮纠错把它改过了。
        sqlx::query("UPDATE transcripts SET text=? WHERE video_id=?")
            .bind("上一轮纠错后的文本")
            .bind(&vid)
            .execute(&db.pool)
            .await
            .unwrap();

        assert!(restore_raw_transcript(&db, &vid).await.unwrap());

        let text: String = sqlx::query_scalar("SELECT text FROM transcripts WHERE video_id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(text, "导入时的原始字幕");
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

    #[tokio::test]
    async fn timestamp_mismatch_does_not_partially_update_transcript() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        sqlx::query(
            "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text)
             VALUES (?,1,5000,10000,'第二部分')",
        )
        .bind(&vid)
        .execute(&db.pool)
        .await
        .unwrap();
        let corrected = vec![
            CorrectionSegment {
                start_ms: 0,
                end_ms: 5000,
                text: "第一部分已改".into(),
            },
            CorrectionSegment {
                start_ms: 5001,
                end_ms: 10000,
                text: "错误时间戳".into(),
            },
        ];

        assert!(overwrite_transcript_texts(&db, &vid, &corrected)
            .await
            .is_err());

        let texts: Vec<String> = sqlx::query_scalar(
            "SELECT text FROM transcripts WHERE video_id=? ORDER BY segment_idx",
        )
        .bind(&vid)
        .fetch_all(&db.pool)
        .await
        .unwrap();
        assert_eq!(texts, vec!["讲解第一部分", "第二部分"]);
    }

    #[tokio::test]
    async fn mismatched_raw_backup_does_not_partially_restore_transcript() {
        let (db, vid, _d) = seed_video_with_transcript().await;
        let backup = r#"[{"segment_idx":0,"text":"第一段原始文本"},{"segment_idx":1,"text":"第二段原始文本"}]"#;
        sqlx::query(
            "INSERT INTO transcript_backups(video_id,source,segments_json,created_at)
             VALUES (?,'raw_asr',?,1)",
        )
        .bind(&vid)
        .bind(backup)
        .execute(&db.pool)
        .await
        .unwrap();

        assert!(restore_raw_transcript(&db, &vid).await.is_err());

        let text: String = sqlx::query_scalar("SELECT text FROM transcripts WHERE video_id=?")
            .bind(&vid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(text, "讲解第一部分");
    }
}
