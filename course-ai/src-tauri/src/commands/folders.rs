//! 课程内的多级文件夹。纯逻辑分组：视频文件在磁盘上的位置不变。
//!
//! 排序约定（见迁移 0042）：同一门课里文件夹和视频共用一条 order_index 序列，按树的先序编号，
//! 文件夹自己的号排在它的内容之前。兄弟之间按 order_index 排就是界面顺序；全课程按
//! videos.order_index 排就是教材顺序。任何移动 / 排序之后都整课重编号（[`renumber_course`]），
//! 只写号变了的行，并拨它们的同步时钟。
//!
//! parent_id / folder_id 指向不存在的文件夹（同步时父还没到、或被别的设备删了）、
//! 或者并发移动造成了环时，一律按「在课程根目录」处理。

use crate::commands::courses::{AppState, COURSE_COLORS};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Sqlite, Transaction};
use std::collections::{HashMap, HashSet};
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, PartialEq)]
pub struct Folder {
    pub id: String,
    pub course_id: String,
    /// 上级文件夹；None = 课程根目录。已归一化：不会指向不存在的文件夹，也不会成环。
    pub parent_id: Option<String>,
    pub name: String,
    pub color: Option<String>,
    pub order_index: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    Folder,
    Video,
}

/// 树上的一项：文件夹或视频。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ItemRef {
    pub kind: ItemKind,
    pub id: String,
}

const STALE: &str = "列表已变化，请刷新后重试";

fn clean_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Other("文件夹名称不能为空".into()));
    }
    Ok(name.to_string())
}

/// 把 parent 归一化：指向集合外的、以及处在环上的，都改成 None（根目录）。
fn normalize_parents(parents: &mut HashMap<String, Option<String>>) {
    let ids: HashSet<String> = parents.keys().cloned().collect();
    for parent in parents.values_mut() {
        if parent.as_ref().is_some_and(|p| !ids.contains(p)) {
            *parent = None;
        }
    }
    // 按 id 排序后逐个检查：沿父链走，回到自己就说明在环上，断开自己这一环。
    let mut sorted: Vec<String> = ids.into_iter().collect();
    sorted.sort();
    for id in sorted {
        let mut seen = HashSet::new();
        let mut cursor = parents.get(&id).cloned().flatten();
        while let Some(current) = cursor {
            if current == id {
                parents.insert(id.clone(), None);
                break;
            }
            if !seen.insert(current.clone()) {
                break;
            }
            cursor = parents.get(&current).cloned().flatten();
        }
    }
}

/// 一门课的树：文件夹的（已归一化）上级、视频所在文件夹，以及各项现在的号。
struct CourseTree {
    folder_parent: HashMap<String, Option<String>>,
    video_folder: HashMap<String, Option<String>>,
    order: HashMap<ItemRef, (i64, i64)>,
}

impl CourseTree {
    async fn load(tx: &mut Transaction<'_, Sqlite>, course_id: &str) -> AppResult<Self> {
        let folders: Vec<(String, Option<String>, i64, i64)> = sqlx::query_as(
            "SELECT id, parent_id, order_index, created_at FROM folders WHERE course_id=?",
        )
        .bind(course_id)
        .fetch_all(&mut **tx)
        .await?;
        let videos: Vec<(String, Option<String>, i64, i64)> = sqlx::query_as(
            "SELECT id, folder_id, order_index, created_at FROM videos
             WHERE course_id=? AND deleted_at IS NULL",
        )
        .bind(course_id)
        .fetch_all(&mut **tx)
        .await?;
        let mut folder_parent: HashMap<String, Option<String>> = folders
            .iter()
            .map(|(id, parent, _, _)| (id.clone(), parent.clone()))
            .collect();
        normalize_parents(&mut folder_parent);
        let video_folder = videos
            .iter()
            .map(|(id, folder, _, _)| {
                let folder = folder.clone().filter(|f| folder_parent.contains_key(f));
                (id.clone(), folder)
            })
            .collect();
        let mut order = HashMap::new();
        for (id, _, index, created) in &folders {
            order.insert(
                ItemRef {
                    kind: ItemKind::Folder,
                    id: id.clone(),
                },
                (*index, *created),
            );
        }
        for (id, _, index, created) in &videos {
            order.insert(
                ItemRef {
                    kind: ItemKind::Video,
                    id: id.clone(),
                },
                (*index, *created),
            );
        }
        Ok(Self {
            folder_parent,
            video_folder,
            order,
        })
    }

