use crate::db::Db;
use crate::error::{AppError, AppResult};
use chrono::Local;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::sync::Mutex;
use uuid::Uuid;

pub const STARTUP_SNAPSHOT_LIMIT: usize = 7;
const STARTUP_SNAPSHOT_PREFIX: &str = "courseai-startup-";
const MANUAL_BACKUP_PREFIX: &str = "CoursePilot-backup-";
const INTERNAL_MANUAL_BACKUP_LIMIT: usize = 3;
const RESTORE_SNAPSHOT_PREFIX: &str = "courseai-pre-restore-";
const RESTORE_SNAPSHOT_LIMIT: usize = 3;
const PENDING_RESTORE_DIR: &str = "backups/pending";
const PENDING_RESTORE_FILE: &str = "restore.db";
const PENDING_RESTORE_MANIFEST: &str = "restore.json";

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    pub snapshot_path: String,
    pub requires_restart: bool,
    pub restart_requested: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingRestoreManifest {
    schema_version: i64,
    sqlite_user_version: i64,
    snapshot_file_name: String,
    created_at: i64,
}

fn backup_mutex() -> &'static Mutex<()> {
    static MUTEX: OnceLock<Mutex<()>> = OnceLock::new();
    MUTEX.get_or_init(|| Mutex::new(()))
}

/// 用 SQLite 自身的 VACUUM INTO 生成事务一致的独立数据库文件。
///
/// 先写同目录临时文件并校验，再替换最终路径；中途失败不会留下一个看似可用的半成品。
pub async fn create_database_backup(db: &Db, destination: &Path) -> AppResult<PathBuf> {
    let _backup_guard = backup_mutex().lock().await;
    create_database_backup_locked(db, destination).await
}

async fn create_database_backup_locked(db: &Db, destination: &Path) -> AppResult<PathBuf> {
    let parent = destination_parent(destination);
    std::fs::create_dir_all(parent)?;

    let source = canonical_file_path(db.path())?;
    let destination_canonical = canonical_file_path(destination)?;
    if source == destination_canonical || same_existing_file(db.path(), destination)? {
        return Err(AppError::Other("备份路径不能覆盖正在使用的数据库".into()));
    }
    if destination.is_dir() {
        return Err(AppError::Other("备份路径必须是文件，不能是目录".into()));
    }

    verify_pool_integrity(&db.pool, "PRAGMA quick_check", "当前数据库").await?;
    verify_pool_schema(&db.pool, None, "当前数据库").await?;

    let temp = temporary_backup_path(destination)?;
    remove_sqlite_files(&temp);
    let result = async {
        sqlx::query("VACUUM INTO ?")
            .bind(temp.to_string_lossy().as_ref())
            .execute(&db.pool)
            .await?;

        verify_backup_file(&temp, None).await?;
        File::open(&temp)?.sync_all()?;
        replace_file(&temp, destination)?;
        sync_parent_directory(destination_parent(destination))?;
        Ok(destination.to_owned())
    }
    .await;

    if result.is_err() {
        remove_sqlite_files(&temp);
    }
    result
}

/// 每次成功打开数据库后留一份启动快照，并只保留最近几份。
pub async fn create_startup_snapshot(db: &Db, app_data_dir: &Path) -> AppResult<PathBuf> {
    let dir = app_data_dir.join("backups").join("startup");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!(
        "{STARTUP_SNAPSHOT_PREFIX}{}.db",
        Local::now().format("%Y%m%d")
    ));
    if path.is_file() {
        prune_startup_snapshots(&dir, STARTUP_SNAPSHOT_LIMIT)?;
        return Ok(path);
    }
    let created = create_database_backup(db, &path).await?;
    prune_startup_snapshots(&dir, STARTUP_SNAPSHOT_LIMIT)?;
    Ok(created)
}

