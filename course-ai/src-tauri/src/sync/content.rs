//! 字幕和 AI 生成内容的同步记录：每个视频一条字幕 / 章节 / 摘要 / 练习题 / 脑图 / 精华，
//! 每门课一条知识点（含讲解、出处和课程概览）。
//!
//! 合并律：这些都是**生成出来的整块内容**，没有「两边各改一半」这回事——用户要么重新识别、
//! 要么重新生成，结果整份换掉。所以按（墙钟, 设备）后写胜、整条替换。这是全序上的 max，
//! 交换、结合、幂等，满足同步内核对合并函数的要求（docs/2026-08-04-sync-merge-laws.md §1）。
//!
//! 本机的戳在 sync_content_stamps：本机改动由触发器记，合并对端版本时这里记成对端的戳。
//! 「过期」标记靠的生成指纹（ai_artifact_sources）随内容一起带过去，两边判断一致。
//!
//! 视频封面（Cover）也走这里：它是从视频文件截出来的一帧，没有文件的设备自己截不出来。
//! 封面不在表里，而是数据目录里的 cover.jpg——所以不靠触发器入队，截出新封面时由
//! `enqueue_cover` 直接排进出件箱；收到时写进本机这个视频的数据目录。

use crate::error::AppResult;
use crate::sync::envelope::SyncEnvelope;
use serde_json::{json, Value};
use sqlx::{Sqlite, Transaction};

/// 按视频的内容记录：（记录类型, 生成指纹里的产物名）。
const VIDEO_TYPES: &[(&str, Option<&str>)] = &[
    ("Transcript", None),
    ("Chapters", Some("chapters")),
    ("Summary", Some("summary")),
    ("Quiz", Some("quiz")),
    ("Mindmap", Some("mindmap")),
    ("Highlights", Some("highlights")),
    ("Cover", None),
];

pub const COVER: &str = "Cover";
/// 封面比这还大就不同步（正常的封面几十 KB，这么大多半是出了什么问题）。
const COVER_MAX_BYTES: u64 = 1024 * 1024;

pub const COURSE_KNOWLEDGE: &str = "CourseKnowledge";

pub fn is_content(record_type: &str) -> bool {
    record_type == COURSE_KNOWLEDGE || VIDEO_TYPES.iter().any(|(name, _)| *name == record_type)
}

/// 首次开启同步时要排进出件箱的内容记录：（记录类型, 表, 键列）。
const SNAPSHOT_SOURCES: &[(&str, &str, &str)] = &[
    ("Transcript", "transcripts", "video_id"),
    ("Chapters", "chapters", "video_id"),
    ("Summary", "summaries", "video_id"),
    ("Quiz", "quizzes", "video_id"),
    ("Mindmap", "mindmaps", "video_id"),
    ("Highlights", "video_highlights", "video_id"),
    ("CourseKnowledge", "concepts", "course_id"),
    ("CourseKnowledge", "course_knowledge_overviews", "course_id"),
];

/// 把本机已有的字幕和生成内容全部排进出件箱（开同步后只跑一次）。
///
/// 本机戳一并记成同一时刻：发出去的版本和本地记着的版本必须是同一个戳，
/// 否则之后比先后时，本机会把自己已经发出的内容当成更旧的。
pub async fn enqueue_snapshot(db: &crate::db::Db) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut tx = db.begin_write().await?;
    let device: String = sqlx::query_scalar("SELECT device_id FROM sync_device_state WHERE singleton=1")
        .fetch_optional(&mut *tx)
        .await?
        .unwrap_or_default();
    for (record_type, table, id_column) in SNAPSHOT_SOURCES {
        sqlx::query(&format!(
            "INSERT INTO sync_outbox(record_type,record_id,operation,changed_at)
             SELECT DISTINCT ?, {id_column}, 'save', ? FROM {table} WHERE {id_column} IS NOT NULL
             ON CONFLICT(record_type,record_id) DO UPDATE SET changed_at=excluded.changed_at,
               leased_at=NULL, version_counter=NULL, version_device=NULL"
        ))
        .bind(record_type)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(&format!(
            "INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device)
             SELECT DISTINCT ?, {id_column}, ?, ? FROM {table} WHERE {id_column} IS NOT NULL
             ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device"
        ))
        .bind(record_type)
        .bind(now)
        .bind(&device)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

fn artifact_of(record_type: &str) -> Option<&'static str> {
    VIDEO_TYPES.iter().find(|(name, _)| *name == record_type).and_then(|(_, artifact)| *artifact)
}