    fn container_of(&self, item: &ItemRef) -> Option<Option<String>> {
        match item.kind {
            ItemKind::Folder => self.folder_parent.get(&item.id).cloned(),
            ItemKind::Video => self.video_folder.get(&item.id).cloned(),
        }
    }

    /// 某个容器（None = 根）里的直接子项，按现有顺序。
    fn children(&self, container: &Option<String>, keys: &HashMap<ItemRef, i64>) -> Vec<ItemRef> {
        let mut items: Vec<ItemRef> = self
            .folder_parent
            .iter()
            .filter(|(_, parent)| *parent == container)
            .map(|(id, _)| ItemRef {
                kind: ItemKind::Folder,
                id: id.clone(),
            })
            .chain(
                self.video_folder
                    .iter()
                    .filter(|(_, folder)| *folder == container)
                    .map(|(id, _)| ItemRef {
                        kind: ItemKind::Video,
                        id: id.clone(),
                    }),
            )
            .collect();
        items.sort_by(|a, b| {
            let (a_index, a_created) = self.order[a];
            let (b_index, b_created) = self.order[b];
            let a_key = keys.get(a).copied().unwrap_or(a_index);
            let b_key = keys.get(b).copied().unwrap_or(b_index);
            (a_key, a_created, &a.id).cmp(&(b_key, b_created, &b.id))
        });
        items
    }

    /// 文件夹自己加上它下面所有层级的文件夹。
    fn subtree_folders(&self, root: &str) -> HashSet<String> {
        let mut out = HashSet::from([root.to_string()]);
        loop {
            let before = out.len();
            for (id, parent) in &self.folder_parent {
                if parent.as_ref().is_some_and(|p| out.contains(p)) {
                    out.insert(id.clone());
                }
            }
            if out.len() == before {
                return out;
            }
        }
    }

    /// 先序编号：`keys` 覆盖兄弟之间的排序键（移动 / 拖动排序时用）。
    fn numbering(&self, keys: &HashMap<ItemRef, i64>) -> Vec<(ItemRef, i64)> {
        let mut out = Vec::with_capacity(self.order.len());
        let mut stack: Vec<ItemRef> = self.children(&None, keys).into_iter().rev().collect();
        while let Some(item) = stack.pop() {
            if item.kind == ItemKind::Folder {
                let kids = self.children(&Some(item.id.clone()), keys);
                stack.extend(kids.into_iter().rev());
            }
            let next = out.len() as i64;
            out.push((item, next));
        }
        out
    }
}

/// 整课重编号，只写号变了的行（并拨同步时钟）。
async fn renumber_course(
    tx: &mut Transaction<'_, Sqlite>,
    course_id: &str,
    keys: &HashMap<ItemRef, i64>,
    now: i64,
) -> AppResult<()> {
    let tree = CourseTree::load(tx, course_id).await?;
    for (item, index) in tree.numbering(keys) {
        if tree.order[&item].0 == index {
            continue;
        }
        let sql = match item.kind {
            ItemKind::Folder => "UPDATE folders SET order_index=?, updated_at=? WHERE id=?",
            ItemKind::Video => "UPDATE videos SET order_index=?, sync_updated_at=? WHERE id=?",
        };
        sqlx::query(sql)
            .bind(index)
            .bind(now)
            .bind(&item.id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

async fn ensure_active_course(tx: &mut Transaction<'_, Sqlite>, course_id: &str) -> AppResult<()> {
    let active: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM courses WHERE id=? AND deleted_at IS NULL)",
    )
    .bind(course_id)
    .fetch_one(&mut **tx)
    .await?;
    if !active {
        return Err(AppError::NotFound(format!("course {course_id}")));
    }
    Ok(())
}

async fn folder_course(tx: &mut Transaction<'_, Sqlite>, id: &str) -> AppResult<String> {
    sqlx::query_scalar("SELECT course_id FROM folders WHERE id=?")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("folder {id}")))
}