/// 移动端先在应用目录生成备份，随后由前端交给系统分享面板；内部临时导出限量保留。
pub async fn create_shareable_database_backup(db: &Db, app_data_dir: &Path) -> AppResult<PathBuf> {
    let dir = app_data_dir.join("exports").join("database-backups");
    let path = dir.join(timestamped_name(MANUAL_BACKUP_PREFIX));
    let created = create_database_backup(db, &path).await?;
    prune_matching_backups(&dir, MANUAL_BACKUP_PREFIX, INTERNAL_MANUAL_BACKUP_LIMIT)?;
    Ok(created)
}

/// 校验并暂存一份待恢复数据库。
///
/// 恢复分两阶段完成：这里在现有连接仍然可用时生成恢复前快照，并把导入文件
/// 复制到应用目录；真正替换发生在下一次启动、建立连接之前。这样即使复制、校验、
/// 重启或原子替换任一步失败，当前数据库文件都不会被半成品覆盖。
pub async fn stage_database_restore(
    db: &Db,
    source: &Path,
    app_data_dir: &Path,
) -> AppResult<RestoreOutcome> {
    let _backup_guard = backup_mutex().lock().await;
    stage_database_restore_locked(db, source, app_data_dir).await
}

async fn stage_database_restore_locked(
    db: &Db,
    source: &Path,
    app_data_dir: &Path,
) -> AppResult<RestoreOutcome> {
    if !source.is_file() {
        return Err(AppError::Other(
            "恢复文件必须是一个 SQLite 数据库文件".into(),
        ));
    }
    if same_existing_file(db.path(), source)?
        || canonical_file_path(db.path())? == source.canonicalize()?
    {
        return Err(AppError::Other("恢复文件不能是正在使用的数据库".into()));
    }

    let pending_dir = app_data_dir.join(PENDING_RESTORE_DIR);
    std::fs::create_dir_all(&pending_dir)?;
    let manifest_path = pending_dir.join(PENDING_RESTORE_MANIFEST);
    let staged_path = pending_dir.join(PENDING_RESTORE_FILE);
    if manifest_path.exists() {
        return Err(AppError::Other(
            "已有一份恢复任务等待重启，请先重启应用完成恢复".into(),
        ));
    }

    let current_user_version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&db.pool)
        .await?;
    let source_info = inspect_database_file(source, Some(current_user_version), "恢复文件").await?;

    let snapshot_dir = app_data_dir.join("backups").join("restore");
    std::fs::create_dir_all(&snapshot_dir)?;
    if let Err(error) = prune_matching_backups(
        &snapshot_dir,
        RESTORE_SNAPSHOT_PREFIX,
        RESTORE_SNAPSHOT_LIMIT.saturating_sub(1),
    ) {
        tracing::warn!("prune old restore snapshots failed: {error}");
    }
    let snapshot_path = snapshot_dir.join(format!(
        "{RESTORE_SNAPSHOT_PREFIX}{}-{}.db",
        Local::now().format("%Y%m%d-%H%M%S"),
        Uuid::new_v4()
    ));
    // 当前锁已经覆盖整个「快照 + 暂存 + manifest」事务，避免另一个备份在中间插入。
    create_database_backup_locked(db, &snapshot_path).await?;

    let temporary = pending_dir.join(format!(".{PENDING_RESTORE_FILE}.{}.tmp", Uuid::new_v4()));
    remove_sqlite_files(&temporary);
    let stage_result = async {
        std::fs::copy(source, &temporary)?;
        let copied =
            inspect_database_file(&temporary, Some(current_user_version), "待恢复文件").await?;
        if copied.schema_version != source_info.schema_version
            || copied.sqlite_user_version != source_info.sqlite_user_version
        {
            return Err(AppError::Other(
                "恢复文件在复制过程中发生变化，请重新选择".into(),
            ));
        }
        File::open(&temporary)?.sync_all()?;
        replace_file(&temporary, &staged_path)?;
        sync_parent_directory(&pending_dir)?;

        let manifest = PendingRestoreManifest {
            schema_version: copied.schema_version,
            sqlite_user_version: copied.sqlite_user_version,
            snapshot_file_name: snapshot_path
                .file_name()
                .expect("restore snapshot has a file name")
                .to_string_lossy()
                .into_owned(),
            created_at: chrono::Utc::now().timestamp_millis(),
        };
        let manifest_temp = pending_dir.join(format!(
            ".{PENDING_RESTORE_MANIFEST}.{}.tmp",
            Uuid::new_v4()
        ));
        let bytes = serde_json::to_vec_pretty(&manifest)?;
        std::fs::write(&manifest_temp, bytes)?;
        File::open(&manifest_temp)?.sync_all()?;
        replace_file(&manifest_temp, &manifest_path)?;
        sync_parent_directory(&pending_dir)?;
        Ok::<(), AppError>(())
    }
    .await;

    if let Err(error) = stage_result {
        remove_sqlite_files(&temporary);
        // A staged file without a manifest is never applied; clean it eagerly so a
        // later attempt starts from a deterministic state.
        let _ = std::fs::remove_file(&staged_path);
        return Err(error);
    }

    Ok(RestoreOutcome {
        snapshot_path: snapshot_path.to_string_lossy().into_owned(),
        requires_restart: true,
        restart_requested: false,
    })
}

