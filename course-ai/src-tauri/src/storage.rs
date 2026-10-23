use std::path::{Path, PathBuf};

pub fn video_data_dir(video_file: &Path, video_id: &str, override_root: Option<&Path>) -> PathBuf {
    if let Some(root) = override_root {
        return root.join(video_id);
    }
    sibling_data_root(video_file).join(video_id)
}

/// 没指定存储位置时，视频的数据目录建在它旁边的 `.courseai` 里。
fn sibling_data_root(video_file: &Path) -> PathBuf {
    let parent = video_file.parent().unwrap_or_else(|| Path::new("."));
    parent.join(".courseai")
}

/// 视频旁边建不建得出 `.courseai`。只读网盘、光盘、没有写权限的目录都建不出来，
/// 这时数据目录得另找地方，不然导入直接报「拒绝访问」。
pub fn sibling_data_root_writable(video_file: &Path) -> bool {
    std::fs::create_dir_all(sibling_data_root(video_file)).is_ok()
}

/// iOS 应用沙盒路径里的固定段：`…/Containers/Data/Application/<UUID>/…`。
///
/// 应用每次更新或重装，`<UUID>` 都会换一个（数据会跟着搬过去），而库里存的是绝对路径——
/// 课程目录、视频文件、数据目录、课件图全都还指着旧沙盒，视频打不开也处理不了，
/// 报的是 AVFoundation 找不到文件。
const IOS_CONTAINER_MARKER: &str = "/Containers/Data/Application/";

/// 存绝对路径的列（都是本机字段，不参与云同步，改写不会产生同步记录）。
const PATH_COLUMNS: &[(&str, &str)] = &[
    ("courses", "root_path"),
    ("courses", "cover_image"),
    ("videos", "file_path"),
    ("videos", "data_dir"),
    ("videos", "subtitle_path"),
    ("slides", "image_path"),
    ("slides", "composed_path"),
    ("screenshots", "image_path"),
];

/// 路径所在的 iOS 应用沙盒根（`…/Containers/Data/Application/<UUID>`）；不在沙盒里返回 None。
pub fn ios_container_root(path: &str) -> Option<&str> {
    let start = path.find(IOS_CONTAINER_MARKER)? + IOS_CONTAINER_MARKER.len();
    let end = start + 36;
    let id = path.get(start..end)?;
    let is_uuid = id.chars().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => c == '-',
        _ => c.is_ascii_hexdigit(),
    });
    if !is_uuid {
        return None;
    }
    match path.as_bytes().get(end) {
        None | Some(b'/') => Some(&path[..end]),
        _ => None,
    }
}

/// 把指向旧沙盒的路径换到当前沙盒下；已在当前沙盒或不在沙盒里的返回 None。
pub fn rebase_into_container(path: &str, current_root: &str) -> Option<String> {
    let old_root = ios_container_root(path)?;
    (old_root != current_root).then(|| format!("{current_root}{}", &path[old_root.len()..]))
}