async fn source_of(tx: &mut Transaction<'_, Sqlite>, video_id: &str, artifact: Option<&str>) -> AppResult<Value> {
    let Some(artifact) = artifact else { return Ok(Value::Null) };
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT fingerprint, generated_at FROM ai_artifact_sources WHERE video_id=? AND artifact=?")
            .bind(video_id)
            .bind(artifact)
            .fetch_optional(&mut **tx)
            .await?;
    Ok(row
        .map(|(fingerprint, generated_at)| json!({"fingerprint": fingerprint, "generatedAt": generated_at}))
        .unwrap_or(Value::Null))
}

/// 本机有文件的视频的封面路径（没有文件的设备不往外发封面：它的封面本来就是收来的）。
async fn local_cover_path(tx: &mut Transaction<'_, Sqlite>, video_id: &str) -> AppResult<Option<std::path::PathBuf>> {
    let row: Option<(String, String)> = sqlx::query_as("SELECT file_path, data_dir FROM videos WHERE id=?")
        .bind(video_id)
        .fetch_optional(&mut **tx)
        .await?;
    Ok(row
        .filter(|(file_path, data_dir)| !file_path.is_empty() && !data_dir.is_empty())
        .map(|(_, data_dir)| std::path::Path::new(&data_dir).join("cover.jpg")))
}

/// 截出了新封面：排进出件箱（和触发器做的一样：入队 + 记本机戳）。
pub async fn enqueue_cover(db: &crate::db::Db, video_id: &str) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut tx = db.begin_write().await?;
    enqueue_covers_in(&mut tx, &[video_id.to_string()], now).await?;
    tx.commit().await?;
    Ok(())
}

/// 本机已经截好的封面全部排进出件箱（封面是后来才纳入同步的，已经开着同步的设备补推一次）。
pub async fn enqueue_cover_snapshot(db: &crate::db::Db) -> AppResult<usize> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT id, data_dir FROM videos WHERE deleted_at IS NULL AND file_path<>'' AND data_dir<>''")
            .fetch_all(&db.pool)
            .await?;
    let ids: Vec<String> = rows
        .into_iter()
        .filter(|(_, data_dir)| std::path::Path::new(data_dir).join("cover.jpg").is_file())
        .map(|(id, _)| id)
        .collect();
    let mut tx = db.begin_write().await?;
    enqueue_covers_in(&mut tx, &ids, chrono::Utc::now().timestamp_millis()).await?;
    tx.commit().await?;
    Ok(ids.len())
}

async fn enqueue_covers_in(tx: &mut Transaction<'_, Sqlite>, ids: &[String], now: i64) -> AppResult<()> {
    let device: String = sqlx::query_scalar("SELECT device_id FROM sync_device_state WHERE singleton=1")
        .fetch_optional(&mut **tx)
        .await?
        .unwrap_or_default();
    for id in ids {
        sqlx::query(
            "INSERT INTO sync_outbox(record_type,record_id,operation,changed_at) VALUES (?,?,'save',?)
             ON CONFLICT(record_type,record_id) DO UPDATE SET operation='save',changed_at=excluded.changed_at,
               attempts=0,leased_at=NULL,last_error=NULL,version_counter=NULL,version_device=NULL",
        )
        .bind(COVER)
        .bind(id)
        .bind(now)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device) VALUES (?,?,?,?)
             ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device",
        )
        .bind(COVER)
        .bind(id)
        .bind(now)
        .bind(&device)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// 出件：从本地表拼出整条记录。记录已经不存在（内容被删光）时返回 None，外发会转成删除。
