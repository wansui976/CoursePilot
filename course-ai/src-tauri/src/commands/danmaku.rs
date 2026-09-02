use crate::commands::courses::AppState;
use crate::commands::settings::get_setting;
use crate::commands::videos::Video;
use crate::error::{AppError, AppResult};
use crate::pipeline::bilibili_extra::{CommentEntry, DanmakuEntry};
use tauri::State;

async fn load_video(state: &AppState, video_id: &str) -> AppResult<Video> {
    sqlx::query_as("SELECT * FROM videos WHERE id=? AND deleted_at IS NULL")
        .bind(video_id)
        .fetch_optional(&state.db.pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("video {video_id}")))
}

async fn bilibili_cookies(state: &AppState) -> AppResult<Option<String>> {
    let raw = get_setting(&state.db, "bilibili_cookies").await?;
    // 设置里存的是 cookies 文件路径（yt-dlp 用），转成请求用的 Cookie 头。
    Ok(crate::pipeline::bilibili_extra::cookie_header_from_setting(
        raw.as_deref(),
    ))
}

/// 读取某视频的全部弹幕（按时间排序）。库里没有且是在线 B 站视频时先抓一次写库。
#[tauri::command]
pub async fn cmd_get_danmaku(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<Vec<DanmakuEntry>> {
    let video = load_video(&state, &video_id).await?;
    let cookies = bilibili_cookies(&state).await?;
    crate::pipeline::bilibili_extra::ensure_danmaku(
        &state.db,
        &video.id,
        &video.source_type,
        video.source_uri.as_deref(),
        video.bilibili_cid.as_deref(),
        cookies.as_deref(),
    )
    .await?;
    Ok(sqlx::query_as::<_, DanmakuRow>(
        "SELECT mode, start_ms, text, color, font_size FROM danmaku
         WHERE video_id=? ORDER BY start_ms ASC, id ASC",
    )
    .bind(&video_id)
    .fetch_all(&state.db.pool)
    .await?
    .into_iter()
    .map(DanmakuRow::into_entry)
    .collect())
}

/// 评论区整体：评论平铺列表 + 表情映射（`[doge]` → 图片），前端渲染时替换。
#[derive(serde::Serialize)]
pub struct CommentSection {
    pub comments: Vec<CommentEntry>,
    pub emotes: Vec<crate::pipeline::bilibili_extra::VideoEmote>,
}

/// 读取某视频的评论区（根评论 + 楼中楼的平铺列表，消费方按 parent_rpid 分组）。
/// 库里没有且是在线 B 站视频时先全量抓一次写库（可能要几十秒，前端展示加载态）。
#[tauri::command]
pub async fn cmd_get_comments(
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<CommentSection> {
    let video = load_video(&state, &video_id).await?;
    let cookies = bilibili_cookies(&state).await?;
    crate::pipeline::bilibili_extra::ensure_comments(
        &state.db,
        &video.id,
        &video.source_type,
        video.source_uri.as_deref(),
        video.bilibili_cid.as_deref(),
        cookies.as_deref(),
    )
    .await?;
    let comments = sqlx::query_as::<_, CommentRow>(
        "SELECT rpid, author, text, like_count, ctime, parent_rpid, reply_count, direct_parent_rpid, avatar
         FROM video_comments WHERE video_id=?
         ORDER BY (parent_rpid IS NULL) DESC, sort_index ASC, id ASC",
    )
    .bind(&video_id)
    .fetch_all(&state.db.pool)
    .await?
    .into_iter()
    .map(CommentRow::into_entry)
    .collect();
    // 哨兵行（emote_text=''）是自愈标记，不外发。
    let emotes = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT emote_text, url, size FROM video_emotes
         WHERE video_id=? AND emote_text != '' ORDER BY emote_text",
    )
    .bind(&video_id)
    .fetch_all(&state.db.pool)
    .await?
    .into_iter()
    .map(|(text, url, size)| crate::pipeline::bilibili_extra::VideoEmote { text, url, size })
    .collect();
    Ok(CommentSection { comments, emotes })
}

#[derive(sqlx::FromRow)]
struct DanmakuRow {
    mode: String,
    start_ms: i64,
    text: String,
    color: Option<String>,
    font_size: Option<i64>,
}

impl DanmakuRow {
    fn into_entry(self) -> DanmakuEntry {
        DanmakuEntry {
            mode: self.mode,
            start_ms: self.start_ms,
            text: self.text,
            color: self.color,
            font_size: self.font_size,
        }
    }
}

#[derive(sqlx::FromRow)]
struct CommentRow {
    rpid: Option<String>,
    author: String,
    text: String,
    like_count: i64,
    ctime: i64,
    parent_rpid: Option<String>,
    reply_count: i64,
    direct_parent_rpid: Option<String>,
    avatar: Option<String>,
}

impl CommentRow {
    fn into_entry(self) -> CommentEntry {
        CommentEntry {
            rpid: self.rpid,
            author: self.author,
            text: self.text,
            like_count: self.like_count,
            ctime: self.ctime,
            parent_rpid: self.parent_rpid,
            reply_count: self.reply_count,
            direct_parent_rpid: self.direct_parent_rpid,
            avatar: self.avatar,
        }
    }
}