/// 启动时把库里指向旧沙盒的绝对路径改到当前沙盒，返回改了几处。
pub async fn rebase_ios_container_paths(
    db: &crate::db::Db,
    current_root: &str,
) -> crate::error::AppResult<usize> {
    let mut tx = db.pool.begin().await?;
    let mut changed = 0;
    for (table, column) in PATH_COLUMNS {
        let rows: Vec<(i64, String)> = sqlx::query_as(&format!(
            "SELECT rowid, {column} FROM {table} WHERE {column} LIKE '%{IOS_CONTAINER_MARKER}%'"
        ))
        .fetch_all(&mut *tx)
        .await?;
        for (rowid, path) in rows {
            if let Some(rebased) = rebase_into_container(&path, current_root) {
                sqlx::query(&format!("UPDATE {table} SET {column}=? WHERE rowid=?"))
                    .bind(rebased)
                    .bind(rowid)
                    .execute(&mut *tx)
                    .await?;
                changed += 1;
            }
        }
    }
    tx.commit().await?;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "/private/var/mobile/Containers/Data/Application/ED356AE8-4EBD-4E2F-A992-404E22A2201C";
    const NEW: &str = "/var/mobile/Containers/Data/Application/7FEE1FE0-B861-4BBE-AB18-1EF09CF3ABE3";

    #[test]
    fn finds_the_ios_container_root() {
        let path = format!("{OLD}/Library/Application Support/dev.courseai.app/courses/网课/01.mp4");
        assert_eq!(ios_container_root(&path), Some(OLD));
        assert_eq!(ios_container_root(OLD), Some(OLD));
        assert_eq!(ios_container_root("/Users/me/courses/01.mp4"), None);
        assert_eq!(
            ios_container_root("/var/mobile/Containers/Data/Application/not-a-uuid/x"),
            None
        );
    }

    #[test]
    fn rebases_paths_from_an_old_container_only() {
        let path = format!("{OLD}/Library/Application Support/dev.courseai.app/courses/网课/01.mp4");
        assert_eq!(
            rebase_into_container(&path, NEW).as_deref(),
            Some(format!("{NEW}/Library/Application Support/dev.courseai.app/courses/网课/01.mp4").as_str())
        );
        let current = format!("{NEW}/Library/x.mp4");
        assert_eq!(rebase_into_container(&current, NEW), None);
        assert_eq!(rebase_into_container("C:\\网课\\01.mp4", NEW), None);
    }

    #[tokio::test]
    async fn rebases_stored_paths_after_the_container_moves() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let root = format!("{OLD}/Library/Application Support/dev.courseai.app/courses/网课");
        let course = crate::commands::courses::create_course(&db, "网课".into(), root.clone())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at)
             VALUES ('v1',?,'第一讲','local',?,?,0)",
        )
        .bind(&course.id)
        .bind(format!("{root}/01.mp4"))
        .bind(format!("{root}/.courseai/v1"))
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO slides(video_id,image_path,start_ms,page_no) VALUES ('v1',?,0,1)",
        )
        .bind(format!("{root}/.courseai/v1/slides/0001.jpg"))
        .execute(&db.pool)
        .await
        .unwrap();

        // 种数据时插入触发器写的同步记录清掉，好看清改路径本身会不会产生同步记录。
        sqlx::query("DELETE FROM sync_outbox").execute(&db.pool).await.unwrap();

        assert_eq!(rebase_ios_container_paths(&db, NEW).await.unwrap(), 4);
        let (file, data_dir): (String, String) =
            sqlx::query_as("SELECT file_path, data_dir FROM videos WHERE id='v1'")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(file.starts_with(NEW) && file.ends_with("/courses/网课/01.mp4"), "{file}");
        assert!(data_dir.starts_with(NEW), "{data_dir}");
        let outbox: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_outbox")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(outbox, 0, "路径是本机字段，改写不该产生同步记录");
        // 已经在当前沙盒里的不再改。
        assert_eq!(rebase_ios_container_paths(&db, NEW).await.unwrap(), 0);
    }

    #[test]
    fn defaults_to_sibling_courseai_dir() {
        let path = video_data_dir(Path::new("/courses/01.mp4"), "abc", None);
        assert_eq!(path, PathBuf::from("/courses/.courseai/abc"));
    }

    #[test]
    fn uses_override_root_when_provided() {
        let path = video_data_dir(
            Path::new("/anywhere/v.mp4"),
            "abc",
            Some(&PathBuf::from("/global/store")),
        );
        assert_eq!(path, PathBuf::from("/global/store/abc"));
    }

    #[cfg(unix)]
    #[test]
    fn sibling_data_root_is_not_writable_in_a_read_only_folder() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let writable = dir.path().join("ok").join("v.mp4");
        assert!(sibling_data_root_writable(&writable));

        let locked = dir.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        let readonly = locked.join("v.mp4");
        let result = sibling_data_root_writable(&readonly);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!result);
    }
}