#[derive(Debug, Clone, Copy)]
struct DatabaseInfo {
    schema_version: i64,
    sqlite_user_version: i64,
}

async fn inspect_database_file(
    path: &Path,
    expected_user_version: Option<i64>,
    label: &str,
) -> AppResult<DatabaseInfo> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| AppError::Other(format!("{label}不是可读取的 SQLite 数据库：{error}")))?;
    let result = async {
        verify_pool_integrity(&pool, "PRAGMA integrity_check", label).await?;
        let violations = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&pool)
            .await?;
        if !violations.is_empty() {
            return Err(AppError::Other(format!(
                "{label}外键检查失败：发现 {} 条无效关联",
                violations.len()
            )));
        }
        verify_pool_schema(&pool, expected_user_version, label).await?;
        let schema_version = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success = 1",
        )
        .fetch_one(&pool)
        .await?;
        let sqlite_user_version = sqlx::query_scalar::<_, i64>("PRAGMA user_version")
            .fetch_one(&pool)
            .await?;
        Ok(DatabaseInfo {
            schema_version,
            sqlite_user_version,
        })
    }
    .await;
    pool.close().await;
    result
}

/// 在数据库连接建立前应用待恢复文件。失败时保留当前数据库和 manifest，
/// 启动流程可继续使用原库，下一次启动仍可重试，不会把失败状态伪装成成功。
pub async fn apply_pending_restore(app_data_dir: &Path, db_path: &Path) -> AppResult<bool> {
    let pending_dir = app_data_dir.join(PENDING_RESTORE_DIR);
    let manifest_path = pending_dir.join(PENDING_RESTORE_MANIFEST);
    if !manifest_path.is_file() {
        return Ok(false);
    }
    let manifest: PendingRestoreManifest = serde_json::from_slice(&std::fs::read(&manifest_path)?)
        .map_err(|error| AppError::Other(format!("恢复任务记录损坏：{error}")))?;
    let staged_path = pending_dir.join(PENDING_RESTORE_FILE);
    if !staged_path.is_file() {
        return Err(AppError::Other("恢复任务缺少待恢复数据库文件".into()));
    }
    if db_path == staged_path {
        return Err(AppError::Other("恢复目标不能是待恢复文件本身".into()));
    }

    let current_user_version = if db_path.is_file() {
        Some(read_user_version(db_path).await?)
    } else {
        None
    };
    let snapshot_name = Path::new(&manifest.snapshot_file_name);
    if snapshot_name.file_name().and_then(|name| name.to_str())
        != Some(manifest.snapshot_file_name.as_str())
        || !manifest
            .snapshot_file_name
            .starts_with(RESTORE_SNAPSHOT_PREFIX)
        || !manifest.snapshot_file_name.ends_with(".db")
    {
        return Err(AppError::Other("恢复任务中的快照路径无效".into()));
    }
    let snapshot_path = app_data_dir
        .join("backups")
        .join("restore")
        .join(&manifest.snapshot_file_name);
    if !snapshot_path.is_file() {
        return Err(AppError::Other("恢复前安全快照缺失，已取消恢复".into()));
    }
    inspect_database_file(&snapshot_path, current_user_version, "恢复前安全快照").await?;
    let staged = inspect_database_file(&staged_path, current_user_version, "待恢复文件").await?;
    if staged.schema_version != manifest.schema_version
        || staged.sqlite_user_version != manifest.sqlite_user_version
    {
        return Err(AppError::Other(
            "恢复任务记录与数据库版本不一致，请重新选择备份".into(),
        ));
    }

    // 移动端只能要求用户完全退出后重开；从安排恢复到真正退出之间仍可能新增笔记或
    // 学习记录。启动时在受控连接中刷新同一份安全快照，随后关闭连接再原子替换，
    // 确保这些最后时刻的数据也有可回滚副本。
    if db_path.is_file() {
        let live = Db::connect_and_migrate(db_path)
            .await
            .map_err(|error| AppError::Other(format!("恢复前无法打开当前数据库：{error}")))?;
        let refreshed = create_database_backup(&live, &snapshot_path).await;
        live.pool.close().await;
        refreshed.map_err(|error| {
            AppError::Other(format!("恢复前安全快照刷新失败，已取消恢复：{error}"))
        })?;
    }

    if db_path.exists() && same_existing_file(db_path, &staged_path)? {
        return Err(AppError::Other("恢复目标与待恢复文件相同".into()));
    }
    replace_file(&staged_path, db_path)
        .map_err(|error| AppError::Other(format!("替换数据库失败，原数据库未改变：{error}")))?;
    if let Err(error) = sync_parent_directory(destination_parent(db_path)) {
        tracing::warn!("sync restored database directory failed: {error}");
    }
    remove_sqlite_sidecars(db_path);
    // Manifest is removed only after the atomic replacement succeeds. If cleanup
    // itself fails, the next startup sees the missing staged file and reports the
    // actionable failure instead of applying an unknown file twice.
    if let Err(error) = std::fs::remove_file(&manifest_path) {
        tracing::warn!("remove completed restore manifest failed: {error}");
    }
    Ok(true)
}