pub async fn list_folders(db: &Db, course_id: &str) -> AppResult<Vec<Folder>> {
    let mut folders: Vec<Folder> = sqlx::query_as(
        "SELECT id,course_id,parent_id,name,color,order_index,created_at,updated_at
         FROM folders WHERE course_id=? ORDER BY order_index, created_at, id",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?;
    let mut parents: HashMap<String, Option<String>> = folders
        .iter()
        .map(|folder| (folder.id.clone(), folder.parent_id.clone()))
        .collect();
    normalize_parents(&mut parents);
    for folder in &mut folders {
        folder.parent_id = parents.remove(&folder.id).flatten();
    }
    Ok(folders)
}

/// 在课程（或某个文件夹）里新建文件夹，排在该层最后。
pub async fn create_folder(
    db: &Db,
    course_id: &str,
    parent_id: Option<String>,
    name: &str,
) -> AppResult<Folder> {
    let name = clean_name(name)?;
    let mut tx = db.pool.begin_with("BEGIN IMMEDIATE").await?;
    ensure_active_course(&mut tx, course_id).await?;
    if let Some(parent) = &parent_id {
        if folder_course(&mut tx, parent).await? != course_id {
            return Err(AppError::Other("上级文件夹不在这门课里".into()));
        }
    }
    let now = Utc::now().timestamp_millis();
    let id = Uuid::new_v4().to_string();
    // 排序键取全课最大 + 1：在它那一层里自然排最后，重编号再把后面的让开。
    let tree = CourseTree::load(&mut tx, course_id).await?;
    let key = tree.order.values().map(|(index, _)| *index).max().unwrap_or(-1) + 1;
    sqlx::query(
        "INSERT INTO folders(id,course_id,parent_id,name,order_index,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(course_id)
    .bind(&parent_id)
    .bind(&name)
    .bind(key)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    renumber_course(&mut tx, course_id, &HashMap::new(), now).await?;
    let folder: Folder = sqlx::query_as(
        "SELECT id,course_id,parent_id,name,color,order_index,created_at,updated_at
         FROM folders WHERE id=?",
    )
    .bind(&id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(folder)
}

pub async fn rename_folder(db: &Db, id: &str, name: &str) -> AppResult<()> {
    let name = clean_name(name)?;
    let result = sqlx::query("UPDATE folders SET name=?, updated_at=? WHERE id=?")
        .bind(&name)
        .bind(Utc::now().timestamp_millis())
        .bind(id)
        .execute(&db.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("folder {id}")));
    }
    Ok(())
}

pub async fn set_folder_color(db: &Db, id: &str, color: Option<String>) -> AppResult<()> {
    if let Some(color) = &color {
        if !COURSE_COLORS.contains(&color.as_str()) {
            return Err(AppError::Other(format!("未知的颜色：{color}")));
        }
    }
    let result = sqlx::query("UPDATE folders SET color=?, updated_at=? WHERE id=?")
        .bind(&color)
        .bind(Utc::now().timestamp_millis())
        .bind(id)
        .execute(&db.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("folder {id}")));
    }
    Ok(())
}

/// 文件夹（含各级子文件夹）里所有未删除的视频 id。删除前先拿来取消处理任务。
pub async fn folder_video_ids(db: &Db, id: &str) -> AppResult<Vec<String>> {
    let mut tx = db.pool.begin().await?;
    let course_id = folder_course(&mut tx, id).await?;
    let tree = CourseTree::load(&mut tx, &course_id).await?;
    let folders = tree.subtree_folders(id);
    let mut ids: Vec<String> = tree
        .video_folder
        .iter()
        .filter(|(_, folder)| folder.as_ref().is_some_and(|f| folders.contains(f)))
        .map(|(video, _)| video.clone())
        .collect();
    ids.sort();
    tx.commit().await?;
    Ok(ids)
}

/// 删除文件夹：各级子文件夹一并删掉，里面的视频移入回收站（恢复后回到课程根目录）。
pub async fn delete_folder(db: &Db, id: &str) -> AppResult<()> {
    let mut tx = db.pool.begin_with("BEGIN IMMEDIATE").await?;
    let course_id = folder_course(&mut tx, id).await?;
    let tree = CourseTree::load(&mut tx, &course_id).await?;
    let folders = tree.subtree_folders(id);
    let now = Utc::now().timestamp_millis();
    for (video, folder) in &tree.video_folder {
        if folder.as_ref().is_some_and(|f| folders.contains(f)) {
            sqlx::query("UPDATE videos SET deleted_at=?, trash_changed_at=? WHERE id=?")
                .bind(now)
                .bind(now)
                .bind(video)
                .execute(&mut *tx)
                .await?;
        }
    }
    for folder in &folders {
        sqlx::query("DELETE FROM folders WHERE id=?")
            .bind(folder)
            .execute(&mut *tx)
            .await?;
    }
    renumber_course(&mut tx, &course_id, &HashMap::new(), now).await?;
    tx.commit().await?;
    Ok(())
}