pub async fn payload(tx: &mut Transaction<'_, Sqlite>, record_type: &str, id: &str) -> AppResult<Option<Value>> {
    if record_type == COVER {
        let Some(path) = local_cover_path(tx, id).await? else { return Ok(None) };
        let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        if size == 0 || size > COVER_MAX_BYTES {
            return Ok(None);
        }
        let bytes = std::fs::read(&path)?;
        use base64::Engine as _;
        return Ok(Some(json!({"videoID": id, "jpeg": base64::engine::general_purpose::STANDARD.encode(bytes)})));
    }
    let source = source_of(tx, id, artifact_of(record_type)).await?;
    let value = match record_type {
        "Transcript" => {
            let rows: Vec<(i64, i64, i64, String, Option<String>)> = sqlx::query_as(
                "SELECT segment_idx,start_ms,end_ms,text,words_json FROM transcripts WHERE video_id=? ORDER BY segment_idx",
            )
            .bind(id)
            .fetch_all(&mut **tx)
            .await?;
            if rows.is_empty() {
                return Ok(None);
            }
            let segments: Vec<Value> = rows
                .into_iter()
                .map(|(idx, start, end, text, words)| json!([idx, start, end, text, words]))
                .collect();
            json!({"videoID": id, "segments": segments})
        }
        "Chapters" => {
            let rows: Vec<(String, Option<String>, i64, i64, i64)> = sqlx::query_as(
                "SELECT title,summary,start_ms,end_ms,order_index FROM chapters WHERE video_id=? ORDER BY order_index, start_ms",
            )
            .bind(id)
            .fetch_all(&mut **tx)
            .await?;
            if rows.is_empty() {
                return Ok(None);
            }
            let chapters: Vec<Value> = rows
                .into_iter()
                .map(|(title, summary, start, end, order)| json!([title, summary, start, end, order]))
                .collect();
            json!({"videoID": id, "chapters": chapters, "source": source})
        }
        "Summary" | "Quiz" | "Mindmap" | "Highlights" => {
            let (table, column) = single_table(record_type);
            let row: Option<(String, i64)> =
                sqlx::query_as(&format!("SELECT {column}, generated_at FROM {table} WHERE video_id=?"))
                    .bind(id)
                    .fetch_optional(&mut **tx)
                    .await?;
            let Some((content, generated_at)) = row else { return Ok(None) };
            json!({"videoID": id, "content": content, "generatedAt": generated_at, "source": source})
        }
        COURSE_KNOWLEDGE => {
            let concepts: Vec<(String, String, i64, Option<String>, Option<String>)> = sqlx::query_as(
                "SELECT id,name,created_at,explanation,explanation_source FROM concepts WHERE course_id=? ORDER BY id",
            )
            .bind(id)
            .fetch_all(&mut **tx)
            .await?;
            let occurrences: Vec<(String, String, i64)> = sqlx::query_as(
                "SELECT o.concept_id,o.video_id,o.start_ms FROM concept_occurrences o
                 JOIN concepts c ON c.id=o.concept_id WHERE c.course_id=? ORDER BY 1,2,3",
            )
            .bind(id)
            .fetch_all(&mut **tx)
            .await?;
            let overview: Option<(String, String, i64)> = sqlx::query_as(
                "SELECT content_json,source_fingerprint,generated_at FROM course_knowledge_overviews WHERE course_id=?",
            )
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?;
            if concepts.is_empty() && overview.is_none() {
                return Ok(None);
            }
            json!({
                "courseID": id,
                "concepts": concepts.into_iter().map(|(cid, name, created, explanation, source)| json!([cid, name, created, explanation, source])).collect::<Vec<_>>(),
                "occurrences": occurrences.into_iter().map(|(cid, vid, at)| json!([cid, vid, at])).collect::<Vec<_>>(),
                "overview": overview.map(|(content, fingerprint, generated)| json!({"contentJson": content, "sourceFingerprint": fingerprint, "generatedAt": generated})),
            })
        }
        _ => return Ok(None),
    };
    Ok(Some(value))
}

fn single_table(record_type: &str) -> (&'static str, &'static str) {
    match record_type {
        "Summary" => ("summaries", "content_md"),
        "Quiz" => ("quizzes", "questions_json"),
        "Mindmap" => ("mindmaps", "markmap_md"),
        _ => ("video_highlights", "segments_json"),
    }
}

/// 合并结果：Parked = 依赖的视频 / 课程还没到，留着下一轮再试。
pub enum ContentOutcome {
    Applied,
    Skipped,
    Parked,
}