async fn read_user_version(path: &Path) -> AppResult<i64> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    let result = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&pool)
        .await;
    pool.close().await;
    Ok(result?)
}

fn timestamped_name(prefix: &str) -> String {
    let now = Local::now();
    format!(
        "{prefix}{}-{:03}.db",
        now.format("%Y%m%d-%H%M%S"),
        now.timestamp_subsec_millis()
    )
}

fn destination_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn canonical_file_path(path: &Path) -> AppResult<PathBuf> {
    if path.exists() {
        return Ok(path.canonicalize()?);
    }
    let parent = destination_parent(path).canonicalize()?;
    let file_name = path
        .file_name()
        .ok_or_else(|| AppError::Other("备份路径缺少文件名".into()))?;
    Ok(parent.join(file_name))
}

fn same_existing_file(source: &Path, destination: &Path) -> AppResult<bool> {
    if !destination.exists() {
        return Ok(false);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let source = std::fs::metadata(source)?;
        let destination = std::fs::metadata(destination)?;
        return Ok(source.dev() == destination.dev() && source.ino() == destination.ino());
    }

    #[cfg(not(unix))]
    {
        Ok(false)
    }
}

fn temporary_backup_path(destination: &Path) -> AppResult<PathBuf> {
    let file_name = destination
        .file_name()
        .ok_or_else(|| AppError::Other("备份路径缺少文件名".into()))?
        .to_string_lossy();
    Ok(destination_parent(destination).join(format!(".{file_name}.{}.tmp", Uuid::new_v4())))
}

