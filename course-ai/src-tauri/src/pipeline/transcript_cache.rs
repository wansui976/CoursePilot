//! 讲稿的内存缓存：整门课范围的检索（助手搜课程、课程搜索框含文稿、整门课的文稿搜索）
//! 都要把几百个视频的几十万句讲稿过一遍。
//!
//! 在 SQLite 里逐句 `instr`，一个词元就是一整遍扫描；助手一个问题切出七八个二字组，
//! 400 讲的课要 800 多毫秒。逐行取出来在 Rust 里比也不行：sqlx 每行的开销让取 28 万行要
//! 3 秒。这里按视频一行用 `group_concat` 整段取（400 讲约 300 毫秒），切好留在内存里，
//! 之后同一批视频再搜只要几十毫秒。
//!
//! 什么时候作废：`transcript_revisions` 由触发器维护，讲稿任何一处增删改都会让那个视频的
//! 版本号 +1；每次取用先读一遍版本号，变了的那几个视频重新加载。缓存按「库文件 + 视频」
//! 区分，测试里同一进程开很多个库也不会串。总量有上限，超了先丢最久没用的视频。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use crate::db::Db;
use crate::error::AppResult;

/// 缓存里讲稿文字的大致总量上限（字节）。400 讲约 25 MB；留够几门大课。
const MAX_CACHED_BYTES: usize = 160 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub segment_idx: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    /// 和 `to_lowercase()` 不同时才有（含大写字母的句子），查词时用它，免得每次现转。
    lower: Option<String>,
}

impl Line {
    /// 用来查词的小写文本。
    pub fn lowercase(&self) -> &str {
        self.lower.as_deref().unwrap_or(&self.text)
    }
}

#[derive(Debug, Default)]
pub struct VideoText {
    pub lines: Vec<Line>,
    bytes: usize,
}

struct Entry {
    rev: i64,
    text: Arc<VideoText>,
    last_used: u64,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<(PathBuf, String), Entry>,
    bytes: usize,
    clock: u64,
}

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// `group_concat` 里用的分隔：字段之间 TAB，句子之间换行。正文里的这两个字符先换成空格。
fn parse(blob: &str) -> VideoText {
    let mut lines = Vec::new();
    let mut bytes = 0;
    for row in blob.split('\n') {
        let mut parts = row.splitn(4, '\t');
        let (Some(idx), Some(start), Some(end), Some(text)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let (Ok(segment_idx), Ok(start_ms), Ok(end_ms)) = (idx.parse(), start.parse(), end.parse())
        else {
            continue;
        };
        // 中文讲稿大多没有大写字母：先看一眼，免得每句都复制一份小写。
        let lower = text
            .chars()
            .any(char::is_uppercase)
            .then(|| text.to_lowercase())
            .filter(|lowered| lowered != text);
        bytes += text.len() + lower.as_ref().map_or(0, String::len) + 48;
        lines.push(Line {
            segment_idx,
            start_ms,
            end_ms,
            text: text.to_string(),
            lower,
        });
    }
    VideoText { lines, bytes }
}

/// 取这些视频的讲稿（按句子顺序）。没有讲稿的视频给空的。
pub async fn load(db: &Db, video_ids: &[String]) -> AppResult<HashMap<String, Arc<VideoText>>> {
    if video_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let scope = serde_json::to_string(video_ids)
        .map_err(|error| crate::error::AppError::Other(error.to_string()))?;
    // 先读版本号再读讲稿：两步之间讲稿被改了，存下的是新讲稿配旧版本号，下次只会多加载一次；
    // 反过来就可能把旧讲稿当成新版本永远留着。
    let revs: Vec<(String, i64)> = sqlx::query_as(
        "SELECT s.value, COALESCE(r.rev, 0) FROM json_each(?1) s
         LEFT JOIN transcript_revisions r ON r.video_id = s.value",
    )
    .bind(&scope)
    .fetch_all(&db.pool)
    .await?;
    let db_path = db.path().to_path_buf();

    let mut out = HashMap::with_capacity(revs.len());
    let mut stale: Vec<(String, i64)> = Vec::new();
    {
        let mut cache = cache().lock().unwrap_or_else(|e| e.into_inner());
        cache.clock += 1;
        let now = cache.clock;
        for (id, rev) in revs {
            match cache.entries.get_mut(&(db_path.clone(), id.clone())) {
                Some(entry) if entry.rev == rev => {
                    entry.last_used = now;
                    out.insert(id, entry.text.clone());
                }
                _ => stale.push((id, rev)),
            }
        }
    }
    if stale.is_empty() {
        return Ok(out);
    }

    let stale_scope = serde_json::to_string(&stale.iter().map(|(id, _)| id).collect::<Vec<_>>())
        .map_err(|error| crate::error::AppError::Other(error.to_string()))?;
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT video_id, group_concat(
                    segment_idx || char(9) || start_ms || char(9) || end_ms || char(9)
                    || replace(replace(text, char(10), ' '), char(9), ' '),
                    char(10))
         FROM (SELECT video_id, segment_idx, start_ms, end_ms, text FROM transcripts
               WHERE video_id IN (SELECT value FROM json_each(?1))
               ORDER BY video_id, segment_idx)
         GROUP BY video_id",
    )
    .bind(&stale_scope)
    .fetch_all(&db.pool)
    .await?;
    let mut loaded: HashMap<String, Arc<VideoText>> = rows
        .into_iter()
        .map(|(id, blob)| (id, Arc::new(parse(&blob))))
        .collect();

    let mut cache = cache().lock().unwrap_or_else(|e| e.into_inner());
    let now = cache.clock;
    for (id, rev) in stale {
        let text = loaded.remove(&id).unwrap_or_default();
        let key = (db_path.clone(), id.clone());
        if let Some(old) = cache.entries.remove(&key) {
            cache.bytes -= old.text.bytes;
        }
        cache.bytes += text.bytes;
        cache.entries.insert(
            key,
            Entry {
                rev,
                text: text.clone(),
                last_used: now,
            },
        );
        out.insert(id, text);
    }
    evict(&mut cache, now);
    Ok(out)
}