async fn local_stamp(tx: &mut Transaction<'_, Sqlite>, record_type: &str, id: &str) -> AppResult<(i64, String)> {
    Ok(sqlx::query_as("SELECT updated_at, device FROM sync_content_stamps WHERE record_type=? AND record_id=?")
        .bind(record_type)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .unwrap_or((0, String::new())))
}

async fn set_stamp(tx: &mut Transaction<'_, Sqlite>, envelope: &SyncEnvelope) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO sync_content_stamps(record_type,record_id,updated_at,device) VALUES (?,?,?,?)
         ON CONFLICT(record_type,record_id) DO UPDATE SET updated_at=excluded.updated_at, device=excluded.device",
    )
    .bind(&envelope.record_type)
    .bind(&envelope.record_id)
    .bind(envelope.updated_at)
    .bind(&envelope.version.device)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// 对端的版本比本地新吗？（墙钟, 设备）字典序比较，两台设备得出同一个胜者。
async fn remote_wins(tx: &mut Transaction<'_, Sqlite>, envelope: &SyncEnvelope) -> AppResult<bool> {
    let (local_ms, local_device) = local_stamp(tx, &envelope.record_type, &envelope.record_id).await?;
    Ok((envelope.updated_at, envelope.version.device.as_str()) > (local_ms, local_device.as_str()))
}

async fn exists(tx: &mut Transaction<'_, Sqlite>, table: &str, id: &str) -> AppResult<bool> {
    Ok(sqlx::query_scalar(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?)"))
        .bind(id)
        .fetch_one(&mut **tx)
        .await?)
}

async fn write_source(tx: &mut Transaction<'_, Sqlite>, video_id: &str, record_type: &str, source: Option<&Value>) -> AppResult<()> {
    let Some(artifact) = artifact_of(record_type) else { return Ok(()) };
    match source.filter(|value| !value.is_null()) {
        Some(source) => {
            let fingerprint = source.get("fingerprint").and_then(Value::as_str).unwrap_or_default();
            let generated_at = source.get("generatedAt").and_then(Value::as_i64).unwrap_or(0);
            sqlx::query(
                "INSERT INTO ai_artifact_sources(video_id,artifact,fingerprint,generated_at) VALUES (?,?,?,?)
                 ON CONFLICT(video_id,artifact) DO UPDATE SET fingerprint=excluded.fingerprint, generated_at=excluded.generated_at",
            )
            .bind(video_id)
            .bind(artifact)
            .bind(fingerprint)
            .bind(generated_at)
            .execute(&mut **tx)
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM ai_artifact_sources WHERE video_id=? AND artifact=?")
                .bind(video_id)
                .bind(artifact)
                .execute(&mut **tx)
                .await?;
        }
    }
    Ok(())
}