/// 把若干文件夹 / 视频移到目标课程的某一层（None = 根目录），排在该层最后。
/// 可以跨课程：文件夹连同下面的一切一起搬。选中项若已在另一个被选中的文件夹里，跟着那个文件夹走。
pub async fn move_items(
    db: &Db,
    target_course: &str,
    target_folder: Option<String>,
    items: Vec<ItemRef>,
) -> AppResult<()> {
    let mut tx = db.pool.begin_with("BEGIN IMMEDIATE").await?;
    ensure_active_course(&mut tx, target_course).await?;
    if let Some(folder) = &target_folder {
        if folder_course(&mut tx, folder).await? != target_course {
            return Err(AppError::Other("目标文件夹不在这门课里".into()));
        }
    }

    // 每一项所在的课程。
    let mut sources: Vec<String> = Vec::new();
    let mut item_course: HashMap<ItemRef, String> = HashMap::new();
    for item in &items {
        let course: Option<String> = match item.kind {
            ItemKind::Folder => sqlx::query_scalar("SELECT course_id FROM folders WHERE id=?"),
            ItemKind::Video => sqlx::query_scalar(
                "SELECT course_id FROM videos WHERE id=? AND deleted_at IS NULL",
            ),
        }
        .bind(&item.id)
        .fetch_optional(&mut *tx)
        .await?;
        let course = course.ok_or_else(|| AppError::NotFound(STALE.into()))?;
        if !sources.contains(&course) {
            sources.push(course.clone());
        }
        item_course.insert(item.clone(), course);
    }

    let now = Utc::now().timestamp_millis();
    let target_tree = CourseTree::load(&mut tx, target_course).await?;
    let mut next_key = target_tree
        .order
        .values()
        .map(|(index, _)| *index)
        .max()
        .unwrap_or(-1)
        + 1;
    // 要搬的整批行（含被选文件夹下面的一切），以及它们在原课程里的号（保持相对顺序）。
    let mut relocated: Vec<(ItemRef, i64)> = Vec::new();
    let mut roots: HashSet<ItemRef> = HashSet::new();
    for source in &sources {
        let tree = CourseTree::load(&mut tx, source).await?;
        let selected: Vec<&ItemRef> = items
            .iter()
            .filter(|item| item_course[*item] == *source)
            .collect();
        let selected_folders: Vec<&str> = selected
            .iter()
            .filter(|item| item.kind == ItemKind::Folder)
            .map(|item| item.id.as_str())
            .collect();
        let mut covered: HashSet<String> = HashSet::new();
        for folder in &selected_folders {
            let subtree = tree.subtree_folders(folder);
            if target_folder.as_ref().is_some_and(|t| subtree.contains(t)) {
                return Err(AppError::Other("不能把文件夹移到它自己里面".into()));
            }
            covered.extend(subtree);
        }
        for item in &selected {
            // 上级落在某个被选文件夹的子树里：它只是跟着那个文件夹走，层级不变。
            let nested = tree
                .container_of(item)
                .flatten()
                .is_some_and(|parent| covered.contains(&parent));
            if !nested {
                roots.insert((*item).clone());
            }
        }
        for (item, (index, _)) in &tree.order {
            let inside = match item.kind {
                ItemKind::Folder => covered.contains(&item.id),
                ItemKind::Video => tree
                    .video_folder
                    .get(&item.id)
                    .cloned()
                    .flatten()
                    .is_some_and(|f| covered.contains(&f)),
            };
            if inside || roots.contains(item) {
                relocated.push((item.clone(), *index));
            }
        }
    }
    relocated.sort_by(|a, b| (a.1, &a.0.id).cmp(&(b.1, &b.0.id)));
    relocated.dedup_by(|a, b| a.0 == b.0);

    let mut keys: HashMap<ItemRef, i64> = HashMap::new();
    for (item, _) in &relocated {
        keys.insert(item.clone(), next_key);
        next_key += 1;
        let (move_sql, place_sql) = match item.kind {
            ItemKind::Folder => (
                "UPDATE folders SET course_id=?, updated_at=? WHERE id=?",
                "UPDATE folders SET parent_id=? WHERE id=?",
            ),
            ItemKind::Video => (
                "UPDATE videos SET course_id=?, sync_updated_at=? WHERE id=?",
                "UPDATE videos SET folder_id=? WHERE id=?",
            ),
        };
        sqlx::query(move_sql)
            .bind(target_course)
            .bind(now)
            .bind(&item.id)
            .execute(&mut *tx)
            .await?;
        // 只有被选中的最外层项换上级；跟着走的保留原来的上级。
        if roots.contains(item) {
            sqlx::query(place_sql)
                .bind(&target_folder)
                .bind(&item.id)
                .execute(&mut *tx)
                .await?;
        }
    }

    for source in &sources {
        if source != target_course {
            renumber_course(&mut tx, source, &HashMap::new(), now).await?;
        }
    }
    renumber_course(&mut tx, target_course, &keys, now).await?;
    tx.commit().await?;
    Ok(())
}

