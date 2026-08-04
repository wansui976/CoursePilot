//! 同步收方向：把对端设备的信封按合并律并进本地库。
//!
//! 合并律的完整论证在 docs/2026-08-04-sync-merge-laws.md。本文件是它的执行者，
//! 几条不能在注释里省略的骨架：
//!
//! - **每条合并都是半格上的取并**（交换、结合、幂等）。投递是至少一次、乱序、可重复的，
//!   只有这样的合并才能免证收敛：最终状态 = 收到过的所有版本取并，与顺序、重复、
//!   丢失后重传全部无关。
//! - **四种律，不是一条 LWW**：意图字段按（墙钟, 设备）全序后写胜；度量字段有知胜无知；
//!   事件按 id 集合并；卡片排期**不参与合并**——它是复习事件折叠出的物化视图。
//! - **删除按字段分层**：删除态有自己的钟（trash_changed_at），意图编辑不碰它。
//!   于是「A 删、B 改」的结果是带着新内容躺进回收站，双向无损。
//! - **回声抑制必须同事务**：置 1、写入、置回 0 全在一个事务里。跨事务的话，
//!   中途崩溃会让闸门永远关着——此后所有本地修改静默不再外发。

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::envelope::{SyncEnvelope, SyncOperation};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, Transaction};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// 一次 apply 扫描的结果，供状态页与日志用。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ApplyReport {
    /// 真正改动了本地状态的信封数。
    pub applied: usize,
    /// 合并后本地不变（重复投递、本地已更新、删除被忽略）的信封数。
    pub skipped: usize,
    /// 因父记录未到而驻留、留在进件目录等下次的信封数。
    pub parked: usize,
    /// 解析不了或类型不认识、移入 invalid 子目录的文件数。
    pub invalid: usize,
    /// 本次新记录的冲突条数（笔记败方、指纹分歧）。
    pub conflicts: usize,
}

enum Outcome {
    Applied,
    Skipped,
    /// 父记录还没到。信封留在原地，下一轮（本批次或下批次）再试。
    Parked,
}

/// 消化进件目录里的全部数据信封。
///
/// 探针报文（SyncProbe*）不属于这里，原样留给探针引擎；驻留件留在原地由重试兜底
/// ——文件本身就是持久的重试队列，不必再造一个。
pub async fn apply_incoming(
    db: &Db,
    incoming_dir: &Path,
    video_data_root: Option<&Path>,
) -> AppResult<ApplyReport> {
    let own_device = crate::sync::identity::ensure_sync_identity(db)
        .await?
        .device_id;
    let mut report = ApplyReport::default();

    let mut batch: Vec<(PathBuf, SyncEnvelope)> = Vec::new();
    for entry in fs::read_dir(incoming_dir)? {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") || !path.is_file() {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        match serde_json::from_slice::<SyncEnvelope>(&bytes) {
            Ok(envelope) if envelope.record_type.starts_with("SyncProbe") => continue,
            Ok(envelope) if is_supported(&envelope.record_type) => batch.push((path, envelope)),
            _ => {
                quarantine_invalid(incoming_dir, &path)?;
                report.invalid += 1;
            }
        }
    }

    // 父先子后能少驻留几轮；但到达顺序本来就不可假设，排序只是优化，驻留才是正确性。
    batch.sort_by_key(|(_, envelope)| type_rank(&envelope.record_type));

    // 驻留重试：每一整轮有进展就再来一轮，直到不动点。批内「子先于父」由此消化；
    // 父在批外（还没送到）的，文件留在进件目录，下次 apply 再试。
    loop {
        let mut progressed = false;
        let mut still_parked = Vec::new();
        for (path, envelope) in batch {
            match apply_one(db, &own_device, &envelope, video_data_root, &mut report).await? {
                Outcome::Parked => still_parked.push((path, envelope)),
                outcome => {
                    progressed = true;
                    match outcome {
                        Outcome::Applied => report.applied += 1,
                        _ => report.skipped += 1,
                    }
                    match fs::remove_file(&path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error.into()),
                    }
                }
            }
        }
        batch = still_parked;
        if batch.is_empty() || !progressed {
            report.parked = batch.len();
            return Ok(report);
        }
    }
}

fn is_supported(record_type: &str) -> bool {
    matches!(
        record_type,
        "Course" | "Video" | "Note" | "Clip" | "Card" | "StudyEvent" | "VideoProgress"
    )
}

fn type_rank(record_type: &str) -> u8 {
    match record_type {
        "Course" => 0,
        "Video" => 1,
        _ => 2,
    }
}

fn quarantine_invalid(incoming_dir: &Path, path: &Path) -> AppResult<()> {
    let invalid_dir = incoming_dir.join("invalid");
    fs::create_dir_all(&invalid_dir)?;
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "envelope.json".into());
    fs::rename(path, invalid_dir.join(name))?;
    Ok(())
}