/// 合并一条保存信封（调用方已经在回声抑制的事务里）。
pub async fn save(tx: &mut Transaction<'_, Sqlite>, envelope: &SyncEnvelope) -> AppResult<ContentOutcome> {
    let id = envelope.record_id.as_str();
    let payload = &envelope.payload;
    let owner_ready = if envelope.record_type == COURSE_KNOWLEDGE {
        exists(tx, "courses", id).await?
    } else {
        exists(tx, "videos", id).await?
    };
    if !owner_ready {
        return Ok(ContentOutcome::Parked);
    }
    if !remote_wins(tx, envelope).await? {
        return Ok(ContentOutcome::Skipped);
    }
    match envelope.record_type.as_str() {
        COVER => {
            use base64::Engine as _;
            let row: Option<(String, String)> = sqlx::query_as("SELECT file_path, data_dir FROM videos WHERE id=?")
                .bind(id)
                .fetch_optional(&mut **tx)
                .await?;
            let Some((file_path, data_dir)) = row.filter(|(_, data_dir)| !data_dir.is_empty()) else {
                return Ok(ContentOutcome::Skipped);
            };
            let cover = std::path::Path::new(&data_dir).join("cover.jpg");
            // 本机有文件、也已经截过封面：用自己的（同一个文件截出来的，没必要换）。
            if !file_path.is_empty() && cover.is_file() {
                return Ok(ContentOutcome::Skipped);
            }
            let Some(bytes) = payload
                .get("jpeg")
                .and_then(Value::as_str)
                .and_then(|text| base64::engine::general_purpose::STANDARD.decode(text).ok())
                .filter(|bytes| !bytes.is_empty())
            else {
                return Ok(ContentOutcome::Skipped);
            };
            std::fs::create_dir_all(&data_dir)?;
            let temporary = cover.with_extension("jpg.sync-tmp");
            std::fs::write(&temporary, &bytes)?;
            std::fs::rename(&temporary, &cover)?;
        }
        "Transcript" => {
            sqlx::query("DELETE FROM transcripts WHERE video_id=?").bind(id).execute(&mut **tx).await?;
            for segment in payload.get("segments").and_then(Value::as_array).into_iter().flatten() {
                sqlx::query(
                    "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text,words_json) VALUES (?,?,?,?,?,?)",
                )
                .bind(id)
                .bind(segment.get(0).and_then(Value::as_i64).unwrap_or(0))
                .bind(segment.get(1).and_then(Value::as_i64).unwrap_or(0))
                .bind(segment.get(2).and_then(Value::as_i64).unwrap_or(0))
                .bind(segment.get(3).and_then(Value::as_str).unwrap_or_default())
                .bind(segment.get(4).and_then(Value::as_str))
                .execute(&mut **tx)
                .await?;
            }
            // 字幕到了，这台设备就不必再处理这个视频（同步过来的条目原本是「待处理」）。
            sqlx::query("UPDATE videos SET processed_status='done' WHERE id=? AND processed_status IN ('pending','failed')")
                .bind(id)
                .execute(&mut **tx)
                .await?;
        }
        "Chapters" => {
            sqlx::query("DELETE FROM chapters WHERE video_id=?").bind(id).execute(&mut **tx).await?;
            for chapter in payload.get("chapters").and_then(Value::as_array).into_iter().flatten() {
                sqlx::query(
                    "INSERT INTO chapters(video_id,title,summary,start_ms,end_ms,order_index) VALUES (?,?,?,?,?,?)",
                )
                .bind(id)
                .bind(chapter.get(0).and_then(Value::as_str).unwrap_or_default())
                .bind(chapter.get(1).and_then(Value::as_str))
                .bind(chapter.get(2).and_then(Value::as_i64).unwrap_or(0))
                .bind(chapter.get(3).and_then(Value::as_i64).unwrap_or(0))
                .bind(chapter.get(4).and_then(Value::as_i64).unwrap_or(0))
                .execute(&mut **tx)
                .await?;
            }
            write_source(tx, id, "Chapters", payload.get("source")).await?;
        }
        "Summary" | "Quiz" | "Mindmap" | "Highlights" => {
            let (table, column) = single_table(&envelope.record_type);
            sqlx::query(&format!(
                "INSERT INTO {table}(video_id,{column},generated_at) VALUES (?,?,?)
                 ON CONFLICT(video_id) DO UPDATE SET {column}=excluded.{column}, generated_at=excluded.generated_at"
            ))
            .bind(id)
            .bind(payload.get("content").and_then(Value::as_str).unwrap_or_default())
            .bind(payload.get("generatedAt").and_then(Value::as_i64).unwrap_or(envelope.updated_at))
            .execute(&mut **tx)
            .await?;
            write_source(tx, id, &envelope.record_type, payload.get("source")).await?;
        }
        COURSE_KNOWLEDGE => {
            // 知识点 id 跨设备保持不变：费曼复述的记录按「concept:<id>」引用它们。
            // 删知识点只会级联删出处（下面整份重写），不会碰到用户自己的东西。
            sqlx::query("DELETE FROM concepts WHERE course_id=?").bind(id).execute(&mut **tx).await?;
            for concept in payload.get("concepts").and_then(Value::as_array).into_iter().flatten() {
                sqlx::query(
                    "INSERT INTO concepts(id,course_id,name,created_at,explanation,explanation_source) VALUES (?,?,?,?,?,?)
                     ON CONFLICT(id) DO UPDATE SET course_id=excluded.course_id, name=excluded.name,
                       created_at=excluded.created_at, explanation=excluded.explanation,
                       explanation_source=excluded.explanation_source",
                )
                .bind(concept.get(0).and_then(Value::as_str).unwrap_or_default())
                .bind(id)
                .bind(concept.get(1).and_then(Value::as_str).unwrap_or_default())
                .bind(concept.get(2).and_then(Value::as_i64).unwrap_or(0))
                .bind(concept.get(3).and_then(Value::as_str))
                .bind(concept.get(4).and_then(Value::as_str))
                .execute(&mut **tx)
                .await?;
            }
            // 出处指向的视频这台设备上可能还没有（还没同步到）：只记有的，等视频到了下一轮整条再来。
            for occurrence in payload.get("occurrences").and_then(Value::as_array).into_iter().flatten() {
                sqlx::query(
                    "INSERT OR IGNORE INTO concept_occurrences(concept_id,video_id,start_ms)
                     SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM videos WHERE id=?) AND EXISTS(SELECT 1 FROM concepts WHERE id=?)",
                )
                .bind(occurrence.get(0).and_then(Value::as_str).unwrap_or_default())
                .bind(occurrence.get(1).and_then(Value::as_str).unwrap_or_default())
                .bind(occurrence.get(2).and_then(Value::as_i64).unwrap_or(0))
                .bind(occurrence.get(1).and_then(Value::as_str).unwrap_or_default())
                .bind(occurrence.get(0).and_then(Value::as_str).unwrap_or_default())
                .execute(&mut **tx)
                .await?;
            }
            match payload.get("overview").filter(|value| !value.is_null()) {
                Some(overview) => {
                    sqlx::query(
                        "INSERT INTO course_knowledge_overviews(course_id,content_json,source_fingerprint,generated_at) VALUES (?,?,?,?)
                         ON CONFLICT(course_id) DO UPDATE SET content_json=excluded.content_json,
                           source_fingerprint=excluded.source_fingerprint, generated_at=excluded.generated_at",
                    )
                    .bind(id)
                    .bind(overview.get("contentJson").and_then(Value::as_str).unwrap_or_default())
                    .bind(overview.get("sourceFingerprint").and_then(Value::as_str).unwrap_or_default())
                    .bind(overview.get("generatedAt").and_then(Value::as_i64).unwrap_or(0))
                    .execute(&mut **tx)
                    .await?;
                }
                None => {
                    sqlx::query("DELETE FROM course_knowledge_overviews WHERE course_id=?")
                        .bind(id)
                        .execute(&mut **tx)
                        .await?;
                }
            }
        }
        _ => return Ok(ContentOutcome::Skipped),
    }
    set_stamp(tx, envelope).await?;
    Ok(ContentOutcome::Applied)
}