async fn verify_backup_file(path: &Path, expected_user_version: Option<i64>) -> AppResult<()> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    let result = verify_pool_integrity(&pool, "PRAGMA integrity_check", "备份文件").await;
    let result = match result {
        Ok(()) => {
            let violations = sqlx::query("PRAGMA foreign_key_check")
                .fetch_all(&pool)
                .await?;
            if violations.is_empty() {
                verify_pool_schema(&pool, expected_user_version, "备份文件").await
            } else {
                Err(AppError::Other(format!(
                    "备份文件外键检查失败：发现 {} 条无效关联",
                    violations.len()
                )))
            }
        }
        error => error,
    };
    pool.close().await;
    result
}

async fn verify_pool_integrity(
    pool: &sqlx::SqlitePool,
    pragma: &str,
    label: &str,
) -> AppResult<()> {
    let rows: Vec<String> = sqlx::query_scalar(pragma).fetch_all(pool).await?;
    if rows.len() == 1 && rows[0].eq_ignore_ascii_case("ok") {
        return Ok(());
    }
    let detail = if rows.is_empty() {
        "没有返回检查结果".to_string()
    } else {
        rows.join("；")
    };
    Err(AppError::Other(format!("{label}完整性检查失败：{detail}")))
}

/// SQLite 的 `user_version` 由应用保留给数据库格式；SQLx 的迁移表则负责
/// 精确判断这份文件是否来自当前应用版本。允许旧迁移版本（启动时会补跑迁移），
/// 拒绝未来版本、失败迁移以及缺少核心表的普通 SQLite 文件。
async fn verify_pool_schema(
    pool: &sqlx::SqlitePool,
    expected_user_version: Option<i64>,
    label: &str,
) -> AppResult<()> {
    let user_version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(pool)
        .await?;
    if let Some(expected) = expected_user_version {
        if user_version > expected {
            return Err(AppError::Other(format!(
                "{label}版本不兼容：SQLite user_version={user_version}，当前版本为 {expected}"
            )));
        }
    }

    let migration_table: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations' LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    if migration_table.is_none() {
        return Err(AppError::Other(format!(
            "{label}版本不兼容：缺少应用迁移记录"
        )));
    }

    let failed_migrations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE success = 0")
            .fetch_one(pool)
            .await?;
    if failed_migrations > 0 {
        return Err(AppError::Other(format!(
            "{label}版本不兼容：存在 {failed_migrations} 个失败迁移"
        )));
    }

    let applied_migrations: Vec<(i64, Vec<u8>)> = sqlx::query_as(
        "SELECT version, checksum FROM _sqlx_migrations WHERE success = 1 ORDER BY version",
    )
    .fetch_all(pool)
    .await?;
    if applied_migrations.is_empty() {
        return Err(AppError::Other(format!(
            "{label}版本不兼容：没有已完成的应用迁移"
        )));
    }
    let applied_versions: Vec<i64> = applied_migrations
        .iter()
        .map(|(version, _)| *version)
        .collect();
    let current_version = MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .max()
        .unwrap_or(0);
    for (version, checksum) in &applied_migrations {
        let Some(migration) = MIGRATOR
            .iter()
            .find(|migration| migration.version == *version)
        else {
            return Err(AppError::Other(format!(
                "{label}版本不兼容：包含未知迁移 v{version}"
            )));
        };
        if checksum.as_slice() != migration.checksum.as_ref() {
            return Err(AppError::Other(format!(
                "{label}版本不兼容：迁移 v{version} 校验和不匹配"
            )));
        }
    }
    let applied_version = applied_versions.iter().copied().max().unwrap_or(0);
    if applied_version > current_version {
        return Err(AppError::Other(format!(
            "{label}版本过新：v{applied_version}，当前支持到 v{current_version}"
        )));
    }

    for table in ["courses", "videos", "settings"] {
        let exists: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1")
                .bind(table)
                .fetch_optional(pool)
                .await?;
        if exists.is_none() {
            return Err(AppError::Other(format!(
                "{label}版本不兼容：缺少核心表 {table}"
            )));
        }
    }
    Ok(())
}