/// （墙钟, 设备）字典序的后写胜。两台设备各自比较同一对戳会得出同一个胜者，
/// 这正是 LWW 成为取并的前提。本地戳的设备位在两设备配对下就是本机。
fn remote_newer(remote_ms: i64, remote_device: &str, local_ms: i64, local_device: &str) -> bool {
    (remote_ms, remote_device) > (local_ms, local_device)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// 冲突条目的键取自双方内容，两台设备各自记录会得到同一个 id——重复投递不重复记账。
fn conflict_id(kind: &str, record_id: &str, local: &str, remote: &str) -> String {
    sha256_hex(format!("{kind}\0{record_id}\0{local}\0{remote}").as_bytes())
}

async fn record_conflict(
    tx: &mut Transaction<'_, Sqlite>,
    record_type: &str,
    record_id: &str,
    local_json: &str,
    remote_json: &str,
) -> AppResult<bool> {
    let id = conflict_id(record_type, record_id, local_json, remote_json);
    let result = sqlx::query(
        "INSERT OR IGNORE INTO sync_conflicts(id,record_type,record_id,local_json,remote_json,detected_at)
         VALUES (?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(record_type)
    .bind(record_id)
    .bind(local_json)
    .bind(remote_json)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() > 0)
}

fn payload_str(payload: &Value, key: &str) -> Option<String> {
    payload.get(key)?.as_str().map(str::to_string)
}

fn payload_i64(payload: &Value, key: &str) -> Option<i64> {
    payload.get(key)?.as_i64()
}

async fn apply_one(
    db: &Db,
    own_device: &str,
    envelope: &SyncEnvelope,
    video_data_root: Option<&Path>,
    report: &mut ApplyReport,
) -> AppResult<Outcome> {
    let mut tx = db.pool.begin().await?;
    // 回声抑制：这个事务里的写不进出件队列。置位与复位都在事务内——
    // 中途崩溃即整体回滚，不存在「闸门被留在关着」的中间态。
    sqlx::query("UPDATE sync_apply_guard SET applying=1 WHERE singleton=1")
        .execute(&mut *tx)
        .await?;

    let outcome = match envelope.operation {
        SyncOperation::Delete => apply_delete(&mut tx, envelope).await?,
        SyncOperation::Save => {
            // 墓碑挡道：晚于墓碑的保存是真实的恢复（对端在保管期内点了恢复），
            // 放行并撤碑；不晚于的是过期设备送来的旧内容，丢弃——同一具尸体不许反复诈尸。
            let tombstoned_at: Option<i64> = sqlx::query_scalar(
                "SELECT deleted_at FROM sync_tombstones WHERE record_type=? AND record_id=?",
            )
            .bind(&envelope.record_type)
            .bind(&envelope.record_id)
            .fetch_optional(&mut *tx)
            .await?;
            match tombstoned_at {
                Some(tombstoned_at) if envelope.updated_at <= tombstoned_at => Outcome::Skipped,
                Some(_) => {
                    sqlx::query("DELETE FROM sync_tombstones WHERE record_type=? AND record_id=?")
                        .bind(&envelope.record_type)
                        .bind(&envelope.record_id)
                        .execute(&mut *tx)
                        .await?;
                    apply_save(&mut tx, own_device, envelope, video_data_root, report).await?
                }
                None => apply_save(&mut tx, own_device, envelope, video_data_root, report).await?,
            }
        }
    };

    if matches!(outcome, Outcome::Parked) {
        // 回滚即撤销闸门与一切半途写入。
        tx.rollback().await?;
        return Ok(Outcome::Parked);
    }
    sqlx::query("UPDATE sync_apply_guard SET applying=0 WHERE singleton=1")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(outcome)
}

async fn apply_save(
    tx: &mut Transaction<'_, Sqlite>,
    own_device: &str,
    envelope: &SyncEnvelope,
    video_data_root: Option<&Path>,
    report: &mut ApplyReport,
) -> AppResult<Outcome> {
    match envelope.record_type.as_str() {
        "Course" => save_course(tx, own_device, envelope).await,
        "Video" => save_video(tx, own_device, envelope, video_data_root, report).await,
        "Note" => save_note(tx, own_device, envelope, report).await,
        "Clip" => save_clip(tx, own_device, envelope).await,
        "Card" => save_card(tx, envelope).await,
        "StudyEvent" => save_event(tx, envelope).await,
        "VideoProgress" => save_progress(tx, own_device, envelope).await,
        other => Err(AppError::Config(format!("unsupported sync record {other}"))),
    }
}

// ---------- 删除 ----------

/// 硬删信封是**对回收站状态的确认，不是独立意图**。本地仍在回收站（或早已不存在）
/// 才执行；本地已恢复则忽略——恢复方的保存会回流，对端按「晚于墓碑」的规则复活它。
/// 30 天保管期的价值恰恰是每台设备都有反悔权。
async fn apply_delete(
    tx: &mut Transaction<'_, Sqlite>,
    envelope: &SyncEnvelope,
) -> AppResult<Outcome> {
    let (table, id_column, local_stamp): (&str, &str, Option<i64>) =
        match envelope.record_type.as_str() {
            // 事件是不可变事实，任何删除都不接受。
            "StudyEvent" => return Ok(Outcome::Skipped),
            "Course" | "Video" => {
                let table = if envelope.record_type == "Course" {
                    "courses"
                } else {
                    "videos"
                };
                let row: Option<Option<i64>> =
                    sqlx::query_scalar(&format!("SELECT deleted_at FROM {table} WHERE id=?"))
                        .bind(&envelope.record_id)
                        .fetch_optional(&mut **tx)
                        .await?;
                match row {
                    // 本地存活：忽略确认，不立碑——立了碑会把我们随后的保存挡在对端门外。
                    Some(None) => return Ok(Outcome::Skipped),
                    Some(Some(_)) | None => (table, "id", None),
                }
            }
            // 子记录没有回收站。本地更新（戳更晚）说明用户还在用它，忽略删除，
            // 我们的保存会把它送回对端。
            "Note" => {
                let stamp: Option<(Option<i64>, Option<i64>)> = sqlx::query_as(
                    "SELECT user_edited_at, ai_generated_at FROM notes WHERE video_id=?",
                )
                .bind(&envelope.record_id)
                .fetch_optional(&mut **tx)
                .await?;
                let stamp = stamp.map(|(user, ai)| user.unwrap_or(0).max(ai.unwrap_or(0)));
                ("notes", "video_id", stamp)
            }
            "Clip" => {
                let stamp: Option<i64> =
                    sqlx::query_scalar("SELECT sync_updated_at FROM clips WHERE sync_id=?")
                        .bind(&envelope.record_id)
                        .fetch_optional(&mut **tx)
                        .await?;
                ("clips", "sync_id", stamp)
            }
            "Card" => {
                let stamp: Option<i64> =
                    sqlx::query_scalar("SELECT created_at FROM cards WHERE id=?")
                        .bind(&envelope.record_id)
                        .fetch_optional(&mut **tx)
                        .await?;
                ("cards", "id", stamp)
            }
            "VideoProgress" => {
                let stamp: Option<i64> =
                    sqlx::query_scalar("SELECT updated_at FROM video_progress WHERE video_id=?")
                        .bind(&envelope.record_id)
                        .fetch_optional(&mut **tx)
                        .await?;
                ("video_progress", "video_id", stamp)
            }
            other => return Err(AppError::Config(format!("unsupported sync record {other}"))),
        };

    if let Some(stamp) = local_stamp {
        if stamp > envelope.updated_at {
            return Ok(Outcome::Skipped);
        }
    }
    sqlx::query(&format!("DELETE FROM {table} WHERE {id_column}=?"))
        .bind(&envelope.record_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "INSERT INTO sync_tombstones(record_type,record_id,version_counter,version_device,deleted_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(record_type,record_id) DO UPDATE SET
           version_counter=excluded.version_counter,
           version_device=excluded.version_device,
           deleted_at=MAX(deleted_at, excluded.deleted_at)",
    )
    .bind(&envelope.record_type)
    .bind(&envelope.record_id)
    .bind(envelope.version.counter)
    .bind(&envelope.version.device)
    .bind(envelope.updated_at)
    .execute(&mut **tx)
    .await?;
    Ok(Outcome::Applied)
}

// ---------- 课程 ----------

async fn save_course(
    tx: &mut Transaction<'_, Sqlite>,
    own_device: &str,
    envelope: &SyncEnvelope,
) -> AppResult<Outcome> {
    let payload = &envelope.payload;
    let name = payload_str(payload, "name")
        .ok_or_else(|| AppError::Config("course payload missing name".into()))?;
    let created_at = payload_i64(payload, "createdAt").unwrap_or(envelope.updated_at);
    let updated_at = payload_i64(payload, "updatedAt").unwrap_or(created_at);
    let deleted_at = payload_i64(payload, "deletedAt");
    let trash_at = payload_i64(payload, "trashChangedAt")
        .or(deleted_at)
        .unwrap_or(created_at);

    type LocalCourse = (String, i64, i64, Option<i64>, i64);
    let local: Option<LocalCourse> = sqlx::query_as(
        "SELECT name, created_at, updated_at, deleted_at,
                COALESCE(trash_changed_at, deleted_at, created_at)
         FROM courses WHERE id=?",
    )
    .bind(&envelope.record_id)
    .fetch_optional(&mut **tx)
    .await?;

    let Some((local_name, local_created, local_updated, local_deleted, local_trash_at)) = local
    else {
        // 首次见到：整包落地。root_path 是本机文件系统的事实，同步不携带，占位为空；
        // 用户之后在本机导入时再落到实处。
        sqlx::query(
            "INSERT INTO courses(id,name,root_path,created_at,updated_at,deleted_at,trash_changed_at)
             VALUES (?,?,'',?,?,?,?)",
        )
        .bind(&envelope.record_id)
        .bind(&name)
        .bind(created_at)
        .bind(updated_at)
        .bind(deleted_at)
        .bind(trash_at)
        .execute(&mut **tx)
        .await?;
        return Ok(Outcome::Applied);
    };

    let mut changed = false;
    // 意图组：名字。
    if remote_newer(
        updated_at,
        &envelope.version.device,
        local_updated,
        own_device,
    ) && (local_name != name || local_updated != updated_at)
    {
        sqlx::query("UPDATE courses SET name=?, updated_at=? WHERE id=?")
            .bind(&name)
            .bind(updated_at)
            .bind(&envelope.record_id)
            .execute(&mut **tx)
            .await?;
        changed = true;
    }
    // 创建时间首见即定：取更小值（min 也是取并）。
    if created_at < local_created {
        sqlx::query("UPDATE courses SET created_at=? WHERE id=?")
            .bind(created_at)
            .bind(&envelope.record_id)
            .execute(&mut **tx)
            .await?;
        changed = true;
    }
    // 删除态组：独立的钟。意图编辑赢不走它，它也盖不掉意图编辑。
    if remote_newer(
        trash_at,
        &envelope.version.device,
        local_trash_at,
        own_device,
    ) && (local_deleted != deleted_at || local_trash_at != trash_at)
    {
        sqlx::query("UPDATE courses SET deleted_at=?, trash_changed_at=? WHERE id=?")
            .bind(deleted_at)
            .bind(trash_at)
            .bind(&envelope.record_id)
            .execute(&mut **tx)
            .await?;
        changed = true;
    }
    Ok(if changed {
        Outcome::Applied
    } else {
        Outcome::Skipped
    })
}

// ---------- 视频 ----------

async fn save_video(
    tx: &mut Transaction<'_, Sqlite>,
    own_device: &str,
    envelope: &SyncEnvelope,
    video_data_root: Option<&Path>,
    report: &mut ApplyReport,
) -> AppResult<Outcome> {
    let payload = &envelope.payload;
    let course_id = payload_str(payload, "courseID")
        .ok_or_else(|| AppError::Config("video payload missing courseID".into()))?;
    let course_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM courses WHERE id=?)")
        .bind(&course_id)
        .fetch_one(&mut **tx)
        .await?;
    if !course_exists {
        return Ok(Outcome::Parked);
    }

    let title = payload_str(payload, "title")
        .ok_or_else(|| AppError::Config("video payload missing title".into()))?;
    let source_type = payload_str(payload, "sourceType").unwrap_or_else(|| "local".into());
    let source_uri = payload_str(payload, "sourceURI");
    let fingerprint = payload_str(payload, "contentFingerprint");
    let duration_ms = payload_i64(payload, "durationMs");
    let order_index = payload_i64(payload, "orderIndex").unwrap_or(0);
    let created_at = payload_i64(payload, "createdAt").unwrap_or(envelope.updated_at);
    let updated_at = payload_i64(payload, "updatedAt")
        .filter(|value| *value > 0)
        .unwrap_or(created_at);
    let deleted_at = payload_i64(payload, "deletedAt");
    let trash_at = payload_i64(payload, "trashChangedAt")
        .or(deleted_at)
        .unwrap_or(created_at);

    type LocalVideo = (
        String,
        String,
        i64,
        Option<i64>,
        Option<String>,
        Option<i64>,
        i64,
        i64,
        i64,
    );
    let local: Option<LocalVideo> = sqlx::query_as(
        "SELECT title, course_id, order_index, duration_ms, content_fingerprint,
                deleted_at,
                CASE WHEN sync_updated_at>0 THEN sync_updated_at ELSE created_at END,
                COALESCE(trash_changed_at, deleted_at, created_at),
                created_at
         FROM videos WHERE id=?",
    )
    .bind(&envelope.record_id)
    .fetch_optional(&mut **tx)
    .await?;

    let Some(local) = local else {
        // 占位行：记录是完全体，只缺媒体。file_path 留空 = 「此设备上没有媒体文件」，
        // 播放之外一切可用；之后导入指纹相同的文件时挂接到这一行，而不是新建。
        let data_dir = video_data_root
            .map(|root| {
                crate::storage::video_data_dir(Path::new(""), &envelope.record_id, Some(root))
            })
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,source_uri,file_path,
                                duration_ms,order_index,data_dir,processed_status,created_at,
                                deleted_at,content_fingerprint,sync_updated_at,trash_changed_at)
             VALUES (?,?,?,?,?,'',?,?,?,'pending',?,?,?,?,?)",
        )
        .bind(&envelope.record_id)
        .bind(&course_id)
        .bind(&title)
        .bind(&source_type)
        .bind(&source_uri)
        .bind(duration_ms)
        .bind(order_index)
        .bind(&data_dir)
        .bind(created_at)
        .bind(deleted_at)
        .bind(&fingerprint)
        .bind(updated_at)
        .bind(trash_at)
        .execute(&mut **tx)
        .await?;
        return Ok(Outcome::Applied);
    };
    let (
        local_title,
        local_course,
        local_order,
        local_duration,
        local_fingerprint,
        local_deleted,
        local_updated,
        local_trash_at,
        _local_created,
    ) = local;

    let mut changed = false;
    // 意图组：标题、归属、排序一起走。
    if remote_newer(
        updated_at,
        &envelope.version.device,
        local_updated,
        own_device,
    ) && (local_title != title || local_course != course_id || local_order != order_index)
    {
        sqlx::query(
            "UPDATE videos SET title=?, course_id=?, order_index=?, sync_updated_at=? WHERE id=?",
        )
        .bind(&title)
        .bind(&course_id)
        .bind(order_index)
        .bind(updated_at)
        .bind(&envelope.record_id)
        .execute(&mut **tx)
        .await?;
        changed = true;
    }
    // 度量组：有知胜无知。没媒体的设备改个标题，不能把「空时长」一并盖过来。
    if local_duration.is_none() {
        if let Some(duration) = duration_ms {
            sqlx::query("UPDATE videos SET duration_ms=? WHERE id=?")
                .bind(duration)
                .bind(&envelope.record_id)
                .execute(&mut **tx)
                .await?;
            changed = true;
        }
    }
    match (&local_fingerprint, &fingerprint) {
        (None, Some(remote_fp)) => {
            sqlx::query("UPDATE videos SET content_fingerprint=? WHERE id=?")
                .bind(remote_fp)
                .bind(&envelope.record_id)
                .execute(&mut **tx)
                .await?;
            changed = true;
        }
        (Some(local_fp), Some(remote_fp)) if local_fp != remote_fp => {
            // 两台设备在同一条记录名下放着不同的文件。度量保持本地（各自描述各自的文件），
            // 分歧显式记账，不静默扶正任何一方。
            let recorded = record_conflict(
                tx,
                "VideoFingerprint",
                &envelope.record_id,
                local_fp,
                remote_fp,
            )
            .await?;
            if recorded {
                report.conflicts += 1;
            }
        }
        _ => {}
    }
    // 删除态组。
    if remote_newer(
        trash_at,
        &envelope.version.device,
        local_trash_at,
        own_device,
    ) && (local_deleted != deleted_at || local_trash_at != trash_at)
    {
        sqlx::query("UPDATE videos SET deleted_at=?, trash_changed_at=? WHERE id=?")
            .bind(deleted_at)
            .bind(trash_at)
            .bind(&envelope.record_id)
            .execute(&mut **tx)
            .await?;
        changed = true;
    }
    Ok(if changed {
        Outcome::Applied
    } else {
        Outcome::Skipped
    })
}

