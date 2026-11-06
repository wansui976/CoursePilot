//! 云端分段识别的断点缓存：已经识别完、已经付过钱的分片不必因为一次中断就重来。
//!
//! 云端识别是整条流水线上最贵的一步——分钟级的等待，加上真金白银。它内部是分片并发
//! 跑的（一节两小时的课二十多片），而结果直到全部完成才落库。中途退出——用户点停、
//! 应用崩溃、机器休眠被杀——已完成的那十几片连同结果一起丢掉，下次从第一片重来，
//! 钱也再付一遍。
//!
//! 键取**分片音频内容 + 识别参数**的哈希，不是序号。序号会骗人：换了切片长度或者换了
//! 一个视频文件，第 3 片还叫第 3 片，内容却完全不同。按内容取键则：同一段音频重跑必然
//! 命中；源或参数一变键就变，不会拿旧结果冒充新结果。万一 ffmpeg 的分片输出不是逐字节
//! 可复现，最坏也只是命不中，退化成今天的行为——这个失败方向是安全的。

use crate::db::Db;
use crate::error::AppResult;
use crate::pipeline::asr::WhisperJson;
use sha2::{Digest, Sha256};

/// 一次识别期间的分片缓存句柄。`params` 拌进键里，换了热词/后端就不会命中——
/// 否则「改了设置重新处理」会静默地拿回旧结果。
pub struct ChunkCache<'a> {
    pub db: &'a Db,
    pub video_id: &'a str,
    pub params: String,
}

/// 分片音频 + 识别参数的键。
pub fn chunk_key(audio: &[u8], params: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(audio);
    // 分隔符防止「参数末尾的字节」和「音频开头的字节」拼接后产生同一个键。
    hasher.update([0u8]);
    hasher.update(params.as_bytes());
    format!("{:x}", hasher.finalize())
}

impl ChunkCache<'_> {
    /// 这一片之前认过吗？认过就直接用，省一次调用和一次付费。
    ///
    /// 缓存读写一律尽力而为：这里出任何问题都只该退化成「重认一遍」，
    /// 不该让整次识别失败——它是来省钱的，不是来添乱的。
    pub async fn get(&self, audio: &[u8]) -> Option<WhisperJson> {
        let key = chunk_key(audio, &self.params);
        let row: String = sqlx::query_scalar(
            "SELECT transcript_json FROM asr_chunk_results WHERE video_id=? AND chunk_key=?",
        )
        .bind(self.video_id)
        .bind(&key)
        .fetch_optional(&self.db.pool)
        .await
        .ok()
        .flatten()?;
        serde_json::from_str(&row).ok()
    }

    /// 记下这一片的结果，供下次中断后续跑。
    pub async fn put(&self, audio: &[u8], json: &WhisperJson) {
        let Ok(payload) = serde_json::to_string(json) else {
            return;
        };
        let key = chunk_key(audio, &self.params);
        let _ = sqlx::query(
            "INSERT INTO asr_chunk_results(video_id,chunk_key,transcript_json,created_at)
             VALUES (?,?,?,?)
             ON CONFLICT(video_id,chunk_key) DO UPDATE SET
               transcript_json=excluded.transcript_json, created_at=excluded.created_at",
        )
        .bind(self.video_id)
        .bind(&key)
        .bind(&payload)
        .bind(chrono::Utc::now().timestamp_millis())
        .execute(&self.db.pool)
        .await;
        // 结果到手，记着的任务号也就没用了。
        self.clear_pending(audio).await;
    }
}

/// 「已经提交、还没拿到结果」的任务和结果存在同一张表里，键加这个后缀，
/// 结果读取（`get`）解析不了它，不会把它当成文稿。
const PENDING_SUFFIX: &str = ":pending";

#[derive(serde::Serialize, serde::Deserialize)]
struct PendingTask {
    request_id: String,
    resource_id: String,
}

impl ChunkCache<'_> {
    /// 这段音频上次提交过、还没等到结果的任务（request_id, resource_id）。
    ///
    /// 提交成功那一刻钱就付了；之后断网、被限流太久、App 被杀，原来只能整段重新提交、
    /// 再付一次。记下任务号，下次先去问那个任务。
    pub async fn get_pending(&self, audio: &[u8]) -> Option<(String, String)> {
        let key = chunk_key(audio, &self.params) + PENDING_SUFFIX;
        let row: String = sqlx::query_scalar(
            "SELECT transcript_json FROM asr_chunk_results WHERE video_id=? AND chunk_key=?",
        )
        .bind(self.video_id)
        .bind(&key)
        .fetch_optional(&self.db.pool)
        .await
        .ok()
        .flatten()?;
        let task: PendingTask = serde_json::from_str(&row).ok()?;
        Some((task.request_id, task.resource_id))
    }

    pub async fn put_pending(&self, audio: &[u8], request_id: &str, resource_id: &str) {
        let Ok(payload) = serde_json::to_string(&PendingTask {
            request_id: request_id.into(),
            resource_id: resource_id.into(),
        }) else {
            return;
        };
        let key = chunk_key(audio, &self.params) + PENDING_SUFFIX;
        let _ = sqlx::query(
            "INSERT INTO asr_chunk_results(video_id,chunk_key,transcript_json,created_at)
             VALUES (?,?,?,?)
             ON CONFLICT(video_id,chunk_key) DO UPDATE SET
               transcript_json=excluded.transcript_json, created_at=excluded.created_at",
        )
        .bind(self.video_id)
        .bind(&key)
        .bind(&payload)
        .bind(chrono::Utc::now().timestamp_millis())
        .execute(&self.db.pool)
        .await;
    }

    pub async fn clear_pending(&self, audio: &[u8]) {
        let key = chunk_key(audio, &self.params) + PENDING_SUFFIX;
        let _ = sqlx::query("DELETE FROM asr_chunk_results WHERE video_id=? AND chunk_key=?")
            .bind(self.video_id)
            .bind(&key)
            .execute(&self.db.pool)
            .await;
    }
}