fn remove_sqlite_files(path: &Path) {
    let _ = std::fs::remove_file(path);
    remove_sqlite_sidecars(path);
}

fn remove_sqlite_sidecars(path: &Path) {
    for suffix in ["-journal", "-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", path.to_string_lossy()));
        let _ = std::fs::remove_file(sidecar);
    }
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> std::io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    if !destination.exists() {
        return std::fs::rename(source, destination);
    }

    let previous = destination_parent(destination).join(format!(
        ".{}.{}.previous",
        destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy(),
        Uuid::new_v4()
    ));
    std::fs::rename(destination, &previous)?;
    match std::fs::rename(source, destination) {
        Ok(()) => {
            let _ = std::fs::remove_file(previous);
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::rename(previous, destination);
            Err(error)
        }
    }
}

fn prune_startup_snapshots(dir: &Path, keep: usize) -> AppResult<()> {
    prune_matching_backups(dir, STARTUP_SNAPSHOT_PREFIX, keep)
}

fn prune_matching_backups(dir: &Path, prefix: &str, keep: usize) -> AppResult<()> {
    let mut snapshots = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            (entry.file_type().ok()?.is_file() && name.starts_with(prefix) && name.ends_with(".db"))
                .then_some((name, entry.path()))
        })
        .collect::<Vec<_>>();
    snapshots.sort_by(|left, right| left.0.cmp(&right.0));
    let remove_count = snapshots.len().saturating_sub(keep);
    for (_, path) in snapshots.into_iter().take(remove_count) {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    async fn read_setting(path: &Path, key: &str) -> Option<String> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .create_if_missing(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        let value = sqlx::query_scalar("SELECT value FROM settings WHERE key=?")
            .bind(key)
            .fetch_optional(&pool)
            .await
            .unwrap();
        pool.close().await;
        value
    }

    async fn integrity_status(path: &Path) -> String {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .create_if_missing(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        let status = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&pool)
            .await
            .unwrap();
        pool.close().await;
        status
    }

    async fn database_with_marker(path: &Path, marker: &str) -> Db {
        let db = Db::connect_and_migrate(path).await.unwrap();
        sqlx::query("INSERT INTO settings(key,value) VALUES('restore-marker', ?)")
            .bind(marker)
            .execute(&db.pool)
            .await
            .unwrap();
        db
    }

    #[tokio::test]
    async fn backup_is_a_consistent_independent_database() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("courseai.db"))
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings(key,value) VALUES('marker','before')")
            .execute(&db.pool)
            .await
            .unwrap();

        let destination = dir.path().join("exports").join("backup.db");
        create_database_backup(&db, &destination).await.unwrap();
        sqlx::query("UPDATE settings SET value='after' WHERE key='marker'")
            .execute(&db.pool)
            .await
            .unwrap();

        assert_eq!(
            read_setting(&destination, "marker").await,
            Some("before".into())
        );
        assert_eq!(integrity_status(&destination).await, "ok");
    }

    #[tokio::test]
    async fn backup_can_replace_an_existing_export_after_validation() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("courseai.db"))
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings(key,value) VALUES('marker','v1')")
            .execute(&db.pool)
            .await
            .unwrap();
        let destination = dir.path().join("backup.db");
        create_database_backup(&db, &destination).await.unwrap();

        sqlx::query("UPDATE settings SET value='v2' WHERE key='marker'")
            .execute(&db.pool)
            .await
            .unwrap();
        create_database_backup(&db, &destination).await.unwrap();

        assert_eq!(
            read_setting(&destination, "marker").await,
            Some("v2".into())
        );
    }

    #[tokio::test]
    async fn backup_refuses_to_overwrite_the_live_database() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("courseai.db");
        let db = Db::connect_and_migrate(&db_path).await.unwrap();

        let error = create_database_backup(&db, &db_path)
            .await
            .unwrap_err()
            .to_string();

        assert!(error.contains("不能覆盖正在使用的数据库"));
        assert_eq!(
            sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
                .fetch_one(&db.pool)
                .await
                .unwrap(),
            "ok"
        );
    }

    #[tokio::test]
    async fn backup_includes_committed_pages_that_are_still_in_wal() {
        use sqlx::sqlite::{SqliteJournalMode, SqliteSynchronous};

        let dir = tempdir().unwrap();
        let db_path = dir.path().join("wal-source.db");
        let options = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("PRAGMA wal_autocheckpoint=0")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings(key,value) VALUES('wal-marker','committed')")
            .execute(&pool)
            .await
            .unwrap();
        let wal_path = PathBuf::from(format!("{}-wal", db_path.to_string_lossy()));
        assert!(wal_path.metadata().unwrap().len() > 0);

        let db = Db {
            pool,
            path: db_path,
        };
        let destination = dir.path().join("wal-backup.db");
        create_database_backup(&db, &destination).await.unwrap();

        assert_eq!(
            read_setting(&destination, "wal-marker").await,
            Some("committed".into())
        );
    }

    #[tokio::test]
    async fn invalid_foreign_keys_do_not_replace_a_previous_good_backup() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("courseai.db"))
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings(key,value) VALUES('marker','good')")
            .execute(&db.pool)
            .await
            .unwrap();
        let destination = dir.path().join("backup.db");
        create_database_backup(&db, &destination).await.unwrap();

        let mut connection = db.pool.acquire().await.unwrap();
        sqlx::query("PRAGMA foreign_keys=OFF")
            .execute(&mut *connection)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO concepts(id,course_id,name,created_at)
             VALUES('orphan','missing-course','Orphan',0)",
        )
        .execute(&mut *connection)
        .await
        .unwrap();
        drop(connection);

        let error = create_database_backup(&db, &destination)
            .await
            .unwrap_err()
            .to_string();

        assert!(error.contains("外键检查失败"));
        assert_eq!(
            read_setting(&destination, "marker").await,
            Some("good".into())
        );
        assert_eq!(integrity_status(&destination).await, "ok");
    }

    #[tokio::test]
    async fn restore_is_staged_with_a_snapshot_then_applied_before_connecting() {
        let dir = tempdir().unwrap();
        let live_path = dir.path().join("courseai.db");
        let live = database_with_marker(&live_path, "current").await;
        let source_path = dir.path().join("selected-backup.db");
        let source = database_with_marker(&source_path, "restored").await;
        source.pool.close().await;

        let outcome = stage_database_restore(&live, &source_path, dir.path())
            .await
            .unwrap();

        assert!(outcome.requires_restart);
        assert!(!outcome.restart_requested);
        assert_eq!(
            read_setting(&live_path, "restore-marker").await,
            Some("current".into())
        );
        assert_eq!(
            read_setting(Path::new(&outcome.snapshot_path), "restore-marker").await,
            Some("current".into())
        );
        assert!(dir
            .path()
            .join(PENDING_RESTORE_DIR)
            .join(PENDING_RESTORE_MANIFEST)
            .is_file());

        sqlx::query("UPDATE settings SET value='last-minute' WHERE key='restore-marker'")
            .execute(&live.pool)
            .await
            .unwrap();
        live.pool.close().await;
        assert!(apply_pending_restore(dir.path(), &live_path).await.unwrap());
        let restored = Db::connect_and_migrate(&live_path).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='restore-marker'",
            )
            .fetch_one(&restored.pool)
            .await
            .unwrap(),
            "restored"
        );
        assert_eq!(
            read_setting(Path::new(&outcome.snapshot_path), "restore-marker").await,
            Some("last-minute".into())
        );
        assert!(!dir
            .path()
            .join(PENDING_RESTORE_DIR)
            .join(PENDING_RESTORE_MANIFEST)
            .exists());
    }

    #[tokio::test]
    async fn restore_rejects_a_future_schema_without_staging_or_touching_live_data() {
        let dir = tempdir().unwrap();
        let live_path = dir.path().join("courseai.db");
        let live = database_with_marker(&live_path, "current").await;
        let source_path = dir.path().join("future.db");
        let source = database_with_marker(&source_path, "future").await;
        sqlx::query(
            "INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) \
             VALUES(999,'future',1,X'00',0)",
        )
        .execute(&source.pool)
        .await
        .unwrap();
        source.pool.close().await;

        let error = stage_database_restore(&live, &source_path, dir.path())
            .await
            .unwrap_err()
            .to_string();

        assert!(error.contains("未知迁移 v999"));
        assert_eq!(
            read_setting(&live_path, "restore-marker").await,
            Some("current".into())
        );
        assert!(!dir.path().join("backups/restore").exists());
        assert!(!dir
            .path()
            .join(PENDING_RESTORE_DIR)
            .join(PENDING_RESTORE_MANIFEST)
            .exists());
    }

    #[tokio::test]
    async fn corrupted_staged_restore_never_replaces_the_live_database() {
        let dir = tempdir().unwrap();
        let live_path = dir.path().join("courseai.db");
        let live = database_with_marker(&live_path, "current").await;
        let source_path = dir.path().join("selected-backup.db");
        let source = database_with_marker(&source_path, "restored").await;
        source.pool.close().await;
        stage_database_restore(&live, &source_path, dir.path())
            .await
            .unwrap();
        live.pool.close().await;

        std::fs::write(
            dir.path()
                .join(PENDING_RESTORE_DIR)
                .join(PENDING_RESTORE_FILE),
            b"not sqlite",
        )
        .unwrap();
        let error = apply_pending_restore(dir.path(), &live_path)
            .await
            .unwrap_err()
            .to_string();

        assert!(error.contains("不是可读取的 SQLite 数据库") || error.contains("database"));
        assert_eq!(
            read_setting(&live_path, "restore-marker").await,
            Some("current".into())
        );
        assert!(dir
            .path()
            .join(PENDING_RESTORE_DIR)
            .join(PENDING_RESTORE_MANIFEST)
            .is_file());
    }

    #[tokio::test]
    async fn repeated_startups_on_the_same_day_reuse_one_snapshot() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("courseai.db"))
            .await
            .unwrap();

        let first = create_startup_snapshot(&db, dir.path()).await.unwrap();
        let second = create_startup_snapshot(&db, dir.path()).await.unwrap();

        assert_eq!(first, second);
        let count = std::fs::read_dir(first.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("db"))
            .count();
        assert_eq!(count, 1);
    }

    #[test]
    fn rolling_snapshots_keep_only_the_newest_files() {
        let dir = tempdir().unwrap();
        for index in 0..7 {
            std::fs::write(
                dir.path().join(format!(
                    "{STARTUP_SNAPSHOT_PREFIX}2026080{index}-000000-000.db"
                )),
                [],
            )
            .unwrap();
        }
        std::fs::write(dir.path().join("manual-backup.db"), []).unwrap();

        prune_startup_snapshots(dir.path(), 5).unwrap();

        let mut names = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(names.len(), 6);
        assert!(!names.iter().any(|name| name.contains("20260800")));
        assert!(!names.iter().any(|name| name.contains("20260801")));
        assert!(names.iter().any(|name| name == "manual-backup.db"));
    }
}