// ---------- 笔记 ----------

/// 笔记是唯一「双方都可能是大段人写内容」的记录，两条额外的规矩：
///
/// 1. **人恒胜机器，无论墙钟先后**。一台设备的流水线自动重生成是机器行为，
///    不得覆盖另一台上人的编辑。
/// 2. **并发的人写内容绝不静默丢**。基准（上次与对端一致时的内容指纹）判并发：
///    本地当前内容偏离基准 = 本地在此之后改过，此时接受更新的远端，
///    但把本地全文存进冲突表——败方在写它的那台设备上被保全。
async fn save_note(
    tx: &mut Transaction<'_, Sqlite>,
    own_device: &str,
    envelope: &SyncEnvelope,
    report: &mut ApplyReport,
) -> AppResult<Outcome> {
    let payload = &envelope.payload;
    let video_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM videos WHERE id=?)")
        .bind(&envelope.record_id)
        .fetch_one(&mut **tx)
        .await?;
    if !video_exists {
        return Ok(Outcome::Parked);
    }

    let content_json = payload_str(payload, "contentJson");
    let content_md = payload_str(payload, "contentMd");
    let remote_ai = payload_i64(payload, "aiGeneratedAt");
    let remote_user = payload_i64(payload, "userEditedAt");
    let remote_stamp = remote_user.unwrap_or(0).max(remote_ai.unwrap_or(0)).max(
        if remote_user.is_none() && remote_ai.is_none() {
            envelope.updated_at
        } else {
            0
        },
    );

    type LocalNote = (Option<String>, Option<String>, Option<i64>, Option<i64>);
    let local: Option<LocalNote> = sqlx::query_as(
        "SELECT content_json, content_md, ai_generated_at, user_edited_at FROM notes WHERE video_id=?",
    )
    .bind(&envelope.record_id)
    .fetch_optional(&mut **tx)
    .await?;

    async fn take(
        tx: &mut Transaction<'_, Sqlite>,
        record_id: &str,
        content_json: Option<&str>,
        content_md: Option<&str>,
        remote_ai: Option<i64>,
        remote_user: Option<i64>,
    ) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO notes(video_id,content_json,content_md,ai_generated_at,user_edited_at)
             VALUES (?,?,?,?,?)
             ON CONFLICT(video_id) DO UPDATE SET
               content_json=excluded.content_json, content_md=excluded.content_md,
               ai_generated_at=excluded.ai_generated_at, user_edited_at=excluded.user_edited_at",
        )
        .bind(record_id)
        .bind(content_json)
        .bind(content_md)
        .bind(remote_ai)
        .bind(remote_user)
        .execute(&mut **tx)
        .await?;
        Ok(())
    }

    let Some((local_json, local_md, local_ai, local_user)) = local else {
        take(
            tx,
            &envelope.record_id,
            content_json.as_deref(),
            content_md.as_deref(),
            remote_ai,
            remote_user,
        )
        .await?;
        update_note_basis(tx, envelope).await?;
        return Ok(Outcome::Applied);
    };

    // 层级：人写过的恒高于纯机器产物。
    let local_stratum = local_user.is_some();
    let remote_stratum = remote_user.is_some();
    if remote_stratum && !local_stratum {
        take(
            tx,
            &envelope.record_id,
            content_json.as_deref(),
            content_md.as_deref(),
            remote_ai,
            remote_user,
        )
        .await?;
        update_note_basis(tx, envelope).await?;
        return Ok(Outcome::Applied);
    }
    if local_stratum && !remote_stratum {
        return Ok(Outcome::Skipped);
    }

    // 同层：全序 LWW。
    let local_stamp = local_user.unwrap_or(0).max(local_ai.unwrap_or(0));
    if !remote_newer(
        remote_stamp,
        &envelope.version.device,
        local_stamp,
        own_device,
    ) {
        return Ok(Outcome::Skipped);
    }

    // 人写对人写、远端更新才走到这。基准判并发：偏离基准 = 本地在上次一致之后也改过。
    if local_stratum {
        let local_payload = crate::sync::outbox::payload_for(tx, "Note", &envelope.record_id)
            .await?
            .map(|value| value.to_string())
            .unwrap_or_default();
        let local_hash = sha256_hex(local_payload.as_bytes());
        let basis: Option<String> = sqlx::query_scalar(
            "SELECT content_hash FROM sync_apply_basis WHERE record_type='Note' AND record_id=?",
        )
        .bind(&envelope.record_id)
        .fetch_optional(&mut **tx)
        .await?
        .flatten();
        let same_content = local_json == content_json && local_md == content_md;
        let diverged = basis.as_deref() != Some(local_hash.as_str());
        if diverged
            && !same_content
            && record_conflict(
                tx,
                "Note",
                &envelope.record_id,
                &local_payload,
                &envelope.payload.to_string(),
            )
            .await?
        {
            report.conflicts += 1;
        }
    }
    take(
        tx,
        &envelope.record_id,
        content_json.as_deref(),
        content_md.as_deref(),
        remote_ai,
        remote_user,
    )
    .await?;
    update_note_basis(tx, envelope).await?;
    Ok(Outcome::Applied)
}

/// 并入远端后，远端内容成为新的「上次一致」。
async fn update_note_basis(
    tx: &mut Transaction<'_, Sqlite>,
    envelope: &SyncEnvelope,
) -> AppResult<()> {
    upsert_basis(
        tx,
        "Note",
        &envelope.record_id,
        envelope.updated_at,
        Some(&sha256_hex(envelope.payload.to_string().as_bytes())),
    )
    .await
}

pub(crate) async fn upsert_basis(
    tx: &mut Transaction<'_, Sqlite>,
    record_type: &str,
    record_id: &str,
    stamp_ms: i64,
    content_hash: Option<&str>,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO sync_apply_basis(record_type,record_id,stamp_ms,content_hash)
         VALUES (?,?,?,?)
         ON CONFLICT(record_type,record_id) DO UPDATE SET
           stamp_ms=excluded.stamp_ms, content_hash=excluded.content_hash",
    )
    .bind(record_type)
    .bind(record_id)
    .bind(stamp_ms)
    .bind(content_hash)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

// ---------- 片段 ----------

async fn save_clip(
    tx: &mut Transaction<'_, Sqlite>,
    own_device: &str,
    envelope: &SyncEnvelope,
) -> AppResult<Outcome> {
    let payload = &envelope.payload;
    let video_id = payload_str(payload, "videoID")
        .ok_or_else(|| AppError::Config("clip payload missing videoID".into()))?;
    let video_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM videos WHERE id=?)")
        .bind(&video_id)
        .fetch_one(&mut **tx)
        .await?;
    if !video_exists {
        return Ok(Outcome::Parked);
    }
    let start_ms = payload_i64(payload, "startMs").unwrap_or(0);
    let end_ms = payload_i64(payload, "endMs").unwrap_or(0);
    let note = payload_str(payload, "note").unwrap_or_default();
    let created_at = payload_i64(payload, "createdAt").unwrap_or(envelope.updated_at);
    let updated_at = payload_i64(payload, "updatedAt").unwrap_or(created_at);

    let local: Option<i64> =
        sqlx::query_scalar("SELECT sync_updated_at FROM clips WHERE sync_id=?")
            .bind(&envelope.record_id)
            .fetch_optional(&mut **tx)
            .await?;
    match local {
        None => {
            sqlx::query(
                "INSERT INTO clips(video_id,start_ms,end_ms,note,created_at,sync_id,sync_updated_at)
                 VALUES (?,?,?,?,?,?,?)",
            )
            .bind(&video_id)
            .bind(start_ms)
            .bind(end_ms)
            .bind(&note)
            .bind(created_at)
            .bind(&envelope.record_id)
            .bind(updated_at)
            .execute(&mut **tx)
            .await?;
            Ok(Outcome::Applied)
        }
        Some(local_stamp)
            if remote_newer(
                updated_at,
                &envelope.version.device,
                local_stamp,
                own_device,
            ) =>
        {
            sqlx::query(
                "UPDATE clips SET video_id=?, start_ms=?, end_ms=?, note=?, sync_updated_at=?
                 WHERE sync_id=?",
            )
            .bind(&video_id)
            .bind(start_ms)
            .bind(end_ms)
            .bind(&note)
            .bind(updated_at)
            .bind(&envelope.record_id)
            .execute(&mut **tx)
            .await?;
            Ok(Outcome::Applied)
        }
        Some(_) => Ok(Outcome::Skipped),
    }
}