/// 在后台把这些视频的讲稿读进缓存（已经是最新的不再读）。同一时刻只跑一个，
/// 课程页来回切换不会叠起好几趟加载。
pub fn warm(db: Db, video_ids: Vec<String>) {
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if video_ids.is_empty() || RUNNING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(error) = load(&db, &video_ids).await {
            tracing::debug!(%error, "预读讲稿失败");
        }
        RUNNING.store(false, std::sync::atomic::Ordering::Release);
    });
}

/// 超过上限时丢掉最久没用的；这一轮刚用过的不丢（调用方手里正拿着）。
fn evict(cache: &mut Cache, now: u64) {
    if cache.bytes <= MAX_CACHED_BYTES {
        return;
    }
    let mut candidates: Vec<((PathBuf, String), u64, usize)> = cache
        .entries
        .iter()
        .filter(|(_, entry)| entry.last_used < now)
        .map(|(key, entry)| (key.clone(), entry.last_used, entry.text.bytes))
        .collect();
    candidates.sort_by_key(|(_, last_used, _)| *last_used);
    for (key, _, bytes) in candidates {
        if cache.bytes <= MAX_CACHED_BYTES {
            break;
        }
        cache.entries.remove(&key);
        cache.bytes -= bytes;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db_with_video() -> (Db, String, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course = crate::commands::courses::create_course(&db, "c".into(), String::new())
            .await
            .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at,order_index)
             VALUES (?,?,'t','local','/x.mp4','/d',1,0)",
        )
        .bind(&id)
        .bind(&course.id)
        .execute(&db.pool)
        .await
        .unwrap();
        (db, id, dir)
    }

    async fn line(db: &Db, video: &str, idx: i64, text: &str) {
        sqlx::query(
            "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text) VALUES (?,?,?,?,?)",
        )
        .bind(video)
        .bind(idx)
        .bind(idx * 1000)
        .bind(idx * 1000 + 900)
        .bind(text)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn lines_come_back_in_order_with_tabs_and_newlines_flattened() {
        let (db, video, _dir) = db_with_video().await;
        line(&db, &video, 2, "第三句").await;
        line(&db, &video, 0, "第一句\n换了行").await;
        line(&db, &video, 1, "Gradient\tDescent").await;
        let loaded = load(&db, std::slice::from_ref(&video)).await.unwrap();
        let lines = &loaded[&video].lines;
        let texts: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, ["第一句 换了行", "Gradient Descent", "第三句"]);
        assert_eq!(lines[1].lowercase(), "gradient descent");
        assert_eq!(lines[2].lowercase(), "第三句");
        assert_eq!(
            (lines[2].segment_idx, lines[2].start_ms, lines[2].end_ms),
            (2, 2000, 2900)
        );
    }

    #[tokio::test]
    async fn any_edit_to_a_transcript_is_seen_on_the_next_load() {
        let (db, video, _dir) = db_with_video().await;
        line(&db, &video, 0, "旧的说法").await;
        let first = load(&db, std::slice::from_ref(&video)).await.unwrap();
        assert_eq!(first[&video].lines[0].text, "旧的说法");

        // 没改过：拿到的就是缓存里那一份。
        let again = load(&db, std::slice::from_ref(&video)).await.unwrap();
        assert!(Arc::ptr_eq(&first[&video], &again[&video]));

        sqlx::query("UPDATE transcripts SET text='新的说法' WHERE video_id=?")
            .bind(&video)
            .execute(&db.pool)
            .await
            .unwrap();
        let edited = load(&db, std::slice::from_ref(&video)).await.unwrap();
        assert_eq!(edited[&video].lines[0].text, "新的说法");

        sqlx::query("DELETE FROM transcripts WHERE video_id=?")
            .bind(&video)
            .execute(&db.pool)
            .await
            .unwrap();
        let cleared = load(&db, std::slice::from_ref(&video)).await.unwrap();
        assert!(cleared[&video].lines.is_empty());
    }

    #[tokio::test]
    async fn two_databases_with_the_same_video_id_do_not_share_entries() {
        let (a, video, _da) = db_with_video().await;
        let dir = tempfile::tempdir().unwrap();
        let b = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        line(&a, &video, 0, "库 A").await;
        // B 里没有这个视频的讲稿；版本号同为 0 也不能拿到 A 的缓存。
        load(&a, std::slice::from_ref(&video)).await.unwrap();
        let from_b = load(&b, std::slice::from_ref(&video)).await.unwrap();
        assert!(from_b[&video].lines.is_empty());
    }
}