/// 合并一条删除信封：对端更新地删掉了（比如清空重来），本地没有更晚的版本就跟着删。
pub async fn delete(tx: &mut Transaction<'_, Sqlite>, envelope: &SyncEnvelope) -> AppResult<ContentOutcome> {
    if !remote_wins(tx, envelope).await? {
        return Ok(ContentOutcome::Skipped);
    }
    let id = envelope.record_id.as_str();
    match envelope.record_type.as_str() {
        "Transcript" => {
            sqlx::query("DELETE FROM transcripts WHERE video_id=?").bind(id).execute(&mut **tx).await?;
        }
        "Chapters" => {
            sqlx::query("DELETE FROM chapters WHERE video_id=?").bind(id).execute(&mut **tx).await?;
            write_source(tx, id, "Chapters", None).await?;
        }
        "Summary" | "Quiz" | "Mindmap" | "Highlights" => {
            let (table, _) = single_table(&envelope.record_type);
            sqlx::query(&format!("DELETE FROM {table} WHERE video_id=?")).bind(id).execute(&mut **tx).await?;
            write_source(tx, id, &envelope.record_type, None).await?;
        }
        COURSE_KNOWLEDGE => {
            sqlx::query("DELETE FROM concepts WHERE course_id=?").bind(id).execute(&mut **tx).await?;
            sqlx::query("DELETE FROM course_knowledge_overviews WHERE course_id=?").bind(id).execute(&mut **tx).await?;
        }
        _ => return Ok(ContentOutcome::Skipped),
    }
    set_stamp(tx, envelope).await?;
    Ok(ContentOutcome::Applied)
}