// ---------- 记忆卡 ----------

/// 卡片信封只有身份内容，**排期状态不在里面，也永远不从信封写**——
/// 排期是本地由事件折叠出的物化视图（下方 `refold_card`）。这不是省事，
/// 是矛盾在构造上不可能的根基：两台各复习一次，事件并集后各自重折，
/// 双方都得到包含两次复习的同一排期，不丢任何一方。
async fn save_card(
    tx: &mut Transaction<'_, Sqlite>,
    envelope: &SyncEnvelope,
) -> AppResult<Outcome> {
    let payload = &envelope.payload;
    let video_id = payload_str(payload, "videoID");
    if let Some(video_id) = &video_id {
        let video_exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM videos WHERE id=?)")
                .bind(video_id)
                .fetch_one(&mut **tx)
                .await?;
        if !video_exists {
            return Ok(Outcome::Parked);
        }
    }
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cards WHERE id=?)")
        .bind(&envelope.record_id)
        .fetch_one(&mut **tx)
        .await?;
    if exists {
        // 卡片内容没有编辑入口，同 id 再来即重复投递。
        return Ok(Outcome::Skipped);
    }
    let created_at = payload_i64(payload, "createdAt").unwrap_or(envelope.updated_at);
    sqlx::query(
        "INSERT INTO cards(id,video_id,course_id,kind,front,back,source_ms,created_at)
         VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(&envelope.record_id)
    .bind(&video_id)
    .bind(payload_str(payload, "courseID"))
    .bind(payload_str(payload, "kind").unwrap_or_else(|| "qa".into()))
    .bind(payload_str(payload, "front").unwrap_or_default())
    .bind(payload_str(payload, "back").unwrap_or_default())
    .bind(payload_i64(payload, "sourceMs"))
    .bind(created_at)
    .execute(&mut **tx)
    .await?;
    // 种子排期与本地建卡一致；随后立即按已有事件重折——
    // 复习事件完全可能先于卡片到达（事件对视频无外键，不驻留）。
    sqlx::query(
        "INSERT INTO card_schedule(card_id,due_at,ease,interval_days,reps,lapses,last_reviewed,stability,difficulty)
         VALUES (?,?,0,0,0,0,NULL,0,0)",
    )
    .bind(&envelope.record_id)
    .bind(created_at)
    .execute(&mut **tx)
    .await?;
    refold_card(tx, &envelope.record_id, created_at).await?;
    Ok(Outcome::Applied)
}

// ---------- 学习事件 ----------

async fn save_event(
    tx: &mut Transaction<'_, Sqlite>,
    envelope: &SyncEnvelope,
) -> AppResult<Outcome> {
    let payload = &envelope.payload;
    let kind = payload_str(payload, "kind")
        .ok_or_else(|| AppError::Config("event payload missing kind".into()))?;
    let meta_json = payload_str(payload, "metaJson").unwrap_or_else(|| "{}".into());
    // 按事件 id 取集合并：已有即重复投递，没有即插入。事件对课程/视频无外键，
    // 先于它们到达也直接落地。
    let inserted = sqlx::query(
        "INSERT OR IGNORE INTO study_events(kind,course_id,video_id,ts,duration_ms,meta_json,event_id)
         VALUES (?,?,?,?,?,?,?)",
    )
    .bind(&kind)
    .bind(payload_str(payload, "courseID"))
    .bind(payload_str(payload, "videoID"))
    .bind(payload_i64(payload, "ts").unwrap_or(envelope.updated_at))
    .bind(payload_i64(payload, "durationMs").unwrap_or(0))
    .bind(&meta_json)
    .bind(&envelope.record_id)
    .execute(&mut **tx)
    .await?
    .rows_affected()
        > 0;
    if !inserted {
        return Ok(Outcome::Skipped);
    }
    // C4：并入了这张卡的新事实，同一事务内重折它的排期视图。
    if kind == "review" || kind == BASELINE_KIND {
        if let Some(card_id) = card_id_of_meta(&meta_json) {
            let created_at: Option<i64> =
                sqlx::query_scalar("SELECT created_at FROM cards WHERE id=?")
                    .bind(&card_id)
                    .fetch_optional(&mut **tx)
                    .await?;
            // 卡还没到就不折；卡到达时会自己折一遍，事实不会丢。
            if let Some(created_at) = created_at {
                refold_card(tx, &card_id, created_at).await?;
            }
        }
    }
    Ok(Outcome::Applied)
}

// ---------- 观看进度 ----------

async fn save_progress(
    tx: &mut Transaction<'_, Sqlite>,
    own_device: &str,
    envelope: &SyncEnvelope,
) -> AppResult<Outcome> {
    let payload = &envelope.payload;
    let video_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM videos WHERE id=?)")
        .bind(&envelope.record_id)
        .fetch_one(&mut **tx)
        .await?;
    if !video_exists {
        return Ok(Outcome::Parked);
    }
    let position_ms = payload_i64(payload, "positionMs").unwrap_or(0);
    let duration_ms = payload_i64(payload, "durationMs");
    let updated_at = payload_i64(payload, "updatedAt").unwrap_or(envelope.updated_at);

    let local: Option<(i64, Option<i64>)> =
        sqlx::query_as("SELECT updated_at, duration_ms FROM video_progress WHERE video_id=?")
            .bind(&envelope.record_id)
            .fetch_optional(&mut **tx)
            .await?;
    match local {
        None => {
            sqlx::query(
                "INSERT INTO video_progress(video_id,position_ms,duration_ms,updated_at)
                 VALUES (?,?,?,?)",
            )
            .bind(&envelope.record_id)
            .bind(position_ms)
            .bind(duration_ms)
            .bind(updated_at)
            .execute(&mut **tx)
            .await?;
            Ok(Outcome::Applied)
        }
        Some((local_stamp, local_duration)) => {
            let mut changed = false;
            // 续播点是「我最后看到哪」，不是单调量：用户故意回退重看时，取 max 会把他弹回去。
            if remote_newer(
                updated_at,
                &envelope.version.device,
                local_stamp,
                own_device,
            ) {
                sqlx::query(
                    "UPDATE video_progress SET position_ms=?, updated_at=? WHERE video_id=?",
                )
                .bind(position_ms)
                .bind(updated_at)
                .bind(&envelope.record_id)
                .execute(&mut **tx)
                .await?;
                changed = true;
            }
            if local_duration.is_none() {
                if let Some(duration) = duration_ms {
                    sqlx::query("UPDATE video_progress SET duration_ms=? WHERE video_id=?")
                        .bind(duration)
                        .bind(&envelope.record_id)
                        .execute(&mut **tx)
                        .await?;
                    changed = true;
                }
            }
            Ok(if changed {
                Outcome::Applied
            } else {
                Outcome::Skipped
            })
        }
    }
}

// ---------- 排期折叠（卡片 × 事件一致性契约的执行处） ----------

pub(crate) const BASELINE_KIND: &str = "srs_baseline";

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ScheduleState {
    pub stability: f64,
    pub difficulty: f64,
    pub interval_days: i64,
    pub reps: i64,
    pub lapses: i64,
    pub last_reviewed: Option<i64>,
    pub due_at: i64,
}

impl ScheduleState {
    fn fresh(created_at: i64) -> Self {
        // 与本地建卡的种子排期一字不差。
        Self {
            stability: 0.0,
            difficulty: 0.0,
            interval_days: 0,
            reps: 0,
            lapses: 0,
            last_reviewed: None,
            due_at: created_at,
        }
    }
}

/// 一次复习的状态递推——与 `review_card` 的增量更新是同一套公式的同一种执行。
/// 这条等式（增量 ≡ 重放）由测试钉死；改任何一边而不改另一边，测试会红。
pub(crate) fn step_review(state: &mut ScheduleState, rating: i64, ts: i64) {
    use crate::commands::srs::{fsrs_review, interval_days_for, DAY_MS};
    let prev = if state.stability > 0.0 && state.last_reviewed.is_some() {
        Some((state.stability, state.difficulty))
    } else {
        None
    };
    let elapsed_days = state
        .last_reviewed
        .map(|last| ((ts - last) as f64 / DAY_MS as f64).max(0.0))
        .unwrap_or(0.0);
    let (stability, difficulty) = fsrs_review(prev, rating, elapsed_days);
    let interval = interval_days_for(stability);
    state.due_at = if rating <= 1 {
        ts + 60_000
    } else {
        ts + interval * DAY_MS
    };
    state.reps = if rating <= 1 { 0 } else { state.reps + 1 };
    state.lapses = if rating <= 1 {
        state.lapses + 1
    } else {
        state.lapses
    };
    state.stability = stability;
    state.difficulty = difficulty;
    state.interval_days = interval;
    state.last_reviewed = Some(ts);
}

fn card_id_of_meta(meta_json: &str) -> Option<String> {
    let value: Value = serde_json::from_str(meta_json).ok()?;
    Some(value.get("cardId")?.as_str()?.to_string())
}

fn baseline_state(meta_json: &str) -> Option<ScheduleState> {
    let value: Value = serde_json::from_str(meta_json).ok()?;
    Some(ScheduleState {
        stability: value.get("stability")?.as_f64()?,
        difficulty: value.get("difficulty")?.as_f64()?,
        interval_days: value.get("intervalDays")?.as_i64()?,
        reps: value.get("reps")?.as_i64()?,
        lapses: value.get("lapses")?.as_i64()?,
        last_reviewed: value.get("lastReviewed").and_then(Value::as_i64),
        due_at: value.get("dueAt")?.as_i64()?,
    })
}