/// 拖动排序：`ordered` 必须正好是该层（None = 根目录）现有的全部子项。
pub async fn reorder_container(
    db: &Db,
    course_id: &str,
    folder_id: Option<String>,
    ordered: Vec<ItemRef>,
) -> AppResult<()> {
    let mut tx = db.pool.begin_with("BEGIN IMMEDIATE").await?;
    ensure_active_course(&mut tx, course_id).await?;
    let tree = CourseTree::load(&mut tx, course_id).await?;
    let mut current = tree.children(&folder_id, &HashMap::new());
    let mut requested = ordered.clone();
    let by_key = |a: &ItemRef, b: &ItemRef| (a.kind as u8, &a.id).cmp(&(b.kind as u8, &b.id));
    current.sort_by(by_key);
    requested.sort_by(by_key);
    if current != requested {
        return Err(AppError::Other(STALE.into()));
    }
    let keys: HashMap<ItemRef, i64> = ordered
        .into_iter()
        .enumerate()
        .map(|(index, item)| (item, index as i64))
        .collect();
    renumber_course(&mut tx, course_id, &keys, Utc::now().timestamp_millis()).await?;
    tx.commit().await?;
    Ok(())
}

/// 文件夹集合外的 folder_id（同步时父还没到、或已被删）按根目录处理。
pub async fn normalize_video_folders<T>(
    db: &Db,
    course_id: &str,
    videos: &mut [T],
    folder_of: impl Fn(&mut T) -> &mut Option<String>,
) -> AppResult<()> {
    let ids: HashSet<String> = sqlx::query_scalar("SELECT id FROM folders WHERE course_id=?")
        .bind(course_id)
        .fetch_all(&db.pool)
        .await?
        .into_iter()
        .collect();
    for video in videos {
        let folder = folder_of(video);
        if folder.as_ref().is_some_and(|f| !ids.contains(f)) {
            *folder = None;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_list_folders(
    state: State<'_, AppState>,
    course_id: String,
) -> AppResult<Vec<Folder>> {
    list_folders(&state.db, &course_id).await
}

#[tauri::command]
pub async fn cmd_create_folder(
    state: State<'_, AppState>,
    course_id: String,
    parent_id: Option<String>,
    name: String,
) -> AppResult<Folder> {
    create_folder(&state.db, &course_id, parent_id, &name).await
}

#[tauri::command]
pub async fn cmd_rename_folder(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> AppResult<()> {
    rename_folder(&state.db, &id, &name).await
}

#[tauri::command]
pub async fn cmd_set_folder_color(
    state: State<'_, AppState>,
    id: String,
    color: Option<String>,
) -> AppResult<()> {
    set_folder_color(&state.db, &id, color).await
}

#[tauri::command]
pub async fn cmd_delete_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    for video_id in folder_video_ids(&state.db, &id).await? {
        crate::pipeline::cancel_processing(&app, &video_id).await?;
    }
    delete_folder(&state.db, &id).await
}

#[tauri::command]
pub async fn cmd_move_items(
    state: State<'_, AppState>,
    course_id: String,
    folder_id: Option<String>,
    items: Vec<ItemRef>,
) -> AppResult<()> {
    move_items(&state.db, &course_id, folder_id, items).await
}

#[tauri::command]
pub async fn cmd_reorder_container(
    state: State<'_, AppState>,
    course_id: String,
    folder_id: Option<String>,
    items: Vec<ItemRef>,
) -> AppResult<()> {
    reorder_container(&state.db, &course_id, folder_id, items).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::courses::create_course;
    use crate::commands::videos::list_videos_for_ui;

    async fn fresh_db() -> Db {
        Db::connect_and_migrate(&crate::db::test_db_path("folders"))
            .await
            .unwrap()
    }

    async fn video(db: &Db, course: &str, title: &str) -> String {
        let id = Uuid::new_v4().to_string();
        let order: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(order_index),-1)+1 FROM videos WHERE course_id=?",
        )
        .bind(course)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at,order_index)
             VALUES (?,?,?,'local','/x.mp4','/d',1,?)",
        )
        .bind(&id)
        .bind(course)
        .bind(title)
        .bind(order)
        .execute(&db.pool)
        .await
        .unwrap();
        id
    }

    fn v(id: &str) -> ItemRef {
        ItemRef {
            kind: ItemKind::Video,
            id: id.into(),
        }
    }

    fn f(id: &str) -> ItemRef {
        ItemRef {
            kind: ItemKind::Folder,
            id: id.into(),
        }
    }

    /// 课程的先序视图：每一项一行，缩进表示层级。
    async fn outline(db: &Db, course: &str) -> Vec<String> {
        let folders = list_folders(db, course).await.unwrap();
        let videos = list_videos_for_ui(db, course).await.unwrap();
        let mut items: Vec<(i64, Option<String>, String, bool, String)> = folders
            .iter()
            .map(|x| (x.order_index, x.parent_id.clone(), x.name.clone(), true, x.id.clone()))
            .chain(videos.iter().map(|x| {
                (
                    x.video.order_index,
                    x.video.folder_id.clone(),
                    x.video.title.clone(),
                    false,
                    x.video.id.clone(),
                )
            }))
            .collect();
        items.sort();
        let depth = |mut parent: Option<String>| {
            let mut d = 0;
            while let Some(p) = parent {
                d += 1;
                parent = folders.iter().find(|x| x.id == p).unwrap().parent_id.clone();
            }
            d
        };
        let lines: Vec<String> = items
            .iter()
            .map(|(_, parent, name, is_folder, _)| {
                format!(
                    "{}{}{}",
                    "  ".repeat(depth(parent.clone())),
                    name,
                    if *is_folder { "/" } else { "" }
                )
            })
            .collect();
        // 编号必须是 0..n 的先序连号。
        let numbers: Vec<i64> = items.iter().map(|x| x.0).collect();
        assert_eq!(numbers, (0..items.len() as i64).collect::<Vec<_>>());
        lines
    }

    #[tokio::test]
    async fn folders_and_videos_share_one_preorder_sequence() {
        let db = fresh_db().await;
        let course = create_course(&db, "模拟电路".into(), "/c".into()).await.unwrap().id;
        let intro = video(&db, &course, "课程介绍").await;
        let pn = video(&db, &course, "1.1 PN结").await;
        let diode = video(&db, &course, "1.2 二极管").await;
        let ch1 = create_folder(&db, &course, None, "第1章").await.unwrap();
        let ch2 = create_folder(&db, &course, None, " 第2章 ").await.unwrap();
        assert_eq!(ch2.name, "第2章");
        move_items(&db, &course, Some(ch1.id.clone()), vec![v(&pn), v(&diode)])
            .await
            .unwrap();
        let sub = create_folder(&db, &course, Some(ch2.id.clone()), "2.1 共射放大").await.unwrap();
        let amp = video(&db, &course, "共射电路").await;
        move_items(&db, &course, Some(sub.id.clone()), vec![v(&amp)]).await.unwrap();
        assert_eq!(
            outline(&db, &course).await,
            [
                "课程介绍",
                "第1章/",
                "  1.1 PN结",
                "  1.2 二极管",
                "第2章/",
                "  2.1 共射放大/",
                "    共射电路",
            ]
        );
        // 全课程按视频号排就是教材顺序。
        let flat: Vec<String> = sqlx::query_scalar(
            "SELECT title FROM videos WHERE course_id=? ORDER BY order_index",
        )
        .bind(&course)
        .fetch_all(&db.pool)
        .await
        .unwrap();
        assert_eq!(flat, ["课程介绍", "1.1 PN结", "1.2 二极管", "共射电路"]);
        let _ = intro;
    }

    #[tokio::test]
    async fn reorder_moves_folders_and_videos_together() {
        let db = fresh_db().await;
        let course = create_course(&db, "C".into(), "/c".into()).await.unwrap().id;
        let a = video(&db, &course, "a").await;
        let ch = create_folder(&db, &course, None, "ch").await.unwrap();
        let b = video(&db, &course, "b").await;
        move_items(&db, &course, Some(ch.id.clone()), vec![v(&b)]).await.unwrap();
        let z = video(&db, &course, "z").await;
        // 根目录：a, ch/, z → z, ch/, a
        reorder_container(&db, &course, None, vec![v(&z), f(&ch.id), v(&a)])
            .await
            .unwrap();
        assert_eq!(outline(&db, &course).await, ["z", "ch/", "  b", "a"]);
        // 列表过期（少一项）就拒绝，不改动。
        let err = reorder_container(&db, &course, None, vec![v(&a), f(&ch.id)])
            .await
            .unwrap_err();
        assert!(err.to_string().contains("列表已变化"), "{err}");
        assert_eq!(outline(&db, &course).await, ["z", "ch/", "  b", "a"]);
    }

    #[tokio::test]
    async fn cannot_move_a_folder_into_itself() {
        let db = fresh_db().await;
        let course = create_course(&db, "C".into(), "/c".into()).await.unwrap().id;
        let outer = create_folder(&db, &course, None, "outer").await.unwrap();
        let inner = create_folder(&db, &course, Some(outer.id.clone()), "inner").await.unwrap();
        for target in [&outer.id, &inner.id] {
            let err = move_items(&db, &course, Some(target.clone()), vec![f(&outer.id)])
                .await
                .unwrap_err();
            assert!(err.to_string().contains("自己里面"), "{err}");
        }
        // 反过来把内层提到根目录可以。
        move_items(&db, &course, None, vec![f(&inner.id)]).await.unwrap();
        assert_eq!(outline(&db, &course).await, ["outer/", "inner/"]);
    }

    #[tokio::test]
    async fn moving_a_folder_with_a_selected_child_keeps_the_child_inside() {
        let db = fresh_db().await;
        let course = create_course(&db, "C".into(), "/c".into()).await.unwrap().id;
        let ch = create_folder(&db, &course, None, "ch").await.unwrap();
        let target = create_folder(&db, &course, None, "target").await.unwrap();
        let x = video(&db, &course, "x").await;
        move_items(&db, &course, Some(ch.id.clone()), vec![v(&x)]).await.unwrap();
        move_items(&db, &course, Some(target.id.clone()), vec![v(&x), f(&ch.id)])
            .await
            .unwrap();
        assert_eq!(outline(&db, &course).await, ["target/", "  ch/", "    x"]);
    }

    #[tokio::test]
    async fn moving_across_courses_carries_the_whole_subtree() {
        let db = fresh_db().await;
        let src = create_course(&db, "src".into(), "/s".into()).await.unwrap().id;
        let dst = create_course(&db, "dst".into(), "/d".into()).await.unwrap().id;
        let keep = video(&db, &src, "keep").await;
        let ch = create_folder(&db, &src, None, "ch").await.unwrap();
        let sub = create_folder(&db, &src, Some(ch.id.clone()), "sub").await.unwrap();
        let a = video(&db, &src, "a").await;
        let b = video(&db, &src, "b").await;
        move_items(&db, &src, Some(ch.id.clone()), vec![v(&a)]).await.unwrap();
        move_items(&db, &src, Some(sub.id.clone()), vec![v(&b)]).await.unwrap();
        video(&db, &dst, "already").await;

        move_items(&db, &dst, None, vec![f(&ch.id)]).await.unwrap();
        assert_eq!(outline(&db, &src).await, ["keep"]);
        assert_eq!(
            outline(&db, &dst).await,
            // a 进 ch 时 sub 已经在里面，所以 a 排在 sub 之后。
            ["already", "ch/", "  sub/", "    b", "  a"]
        );
        let _ = keep;
    }

    #[tokio::test]
    async fn deleting_a_folder_trashes_its_videos_and_drops_subfolders() {
        let db = fresh_db().await;
        let course = create_course(&db, "C".into(), "/c".into()).await.unwrap().id;
        let ch = create_folder(&db, &course, None, "ch").await.unwrap();
        let sub = create_folder(&db, &course, Some(ch.id.clone()), "sub").await.unwrap();
        let a = video(&db, &course, "a").await;
        let b = video(&db, &course, "b").await;
        let c = video(&db, &course, "c").await;
        move_items(&db, &course, Some(ch.id.clone()), vec![v(&a)]).await.unwrap();
        move_items(&db, &course, Some(sub.id.clone()), vec![v(&b)]).await.unwrap();
        assert_eq!(folder_video_ids(&db, &ch.id).await.unwrap().len(), 2);

        delete_folder(&db, &ch.id).await.unwrap();
        assert_eq!(outline(&db, &course).await, ["c"]);
        let trashed: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM videos WHERE deleted_at IS NOT NULL AND id IN (?,?)",
        )
        .bind(&a)
        .bind(&b)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(trashed, 2);
        // 从回收站恢复：原文件夹已不在，回到根目录。
        sqlx::query("UPDATE videos SET deleted_at=NULL WHERE id=?")
            .bind(&a)
            .execute(&db.pool)
            .await
            .unwrap();
        let listed = list_videos_for_ui(&db, &course).await.unwrap();
        let restored = listed.iter().find(|x| x.video.id == a).unwrap();
        assert_eq!(restored.video.folder_id, None);
        let _ = c;
    }

    #[tokio::test]
    async fn dangling_parents_and_cycles_read_as_root() {
        let db = fresh_db().await;
        let course = create_course(&db, "C".into(), "/c".into()).await.unwrap().id;
        let p = create_folder(&db, &course, None, "p").await.unwrap();
        let q = create_folder(&db, &course, None, "q").await.unwrap();
        // 并发移动在两台设备上各做一半：p 进 q、q 进 p。
        sqlx::query("UPDATE folders SET parent_id=? WHERE id=?")
            .bind(&q.id)
            .bind(&p.id)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE folders SET parent_id=? WHERE id=?")
            .bind(&p.id)
            .bind(&q.id)
            .execute(&db.pool)
            .await
            .unwrap();
        let x = video(&db, &course, "x").await;
        sqlx::query("UPDATE videos SET folder_id='gone' WHERE id=?")
            .bind(&x)
            .execute(&db.pool)
            .await
            .unwrap();
        let folders = list_folders(&db, &course).await.unwrap();
        assert!(folders.iter().any(|folder| folder.parent_id.is_none()));
        let listed = list_videos_for_ui(&db, &course).await.unwrap();
        assert_eq!(listed[0].video.folder_id, None);
        // 结构操作照常进行，不会死循环。
        reorder_container(&db, &course, None, {
            let mut root: Vec<ItemRef> = folders
                .iter()
                .filter(|folder| folder.parent_id.is_none())
                .map(|folder| f(&folder.id))
                .collect();
            root.push(v(&x));
            root
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn folder_names_and_colors_are_validated() {
        let db = fresh_db().await;
        let course = create_course(&db, "C".into(), "/c".into()).await.unwrap().id;
        assert!(create_folder(&db, &course, None, "  ").await.is_err());
        let folder = create_folder(&db, &course, None, "a").await.unwrap();
        rename_folder(&db, &folder.id, "b").await.unwrap();
        assert!(rename_folder(&db, &folder.id, " ").await.is_err());
        set_folder_color(&db, &folder.id, Some("green".into())).await.unwrap();
        assert!(set_folder_color(&db, &folder.id, Some("#000".into())).await.is_err());
        let listed = list_folders(&db, &course).await.unwrap();
        assert_eq!((listed[0].name.as_str(), listed[0].color.as_deref()), ("b", Some("green")));
        // 上级文件夹必须在同一门课。
        let other = create_course(&db, "D".into(), "/d".into()).await.unwrap().id;
        assert!(create_folder(&db, &other, Some(folder.id.clone()), "x").await.is_err());
    }
}