/// 整份文稿已经落库，这份中间缓存就该清掉。
///
/// 它只为「这一次识别被打断」而存在。留着的话，用户明确要求「重新处理」时会静默拿回
/// 旧结果——那时他要的恰恰是重认一遍。
pub async fn clear(db: &Db, video_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM asr_chunk_results WHERE video_id=?")
        .bind(video_id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::videos::add_local_video;
    use crate::pipeline::asr::{Offsets, WhisperSegment};
    use tempfile::tempdir;

    async fn seed() -> (Db, String, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course = create_course(&db, "c".into(), dir.path().to_string_lossy().into())
            .await
            .unwrap();
        let path = dir.path().join("v.mp4");
        std::fs::write(&path, b"x").unwrap();
        let video = add_local_video(&db, &course.id, path, None).await.unwrap();
        (db, video.id, dir)
    }

    fn transcript(text: &str) -> WhisperJson {
        WhisperJson {
            transcription: vec![WhisperSegment {
                text: text.into(),
                offsets: Offsets { from: 0, to: 1000 },
                tokens: Vec::new(),
            }],
        }
    }

    #[tokio::test]
    async fn a_chunk_recognized_before_the_interruption_is_reused() {
        // 中断前认完的分片，下次不该再认一遍——那是一次调用加一次付费。
        let (db, video_id, _dir) = seed().await;
        let cache = ChunkCache {
            db: &db,
            video_id: &video_id,
            params: "volcengine|hotwords".into(),
        };
        let audio = b"chunk-0-bytes";

        assert!(cache.get(audio).await.is_none());
        cache.put(audio, &transcript("第一片认出来的话")).await;

        let hit = cache.get(audio).await.expect("应当命中");
        assert_eq!(hit.transcription[0].text, "第一片认出来的话");
    }

    #[tokio::test]
    async fn a_different_chunk_does_not_borrow_another_ones_result() {
        let (db, video_id, _dir) = seed().await;
        let cache = ChunkCache {
            db: &db,
            video_id: &video_id,
            params: "volcengine".into(),
        };
        cache.put(b"chunk-0", &transcript("第一片")).await;

        assert!(cache.get(b"chunk-1").await.is_none());
    }

    #[tokio::test]
    async fn changing_the_recognition_settings_invalidates_the_cache() {
        // 「改了热词重新处理」必须真的重认。按内容取键但不拌参数的话，
        // 用户会静默拿回改设置之前的结果，还以为设置没生效。
        let (db, video_id, _dir) = seed().await;
        let audio = b"same-audio";
        ChunkCache {
            db: &db,
            video_id: &video_id,
            params: "volcengine|旧热词".into(),
        }
        .put(audio, &transcript("旧结果"))
        .await;

        let after_change = ChunkCache {
            db: &db,
            video_id: &video_id,
            params: "volcengine|新热词".into(),
        };
        assert!(after_change.get(audio).await.is_none());
    }

    #[tokio::test]
    async fn the_cache_is_dropped_once_the_transcript_is_stored() {
        // 它只为「这一次被打断」而存在。留着的话，用户明确要求「重新处理」时会
        // 静默拿回旧结果——那时他要的恰恰是重认一遍。
        let (db, video_id, _dir) = seed().await;
        let cache = ChunkCache {
            db: &db,
            video_id: &video_id,
            params: "volcengine".into(),
        };
        cache.put(b"chunk-0", &transcript("认过了")).await;

        clear(&db, &video_id).await.unwrap();

        assert!(cache.get(b"chunk-0").await.is_none());
    }

    #[test]
    fn the_key_cannot_be_collided_by_shifting_the_boundary() {
        // 音频和参数直接拼起来取哈希的话，("ab","c") 和 ("a","bc") 会得到同一个键。
        assert_ne!(chunk_key(b"ab", "c"), chunk_key(b"a", "bc"));
    }

    #[tokio::test]
    async fn a_submitted_task_is_remembered_until_its_result_arrives() {
        let (db, video_id, _dir) = seed().await;
        let cache = ChunkCache {
            db: &db,
            video_id: &video_id,
            params: "volcengine|ctx".into(),
        };
        let audio = b"chunk-bytes";
        assert!(cache.get_pending(audio).await.is_none());
        cache.put_pending(audio, "req-1", "volc.seedasr.auc").await;
        assert_eq!(
            cache.get_pending(audio).await,
            Some(("req-1".to_string(), "volc.seedasr.auc".to_string()))
        );
        // 记着的任务号不会被当成文稿读出来。
        assert!(cache.get(audio).await.is_none());
        // 换了参数（比如热词）就不是同一个任务。
        let other = ChunkCache {
            db: &db,
            video_id: &video_id,
            params: "volcengine|other".into(),
        };
        assert!(other.get_pending(audio).await.is_none());
        // 结果到手后任务号清掉。
        cache.put(audio, &transcript("好")).await;
        assert!(cache.get_pending(audio).await.is_none());
        assert!(cache.get(audio).await.is_some());
    }
}