/// 折叠：以全序最新的基线为种子（没有则从建卡态起），把其后的复习按
/// （时刻, 事件 id）升序递推。晚到的中间事件会改写其后每一步——这不是异常，
/// 是真实交错的正确结果；外在表现只是同步后到期日可能移动。
pub(crate) async fn fold_schedule(
    tx: &mut Transaction<'_, Sqlite>,
    card_id: &str,
    card_created_at: i64,
) -> AppResult<ScheduleState> {
    let rows: Vec<(i64, String, String, String)> = sqlx::query_as(
        "SELECT ts, COALESCE(event_id, CAST(id AS TEXT)), kind, meta_json
         FROM study_events WHERE kind IN ('review', ?)
         ORDER BY ts, COALESCE(event_id, CAST(id AS TEXT))",
    )
    .bind(BASELINE_KIND)
    .fetch_all(&mut **tx)
    .await?;

    let mine: Vec<&(i64, String, String, String)> = rows
        .iter()
        .filter(|(_, _, _, meta)| card_id_of_meta(meta).as_deref() == Some(card_id))
        .collect();
    let seed_index = mine
        .iter()
        .rposition(|(_, _, kind, meta)| kind == BASELINE_KIND && baseline_state(meta).is_some());

    let mut state = match seed_index {
        Some(index) => baseline_state(&mine[index].3).expect("checked above"),
        None => ScheduleState::fresh(card_created_at),
    };
    for (ts, _, kind, meta) in mine
        .into_iter()
        .skip(seed_index.map_or(0, |index| index + 1))
    {
        if kind != "review" {
            continue;
        }
        let Some((_, rating)) = crate::commands::srs::parse_review_meta(meta) else {
            continue;
        };
        step_review(&mut state, rating, *ts);
    }
    Ok(state)
}

async fn refold_card(
    tx: &mut Transaction<'_, Sqlite>,
    card_id: &str,
    card_created_at: i64,
) -> AppResult<()> {
    let state = fold_schedule(tx, card_id, card_created_at).await?;
    sqlx::query(
        "INSERT INTO card_schedule(card_id,due_at,ease,interval_days,reps,lapses,last_reviewed,stability,difficulty)
         VALUES (?,?,0,?,?,?,?,?,?)
         ON CONFLICT(card_id) DO UPDATE SET
           due_at=excluded.due_at, interval_days=excluded.interval_days, reps=excluded.reps,
           lapses=excluded.lapses, last_reviewed=excluded.last_reviewed,
           stability=excluded.stability, difficulty=excluded.difficulty",
    )
    .bind(card_id)
    .bind(state.due_at)
    .bind(state.interval_days)
    .bind(state.reps)
    .bind(state.lapses)
    .bind(state.last_reviewed)
    .bind(state.stability)
    .bind(state.difficulty)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// 首次开启同步时的一次性垫层：把「事件重放无法复现」的历史钉成基线事件。
///
/// 两类对不上：早于事件日志的复习，和排程算法从 SM-2 换代时保留到期日、清零稳定度的
/// 存量卡。对每张「当前排期 ≠ 本地折叠」的卡落一条不可变基线，内容为该卡此刻的完整
/// 排期。基线随事件一同外发（此函数在闸门 0 时调用，插入自然入队）。幂等：
/// 折叠已对上的卡什么都不落，重复调用不再新增。
pub async fn ensure_srs_baselines(db: &Db, now: i64) -> AppResult<usize> {
    type ScheduledCard = (String, i64, Option<String>, Option<String>);
    let cards: Vec<ScheduledCard> = sqlx::query_as(
        "SELECT c.id, c.created_at, c.course_id, c.video_id
         FROM cards c JOIN card_schedule s ON s.card_id = c.id",
    )
    .fetch_all(&db.pool)
    .await?;

    let mut emitted = 0usize;
    for (card_id, created_at, course_id, video_id) in cards {
        let mut tx = db.pool.begin().await?;
        let folded = fold_schedule(&mut tx, &card_id, created_at).await?;
        type ScheduleRow = (f64, f64, i64, i64, i64, Option<i64>, i64);
        let current: Option<ScheduleRow> = sqlx::query_as(
            "SELECT stability, difficulty, interval_days, reps, lapses, last_reviewed, due_at
             FROM card_schedule WHERE card_id=?",
        )
        .bind(&card_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((stability, difficulty, interval_days, reps, lapses, last_reviewed, due_at)) =
            current
        else {
            tx.rollback().await?;
            continue;
        };
        let current = ScheduleState {
            stability,
            difficulty,
            interval_days,
            reps,
            lapses,
            last_reviewed,
            due_at,
        };
        if current == folded {
            tx.rollback().await?;
            continue;
        }
        let meta = serde_json::json!({
            "cardId": card_id,
            "stability": current.stability,
            "difficulty": current.difficulty,
            "intervalDays": current.interval_days,
            "reps": current.reps,
            "lapses": current.lapses,
            "lastReviewed": current.last_reviewed,
            "dueAt": current.due_at,
        });
        sqlx::query(
            "INSERT INTO study_events(kind,course_id,video_id,ts,duration_ms,meta_json,event_id)
             VALUES (?,?,?,?,0,?,?)",
        )
        .bind(BASELINE_KIND)
        .bind(&course_id)
        .bind(&video_id)
        .bind(now)
        .bind(meta.to_string())
        .bind(uuid::Uuid::new_v4().to_string())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        emitted += 1;
    }
    Ok(emitted)
}

/// 外发被对端云端确认后，被确认的内容成为新的「上次一致」基准（目前只有笔记用它）。
/// 只在确认真的清掉出件项时调用——版本不匹配的过期确认说明本地又改过了，
/// 那时当前内容不是达成一致的内容。
pub async fn record_acked_note_basis(db: &Db, record_id: &str, stamp_ms: i64) -> AppResult<()> {
    let mut tx = db.pool.begin().await?;
    let payload = crate::sync::outbox::payload_for(&mut tx, "Note", record_id).await?;
    let Some(payload) = payload else {
        tx.rollback().await?;
        return Ok(());
    };
    let hash = sha256_hex(payload.to_string().as_bytes());
    upsert_basis(&mut tx, "Note", record_id, stamp_ms, Some(&hash)).await?;
    tx.commit().await?;
    Ok(())
}

/// 收方向对外的一个小自检：进件目录里驻留件涉及哪些还没到的父记录。
/// 状态页可以据此把「卡住了」说成人话。
pub fn parked_parents(envelopes: &[SyncEnvelope]) -> BTreeSet<String> {
    envelopes
        .iter()
        .filter_map(|envelope| match envelope.record_type.as_str() {
            "Video" => payload_str(&envelope.payload, "courseID").map(|id| format!("Course:{id}")),
            "Note" | "VideoProgress" => Some(format!("Video:{}", envelope.record_id)),
            "Clip" | "Card" => {
                payload_str(&envelope.payload, "videoID").map(|id| format!("Video:{id}"))
            }
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::srs::{add_manual_card, review_card};
    use crate::commands::videos::add_local_video;
    use crate::sync::envelope::SyncVersion;
    use crate::sync::identity::ensure_sync_identity;
    use crate::sync::outbox::materialize_batch;
    use serde_json::json;
    use tempfile::tempdir;

    /// 一台「设备」：独立的库 + 自己的进件目录。
    async fn device() -> (Db, tempfile::TempDir, PathBuf) {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("device.db"))
            .await
            .unwrap();
        ensure_sync_identity(&db).await.unwrap();
        let incoming = dir.path().join("incoming");
        fs::create_dir_all(&incoming).unwrap();
        (db, dir, incoming)
    }

    async fn seed_video(db: &Db, dir: &Path) -> (String, String) {
        let course = create_course(db, "线代".into(), dir.to_string_lossy().into())
            .await
            .unwrap();
        let path = dir.join(format!("{}.mp4", uuid::Uuid::new_v4()));
        fs::write(&path, b"x").unwrap();
        let video = add_local_video(db, &course.id, path, None).await.unwrap();
        (course.id, video.id)
    }

    fn write_envelope(incoming: &Path, name: &str, envelope: &SyncEnvelope) {
        fs::write(
            incoming.join(format!("{name}.json")),
            serde_json::to_vec(envelope).unwrap(),
        )
        .unwrap();
    }

    /// 把 B 的全部待外发搬进 A 的进件目录并 apply——一次「单向同步」。
    async fn ship(from: &Db, to: &Db, incoming: &Path) -> ApplyReport {
        let envelopes = materialize_batch(from, 500).await.unwrap();
        for (index, envelope) in envelopes.iter().enumerate() {
            write_envelope(incoming, &format!("{index:03}"), envelope);
        }
        // 清出件（相当于对端确认收货），下次 ship 只带新变化。
        for envelope in &envelopes {
            crate::sync::outbox::acknowledge(
                from,
                &envelope.record_type,
                &envelope.record_id,
                &envelope.version,
                None,
            )
            .await
            .unwrap();
        }
        apply_incoming(to, incoming, None).await.unwrap()
    }

    fn envelope(
        record_type: &str,
        record_id: &str,
        operation: SyncOperation,
        updated_at: i64,
        payload: Value,
    ) -> SyncEnvelope {
        SyncEnvelope::new(
            record_type.into(),
            record_id.into(),
            operation,
            SyncVersion {
                counter: 1,
                device: "peer-device".into(),
            },
            updated_at,
            payload,
        )
    }

    async fn outbox_count(db: &Db) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_outbox")
            .fetch_one(&db.pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn roundtrip_applies_everything_and_never_echoes() {
        // 收进来的改动绝不能再被当成本地改动发出去：apply 期间闸门必须关着。
        let (db_b, dir_b, _) = device().await;
        let (db_a, _dir_a, incoming_a) = device().await;
        let (_course, video) = seed_video(&db_b, dir_b.path()).await;
        sqlx::query("INSERT INTO notes(video_id,content_json,content_md,ai_generated_at) VALUES (?,'{}','# 笔记',1000)")
            .bind(&video)
            .execute(&db_b.pool)
            .await
            .unwrap();

        let report = ship(&db_b, &db_a, &incoming_a).await;
        assert!(
            report.applied >= 3,
            "course+video+note 应全部落地: {report:?}"
        );
        assert_eq!(report.parked, 0);
        let title: String = sqlx::query_scalar("SELECT title FROM videos WHERE id=?")
            .bind(&video)
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        assert!(!title.is_empty());
        // 回声：A 的出件队列必须是空的。
        assert_eq!(outbox_count(&db_a).await, 0, "apply 不得产生回声外发");

        // 幂等：同一批再来一遍，什么都不该变。
        let again = ship(&db_b, &db_a, &incoming_a).await;
        assert_eq!(again.applied, 0, "重复投递必须全部跳过: {again:?}");
    }

    #[tokio::test]
    async fn rename_is_lww_in_both_directions() {
        let (db_b, dir_b, _) = device().await;
        let (db_a, _dir_a, incoming_a) = device().await;
        let (course, _video) = seed_video(&db_b, dir_b.path()).await;
        ship(&db_b, &db_a, &incoming_a).await;

        // 本地更晚：远端旧名到达 → 保留本地。
        sqlx::query("UPDATE courses SET name='本地新名', updated_at=9000 WHERE id=?")
            .bind(&course)
            .execute(&db_a.pool)
            .await
            .unwrap();
        let stale = envelope(
            "Course",
            &course,
            SyncOperation::Save,
            5000,
            json!({"name":"远端旧名","createdAt":1,"updatedAt":5000,"deletedAt":null,"trashChangedAt":1}),
        );
        write_envelope(&incoming_a, "stale", &stale);
        apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        let name: String = sqlx::query_scalar("SELECT name FROM courses WHERE id=?")
            .bind(&course)
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        assert_eq!(name, "本地新名");

        // 远端更晚 → 接受远端。
        let newer = envelope(
            "Course",
            &course,
            SyncOperation::Save,
            99_000,
            json!({"name":"远端新名","createdAt":1,"updatedAt":99_000,"deletedAt":null,"trashChangedAt":1}),
        );
        write_envelope(&incoming_a, "newer", &newer);
        apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        let name: String = sqlx::query_scalar("SELECT name FROM courses WHERE id=?")
            .bind(&course)
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        assert_eq!(name, "远端新名");
    }

    #[tokio::test]
    async fn trash_vs_edit_lands_the_edited_content_in_the_trash() {
        // 判定表第一行：删除态与内容各走各的钟——编辑一个字节都不丢（躺在回收站里），
        // 删除意图也没被顺手撤销。
        let (db_b, dir_b, _) = device().await;
        let (db_a, _dir_a, incoming_a) = device().await;
        let (_course, video) = seed_video(&db_b, dir_b.path()).await;
        ship(&db_b, &db_a, &incoming_a).await;

        let (course_id, created): (String, i64) =
            sqlx::query_as("SELECT course_id, created_at FROM videos WHERE id=?")
                .bind(&video)
                .fetch_one(&db_a.pool)
                .await
                .unwrap();
        // A 在 created+9000 改了标题（意图钟）。
        sqlx::query("UPDATE videos SET title='新标题', sync_updated_at=? WHERE id=?")
            .bind(created + 9000)
            .bind(&video)
            .execute(&db_a.pool)
            .await
            .unwrap();
        // B 在 created+8000 把它扔进回收站（删除钟），带着 B 那边的旧标题。
        let trash = envelope(
            "Video",
            &video,
            SyncOperation::Save,
            created + 8000,
            json!({
                "courseID": course_id, "title": "旧标题", "sourceType": "local",
                "sourceURI": null, "contentFingerprint": null, "durationMs": null,
                "orderIndex": 1, "createdAt": created, "deletedAt": created + 8000,
                "updatedAt": created + 1, "trashChangedAt": created + 8000,
            }),
        );
        write_envelope(&incoming_a, "trash", &trash);
        apply_incoming(&db_a, &incoming_a, None).await.unwrap();

        let (title, deleted): (String, Option<i64>) =
            sqlx::query_as("SELECT title, deleted_at FROM videos WHERE id=?")
                .bind(&video)
                .fetch_one(&db_a.pool)
                .await
                .unwrap();
        assert_eq!(title, "新标题", "意图编辑不能被删除盖掉");
        assert_eq!(deleted, Some(created + 8000), "删除态也不能被编辑撤销");
    }

    #[tokio::test]
    async fn hard_delete_is_a_confirmation_not_an_intent() {
        let (db_b, dir_b, _) = device().await;
        let (db_a, _dir_a, incoming_a) = device().await;
        let (course, video) = seed_video(&db_b, dir_b.path()).await;
        ship(&db_b, &db_a, &incoming_a).await;
        let created: i64 = sqlx::query_scalar("SELECT created_at FROM videos WHERE id=?")
            .bind(&video)
            .fetch_one(&db_a.pool)
            .await
            .unwrap();

        // 本地存活 → 忽略，不立碑（立了碑会把我们随后的保存挡在对端门外）。
        let purge = envelope(
            "Video",
            &video,
            SyncOperation::Delete,
            created + 50_000,
            json!({}),
        );
        write_envelope(&incoming_a, "purge1", &purge);
        apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        let alive: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM videos WHERE id=?)")
            .bind(&video)
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        assert!(alive, "存活记录不接受硬删确认");
        let tombs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_tombstones")
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        assert_eq!(tombs, 0);

        // 本地已在回收站 → 执行 + 立碑。
        sqlx::query("UPDATE videos SET deleted_at=?, trash_changed_at=? WHERE id=?")
            .bind(created + 49_000)
            .bind(created + 49_000)
            .bind(&video)
            .execute(&db_a.pool)
            .await
            .unwrap();
        write_envelope(&incoming_a, "purge2", &purge);
        apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        let alive: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM videos WHERE id=?)")
            .bind(&video)
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        assert!(!alive);

        // 墓碑挡旧保存，放行真恢复。课程用 A 上已存在的那门——
        // 用一门没运过去的课会让保存驻留，断言就会「对了个假原因」。
        let stale_save = envelope(
            "Video",
            &video,
            SyncOperation::Save,
            created + 40_000,
            json!({"courseID": course, "title": "旧内容", "sourceType": "local",
                   "orderIndex": 0, "createdAt": created, "updatedAt": created + 40_000,
                   "trashChangedAt": created}),
        );
        write_envelope(&incoming_a, "stale-save", &stale_save);
        apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        let alive: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM videos WHERE id=?)")
            .bind(&video)
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        assert!(!alive, "早于墓碑的保存是过期设备的旧内容，不得复活");

        let restore = envelope(
            "Video",
            &video,
            SyncOperation::Save,
            created + 60_000,
            json!({"courseID": course, "title": "恢复回来", "sourceType": "local",
                   "orderIndex": 0, "createdAt": created, "updatedAt": created + 60_000,
                   "trashChangedAt": created + 60_000}),
        );
        write_envelope(&incoming_a, "restore", &restore);
        apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        let title: Option<String> = sqlx::query_scalar("SELECT title FROM videos WHERE id=?")
            .bind(&video)
            .fetch_optional(&db_a.pool)
            .await
            .unwrap();
        assert_eq!(
            title.as_deref(),
            Some("恢复回来"),
            "晚于墓碑的保存是真实恢复"
        );
    }

    #[tokio::test]
    async fn a_users_note_beats_machine_regeneration_regardless_of_clock() {
        // 层级律：一台设备的流水线自动重生成是机器行为，不得覆盖另一台上人的编辑，
        // 哪怕机器的墙钟更晚。
        let (db_b, dir_b, _) = device().await;
        let (db_a, _dir_a, incoming_a) = device().await;
        let (_course, video) = seed_video(&db_b, dir_b.path()).await;
        ship(&db_b, &db_a, &incoming_a).await;
        sqlx::query(
            "INSERT INTO notes(video_id,content_json,content_md,user_edited_at) VALUES (?,'{}','人写的',1000)",
        )
        .bind(&video)
        .execute(&db_a.pool)
        .await
        .unwrap();

        let machine = envelope(
            "Note",
            &video,
            SyncOperation::Save,
            999_999,
            json!({"videoID": video, "contentJson": "{}", "contentMd": "机器重写的",
                   "aiGeneratedAt": 999_999, "userEditedAt": null}),
        );
        write_envelope(&incoming_a, "machine", &machine);
        apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        let md: String = sqlx::query_scalar("SELECT content_md FROM notes WHERE video_id=?")
            .bind(&video)
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        assert_eq!(md, "人写的");
    }

    #[tokio::test]
    async fn concurrent_user_edits_preserve_the_loser_in_the_conflict_table() {
        // 笔记是唯一双方都可能是大段人写内容的记录：败方必须可找回，绝不静默丢。
        let (db_b, dir_b, _) = device().await;
        let (db_a, _dir_a, incoming_a) = device().await;
        let (_course, video) = seed_video(&db_b, dir_b.path()).await;
        ship(&db_b, &db_a, &incoming_a).await;
        // A 本地有人写内容（没有基准记录 → 无从证明是顺序编辑 → 按并发保全）。
        sqlx::query(
            "INSERT INTO notes(video_id,content_json,content_md,user_edited_at) VALUES (?,'{}','A 写的',1000)",
        )
        .bind(&video)
        .execute(&db_a.pool)
        .await
        .unwrap();

        let remote = envelope(
            "Note",
            &video,
            SyncOperation::Save,
            2000,
            json!({"videoID": video, "contentJson": "{}", "contentMd": "B 写的",
                   "aiGeneratedAt": null, "userEditedAt": 2000}),
        );
        write_envelope(&incoming_a, "remote", &remote);
        let report = apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        assert_eq!(report.conflicts, 1, "败方要进冲突表");
        let md: String = sqlx::query_scalar("SELECT content_md FROM notes WHERE video_id=?")
            .bind(&video)
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        assert_eq!(md, "B 写的", "全序更晚的一方可见");
        let local_json: String =
            sqlx::query_scalar("SELECT local_json FROM sync_conflicts WHERE record_type='Note'")
                .fetch_one(&db_a.pool)
                .await
                .unwrap();
        assert!(local_json.contains("A 写的"), "败方全文在冲突表里");

        // 顺序编辑（基准与本地一致）不该记冲突：先把基准刷成本地当前内容再收一封更新的。
        let mut tx = db_a.pool.begin().await.unwrap();
        let payload = crate::sync::outbox::payload_for(&mut tx, "Note", &video)
            .await
            .unwrap()
            .unwrap();
        let hash = sha256_hex(payload.to_string().as_bytes());
        upsert_basis(&mut tx, "Note", &video, 2000, Some(&hash))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let sequential = envelope(
            "Note",
            &video,
            SyncOperation::Save,
            3000,
            json!({"videoID": video, "contentJson": "{}", "contentMd": "B 接着写",
                   "aiGeneratedAt": null, "userEditedAt": 3000}),
        );
        write_envelope(&incoming_a, "sequential", &sequential);
        let report = apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        assert_eq!(report.conflicts, 0, "顺序快进不是并发");
    }

    #[tokio::test]
    async fn an_older_user_edit_still_beats_a_newer_machine_note() {
        // 层级律的另一个方向：远端的人写内容哪怕墙钟更早，也要赢本地更晚的机器重生成。
        // 只测「本地人写挡远端机器」的话，把取用分支删掉测试照样绿——
        // 等层 LWW 会在「人写恰好更晚」时碰巧给出同样结果。
        let (db_b, dir_b, _) = device().await;
        let (db_a, _dir_a, incoming_a) = device().await;
        let (_course, video) = seed_video(&db_b, dir_b.path()).await;
        ship(&db_b, &db_a, &incoming_a).await;
        sqlx::query(
            "INSERT INTO notes(video_id,content_json,content_md,ai_generated_at) VALUES (?,'{}','机器新写的',999_999)",
        )
        .bind(&video)
        .execute(&db_a.pool)
        .await
        .unwrap();

        let user_note = envelope(
            "Note",
            &video,
            SyncOperation::Save,
            500,
            json!({"videoID": video, "contentJson": "{}", "contentMd": "人早先写的",
                   "aiGeneratedAt": null, "userEditedAt": 500}),
        );
        write_envelope(&incoming_a, "user", &user_note);
        apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        let md: String = sqlx::query_scalar("SELECT content_md FROM notes WHERE video_id=?")
            .bind(&video)
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        assert_eq!(md, "人早先写的", "人写的层级高于机器，与墙钟无关");
    }

    #[tokio::test]
    async fn a_video_parks_when_its_course_has_not_arrived() {
        // 驻留是正确性不是优化：父记录缺席必须是「等」，不能是错也不能是吞。
        let (db_a, _dir_a, incoming_a) = device().await;
        let video = envelope(
            "Video",
            "v-orphan",
            SyncOperation::Save,
            1000,
            json!({"courseID":"c-missing","title":"孤儿","sourceType":"local","orderIndex":0,
                   "createdAt":1,"updatedAt":1,"trashChangedAt":1}),
        );
        write_envelope(&incoming_a, "orphan", &video);
        let report = apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        assert_eq!(report.parked, 1);
        assert!(incoming_a.join("orphan.json").is_file());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM videos")
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn an_empty_remote_duration_does_not_erase_a_measured_one() {
        // 有知胜无知：没媒体的设备改个标题，不能把「空时长」一并盖过来。
        let (db_b, dir_b, _) = device().await;
        let (db_a, _dir_a, incoming_a) = device().await;
        let (course, video) = seed_video(&db_b, dir_b.path()).await;
        ship(&db_b, &db_a, &incoming_a).await;
        sqlx::query("UPDATE videos SET duration_ms=3_600_000 WHERE id=?")
            .bind(&video)
            .execute(&db_a.pool)
            .await
            .unwrap();
        let created: i64 = sqlx::query_scalar("SELECT created_at FROM videos WHERE id=?")
            .bind(&video)
            .fetch_one(&db_a.pool)
            .await
            .unwrap();

        let retitle = envelope(
            "Video",
            &video,
            SyncOperation::Save,
            created + 9000,
            json!({"courseID": course, "title": "占位机改的名", "sourceType": "local",
                   "durationMs": null, "orderIndex": 1, "createdAt": created,
                   "updatedAt": created + 9000, "trashChangedAt": created}),
        );
        write_envelope(&incoming_a, "retitle", &retitle);
        apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        let (title, duration): (String, Option<i64>) =
            sqlx::query_as("SELECT title, duration_ms FROM videos WHERE id=?")
                .bind(&video)
                .fetch_one(&db_a.pool)
                .await
                .unwrap();
        assert_eq!(title, "占位机改的名", "意图组照常 LWW");
        assert_eq!(duration, Some(3_600_000), "度量组：空不盖满");
    }

    #[tokio::test]
    async fn a_stale_trash_loses_to_a_later_restore() {
        // 恢复与删除是同一个开关上的两次显式操作：后表达的意图胜。
        // 缺了这条方向，去掉删除组的 LWW 闸门（改成「不同就写」）测试照样绿。
        let (db_b, dir_b, _) = device().await;
        let (db_a, _dir_a, incoming_a) = device().await;
        let (course, video) = seed_video(&db_b, dir_b.path()).await;
        ship(&db_b, &db_a, &incoming_a).await;
        let created: i64 = sqlx::query_scalar("SELECT created_at FROM videos WHERE id=?")
            .bind(&video)
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        // A 在 created+9000 恢复过（删除钟更晚，当前存活）。
        sqlx::query("UPDATE videos SET deleted_at=NULL, trash_changed_at=? WHERE id=?")
            .bind(created + 9000)
            .bind(&video)
            .execute(&db_a.pool)
            .await
            .unwrap();

        // B 在 created+8000 的删除此刻才到——过期意图，必须输。
        let stale_trash = envelope(
            "Video",
            &video,
            SyncOperation::Save,
            created + 8000,
            json!({"courseID": course, "title": "无关", "sourceType": "local",
                   "orderIndex": 1, "createdAt": created, "deletedAt": created + 8000,
                   "updatedAt": created, "trashChangedAt": created + 8000}),
        );
        write_envelope(&incoming_a, "stale-trash", &stale_trash);
        apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        let deleted: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM videos WHERE id=?")
            .bind(&video)
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        assert_eq!(deleted, None, "更晚的恢复不能被更早的删除撤销");
    }

    #[tokio::test]
    async fn events_union_by_id_and_refuse_deletion() {
        let (db_a, _dir_a, incoming_a) = device().await;
        let event = envelope(
            "StudyEvent",
            "evt-1",
            SyncOperation::Save,
            1000,
            json!({"id":"evt-1","kind":"watch","courseID":null,"videoID":null,
                   "ts":1000,"durationMs":60_000,"metaJson":"{}"}),
        );
        write_envelope(&incoming_a, "e1", &event);
        write_envelope(&incoming_a, "e2", &event);
        apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM study_events")
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "同一事件 id 只落一条");

        let delete = envelope(
            "StudyEvent",
            "evt-1",
            SyncOperation::Delete,
            9000,
            json!({}),
        );
        write_envelope(&incoming_a, "del", &delete);
        apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM study_events")
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "事件是不可变事实，不接受删除");
    }

    /// 两台设备各自的复习合流后，双方排期必须一字不差——排期不合并，只重折。
    #[tokio::test]
    async fn remote_reviews_fold_into_exactly_the_local_schedule() {
        let (db_b, dir_b, incoming_b) = device().await;
        let (db_a, _dir_a, incoming_a) = device().await;
        let (_course, video) = seed_video(&db_b, dir_b.path()).await;
        let card = add_manual_card(&db_b, &video, "cloze", "正面", "背面", None)
            .await
            .unwrap();
        review_card(&db_b, &card, 3, 1_000_000).await.unwrap();
        review_card(&db_b, &card, 2, 90_000_000).await.unwrap();

        ship(&db_b, &db_a, &incoming_a).await;

        type Sched = (f64, f64, i64, i64, i64, Option<i64>, i64);
        let read = |pool: sqlx::SqlitePool, card: String| async move {
            let row: Sched = sqlx::query_as(
                "SELECT stability,difficulty,interval_days,reps,lapses,last_reviewed,due_at
                 FROM card_schedule WHERE card_id=?",
            )
            .bind(card)
            .fetch_one(&pool)
            .await
            .unwrap();
            row
        };
        let on_b = read(db_b.pool.clone(), card.clone()).await;
        let on_a = read(db_a.pool.clone(), card.clone()).await;
        assert_eq!(on_a, on_b, "折叠出的排期必须与增量更新一字不差");

        // 反向也一样：A 继续复习，事实流回 B，B 重折后仍然相等。
        review_card(&db_a, &card, 4, 200_000_000).await.unwrap();
        ship(&db_a, &db_b, &incoming_b).await;
        let on_b = read(db_b.pool.clone(), card.clone()).await;
        let on_a = read(db_a.pool.clone(), card.clone()).await;
        assert_eq!(on_a, on_b);
    }

    /// 迟到的中间事件要改写其后每一步：合流结果 == 按真实时间交错重放的结果。
    #[tokio::test]
    async fn interleaved_reviews_converge_to_the_true_replay() {
        let (db_b, dir_b, _) = device().await;
        let (db_a, _dir_a, incoming_a) = device().await;
        let (_course, video) = seed_video(&db_b, dir_b.path()).await;
        let card = add_manual_card(&db_b, &video, "cloze", "q", "a", None)
            .await
            .unwrap();
        review_card(&db_b, &card, 3, 1_000_000).await.unwrap();
        ship(&db_b, &db_a, &incoming_a).await;

        // A 在 t3 复习（本地增量）；B 的 t2 复习事件之后才到（迟到的中间事实）。
        review_card(&db_a, &card, 4, 300_000_000).await.unwrap();
        review_card(&db_b, &card, 1, 150_000_000).await.unwrap();
        ship(&db_b, &db_a, &incoming_a).await;

        // 对照组：一台从未分过家的设备按真实时间顺序复习三次。
        let (db_c, dir_c, _) = device().await;
        let (_c2, video_c) = seed_video(&db_c, dir_c.path()).await;
        sqlx::query("INSERT INTO cards(id,video_id,kind,front,back,created_at) SELECT ?,?,'cloze','q','a',created_at FROM cards WHERE id=?")
            .bind("card-c")
            .bind(&video_c)
            .bind(&card)
            .fetch_optional(&db_a.pool)
            .await
            .ok();
        // 直接对照折叠函数：从建卡态按 (t1,t2,t3) 重放。
        let created: i64 = sqlx::query_scalar("SELECT created_at FROM cards WHERE id=?")
            .bind(&card)
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        let mut expected = ScheduleState::fresh(created);
        step_review(&mut expected, 3, 1_000_000);
        step_review(&mut expected, 1, 150_000_000);
        step_review(&mut expected, 4, 300_000_000);

        type Sched = (f64, f64, i64, i64, i64, Option<i64>, i64);
        let on_a: Sched = sqlx::query_as(
            "SELECT stability,difficulty,interval_days,reps,lapses,last_reviewed,due_at
             FROM card_schedule WHERE card_id=?",
        )
        .bind(&card)
        .fetch_one(&db_a.pool)
        .await
        .unwrap();
        assert_eq!(
            on_a,
            (
                expected.stability,
                expected.difficulty,
                expected.interval_days,
                expected.reps,
                expected.lapses,
                expected.last_reviewed,
                expected.due_at
            ),
            "合流后的排期必须等于按真实交错的重放"
        );
        drop(dir_c);
        let _ = db_c;
    }

    /// 事件重放无法复现的历史（SM-2 时代、事件日志之前）用基线事件垫平。
    #[tokio::test]
    async fn baselines_pin_history_that_events_cannot_replay() {
        let (db_b, dir_b, _) = device().await;
        let (db_a, _dir_a, incoming_a) = device().await;
        let (_course, video) = seed_video(&db_b, dir_b.path()).await;
        let card = add_manual_card(&db_b, &video, "cloze", "q", "a", None)
            .await
            .unwrap();
        // 伪造一段「重放不出来」的历史：排期有值但没有对应事件。
        sqlx::query(
            "UPDATE card_schedule SET stability=3.5, difficulty=6.1, interval_days=4,
             reps=7, lapses=2, last_reviewed=5_000_000, due_at=400_000_000 WHERE card_id=?",
        )
        .bind(&card)
        .execute(&db_b.pool)
        .await
        .unwrap();

        let emitted = ensure_srs_baselines(&db_b, 6_000_000).await.unwrap();
        assert_eq!(emitted, 1, "对不上的历史要钉成基线");
        let again = ensure_srs_baselines(&db_b, 7_000_000).await.unwrap();
        assert_eq!(again, 0, "钉过之后幂等");

        ship(&db_b, &db_a, &incoming_a).await;
        type Sched = (f64, f64, i64, i64, i64, Option<i64>, i64);
        let on_a: Sched = sqlx::query_as(
            "SELECT stability,difficulty,interval_days,reps,lapses,last_reviewed,due_at
             FROM card_schedule WHERE card_id=?",
        )
        .bind(&card)
        .fetch_one(&db_a.pool)
        .await
        .unwrap();
        assert_eq!(
            on_a,
            (3.5, 6.1, 4, 7, 2, Some(5_000_000), 400_000_000),
            "对端从基线种子起折，得到同一份历史"
        );
    }

    #[tokio::test]
    async fn children_park_until_their_parents_arrive() {
        let (db_a, _dir_a, incoming_a) = device().await;
        let note = envelope(
            "Note",
            "v-1",
            SyncOperation::Save,
            1000,
            json!({"videoID":"v-1","contentJson":"{}","contentMd":"孤儿笔记",
                   "aiGeneratedAt":1000,"userEditedAt":null}),
        );
        write_envelope(&incoming_a, "note", &note);
        let report = apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        assert_eq!(report.parked, 1, "父记录未到必须驻留，不能失败也不能吞掉");
        assert!(incoming_a.join("note.json").is_file(), "驻留件留在原地");

        // 父记录到齐后，同一批里乱序也能全部消化。
        let course = envelope(
            "Course",
            "c-1",
            SyncOperation::Save,
            1000,
            json!({"name":"课","createdAt":1,"updatedAt":1,"deletedAt":null,"trashChangedAt":1}),
        );
        let video = envelope(
            "Video",
            "v-1",
            SyncOperation::Save,
            1000,
            json!({"courseID":"c-1","title":"视","sourceType":"local","orderIndex":0,
                   "createdAt":1,"updatedAt":1,"trashChangedAt":1}),
        );
        write_envelope(&incoming_a, "video", &video);
        write_envelope(&incoming_a, "course", &course);
        let report = apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        assert_eq!(report.applied, 3);
        assert_eq!(report.parked, 0);
        let md: String = sqlx::query_scalar("SELECT content_md FROM notes WHERE video_id='v-1'")
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        assert_eq!(md, "孤儿笔记");
    }

    #[tokio::test]
    async fn progress_respects_a_deliberate_rewind_and_known_duration() {
        let (db_b, dir_b, _) = device().await;
        let (db_a, _dir_a, incoming_a) = device().await;
        let (_course, video) = seed_video(&db_b, dir_b.path()).await;
        ship(&db_b, &db_a, &incoming_a).await;
        sqlx::query(
            "INSERT INTO video_progress(video_id,position_ms,duration_ms,updated_at) VALUES (?,50_000,3_600_000,2000)",
        )
        .bind(&video)
        .execute(&db_a.pool)
        .await
        .unwrap();

        // 远端更晚的「回退到开头重看」必须赢：续播点不是单调量。
        let rewind = envelope(
            "VideoProgress",
            &video,
            SyncOperation::Save,
            3000,
            json!({"videoID": video, "positionMs": 1000, "durationMs": null, "updatedAt": 3000}),
        );
        write_envelope(&incoming_a, "rewind", &rewind);
        apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        let (position, duration): (i64, Option<i64>) =
            sqlx::query_as("SELECT position_ms, duration_ms FROM video_progress WHERE video_id=?")
                .bind(&video)
                .fetch_one(&db_a.pool)
                .await
                .unwrap();
        assert_eq!(position, 1000, "更晚的回退胜过更大的位置");
        assert_eq!(
            duration,
            Some(3_600_000),
            "远端的空时长不能盖掉本地的已知时长"
        );
    }

    #[tokio::test]
    async fn fingerprint_disagreement_keeps_local_and_records_the_conflict() {
        let (db_b, dir_b, _) = device().await;
        let (db_a, _dir_a, incoming_a) = device().await;
        let (course, video) = seed_video(&db_b, dir_b.path()).await;
        ship(&db_b, &db_a, &incoming_a).await;
        sqlx::query("UPDATE videos SET content_fingerprint='local-fp' WHERE id=?")
            .bind(&video)
            .execute(&db_a.pool)
            .await
            .unwrap();

        let (created,): (i64,) = sqlx::query_as("SELECT created_at FROM videos WHERE id=?")
            .bind(&video)
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        let remote = envelope(
            "Video",
            &video,
            SyncOperation::Save,
            90_000,
            json!({"courseID": course, "title": "同一条记录", "sourceType": "local",
                   "contentFingerprint": "remote-fp", "orderIndex": 1,
                   "createdAt": created, "updatedAt": 90_000, "trashChangedAt": 1}),
        );
        write_envelope(&incoming_a, "fp", &remote);
        let report = apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        assert_eq!(report.conflicts, 1);
        let fp: String = sqlx::query_scalar("SELECT content_fingerprint FROM videos WHERE id=?")
            .bind(&video)
            .fetch_one(&db_a.pool)
            .await
            .unwrap();
        assert_eq!(fp, "local-fp", "两台设备放着不同文件时，度量各自描述各自的");
    }

    #[tokio::test]
    async fn probe_files_are_left_alone_and_garbage_is_quarantined() {
        let (db_a, _dir_a, incoming_a) = device().await;
        let probe = envelope("SyncProbeRequest", "m-1", SyncOperation::Save, 1, json!({}));
        write_envelope(&incoming_a, "probe", &probe);
        fs::write(incoming_a.join("garbage.json"), b"not json").unwrap();

        let report = apply_incoming(&db_a, &incoming_a, None).await.unwrap();
        assert!(
            incoming_a.join("probe.json").is_file(),
            "探针报文原样留给探针引擎"
        );
        assert!(!incoming_a.join("garbage.json").exists());
        assert!(incoming_a.join("invalid").join("garbage.json").is_file());
        assert_eq!(report.invalid, 1);
    }

    /// 收敛性的直接检验：同一组信封以两种到达顺序、其中一封重复投递，
    /// 落到两台空设备上，最终状态必须相同。
    #[tokio::test]
    async fn permuted_and_duplicated_delivery_converges() {
        let course = envelope(
            "Course",
            "c-1",
            SyncOperation::Save,
            1000,
            json!({"name":"终名","createdAt":1,"updatedAt":1000,"deletedAt":null,"trashChangedAt":1}),
        );
        let rename_old = envelope(
            "Course",
            "c-1",
            SyncOperation::Save,
            500,
            json!({"name":"旧名","createdAt":1,"updatedAt":500,"deletedAt":null,"trashChangedAt":1}),
        );
        let video = envelope(
            "Video",
            "v-1",
            SyncOperation::Save,
            800,
            json!({"courseID":"c-1","title":"视","sourceType":"local","orderIndex":3,
                   "createdAt":1,"updatedAt":800,"trashChangedAt":1}),
        );

        let (db_x, _dx, incoming_x) = device().await;
        for (name, e) in [
            ("a", &course),
            ("b", &rename_old),
            ("c", &video),
            ("dup", &course),
        ] {
            write_envelope(&incoming_x, name, e);
        }
        apply_incoming(&db_x, &incoming_x, None).await.unwrap();

        let (db_y, _dy, incoming_y) = device().await;
        for (name, e) in [("a", &video), ("b", &course), ("c", &rename_old)] {
            write_envelope(&incoming_y, name, e);
        }
        apply_incoming(&db_y, &incoming_y, None).await.unwrap();
        // 乱序批内父后于子：驻留重试保证仍然全部落地。
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM videos")
            .fetch_one(&db_y.pool)
            .await
            .unwrap();
        assert_eq!(count, 1);

        for db in [&db_x, &db_y] {
            let (name, title): (String, String) = sqlx::query_as(
                "SELECT c.name, v.title FROM courses c JOIN videos v ON v.course_id=c.id",
            )
            .fetch_one(&db.pool)
            .await
            .unwrap();
            assert_eq!((name.as_str(), title.as_str()), ("终名", "视"));
        }
    }
}
