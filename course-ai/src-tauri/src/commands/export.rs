use crate::commands::courses::AppState;
use crate::commands::transcripts::list_segments;
use crate::commands::videos::Video;
use crate::error::{AppError, AppResult};
use crate::export::{quiz_to_anki, to_srt, to_vtt};
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "android", target_os = "ios"))]
use tauri::Manager as _;
use tauri::State;

async fn load_video(state: &AppState, video_id: &str) -> AppResult<Video> {
    sqlx::query_as("SELECT * FROM videos WHERE id=? AND deleted_at IS NULL")
        .bind(video_id)
        .fetch_optional(&state.db.pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("video {video_id}")))
}

fn export_dir_from_root(root: &Path, video_id: &str) -> PathBuf {
    root.join("exports").join(video_id)
}

fn export_dir(video: &Video, app: &tauri::AppHandle) -> AppResult<PathBuf> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|error| AppError::Config(format!("app_data_dir: {error}")))?;
        let dir = export_dir_from_root(&root, &video.id);
        std::fs::create_dir_all(&dir)?;
        return Ok(dir);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        let dir = export_dir_from_root(Path::new(&video.data_dir), &video.id);
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }
}

/// 导出字幕到应用导出目录，返回落地文件路径。format = "srt" | "vtt"。
#[tauri::command]
pub async fn cmd_export_subtitles(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: String,
    format: String,
) -> AppResult<String> {
    let segments = list_segments(&state.db, &video_id).await?;
    if segments.is_empty() {
        return Err(AppError::NotFound("no transcript to export".into()));
    }
    let content = match format.as_str() {
        "srt" => to_srt(&segments),
        "vtt" => to_vtt(&segments),
        other => return Err(AppError::Other(format!("unknown subtitle format {other}"))),
    };
    let video = load_video(&state, &video_id).await?;
    let dir = export_dir(&video, &app)?;
    let path = dir.join(format!("subtitles.{format}"));
    std::fs::write(&path, content)?;
    Ok(path.to_string_lossy().to_string())
}

/// 导出笔记 Markdown，返回落地文件路径。
#[tauri::command]
pub async fn cmd_export_notes(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: String,
    content_markdown: Option<String>,
) -> AppResult<String> {
    let stored: Option<String> =
        sqlx::query_scalar("SELECT content_md FROM notes WHERE video_id=?")
            .bind(&video_id)
            .fetch_optional(&state.db.pool)
            .await?
            .flatten();
    let md = notes_markdown_for_export(content_markdown, stored)?;
    let video = load_video(&state, &video_id).await?;
    let dir = export_dir(&video, &app)?;
    let path = dir.join("notes.md");
    std::fs::write(&path, md)?;
    Ok(path.to_string_lossy().to_string())
}

fn notes_markdown_for_export(current: Option<String>, stored: Option<String>) -> AppResult<String> {
    let markdown = current.or(stored);
    markdown
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::NotFound("no notes to export".into()))
}

/// 导出测验为 Anki 可导入的 TSV（正面=题干+选项，背面=答案+解析），返回文件路径。
#[tauri::command]
pub async fn cmd_export_quiz(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<String> {
    let json: Option<String> =
        sqlx::query_scalar("SELECT questions_json FROM quizzes WHERE video_id=?")
            .bind(&video_id)
            .fetch_optional(&state.db.pool)
            .await?;
    let json = json.ok_or_else(|| AppError::NotFound("no quiz to export".into()))?;
    let tsv = quiz_to_anki(&json)?;
    let video = load_video(&state, &video_id).await?;
    let dir = export_dir(&video, &app)?;
    let path = dir.join("quiz-anki.txt");
    std::fs::write(&path, tsv)?;
    Ok(path.to_string_lossy().to_string())
}

/// 导出脑图 Markdown（Markmap 大纲），返回文件路径。
#[tauri::command]
pub async fn cmd_export_mindmap(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: String,
) -> AppResult<String> {
    let md: Option<String> = sqlx::query_scalar("SELECT markmap_md FROM mindmaps WHERE video_id=?")
        .bind(&video_id)
        .fetch_optional(&state.db.pool)
        .await?;
    let md = md.ok_or_else(|| AppError::NotFound("no mindmap to export".into()))?;
    let video = load_video(&state, &video_id).await?;
    let dir = export_dir(&video, &app)?;
    let path = dir.join("mindmap.md");
    std::fs::write(&path, md)?;
    Ok(path.to_string_lossy().to_string())
}

/// 导出讲义：每页课件配这一页的讲解要点，存成自包含 HTML（浏览器里打印即可存 PDF）。
///
/// `use_ai`：用大模型把每页讲稿提炼成要点（走笔记任务的模型）；没配模型时自动退回讲稿摘录。
/// `open`：桌面端导出后直接用系统浏览器打开（页面会自动弹出打印框）。
#[tauri::command]
pub async fn cmd_export_handout(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: String,
    use_ai: bool,
    english: bool,
    open: bool,
) -> AppResult<String> {
    use crate::pipeline::handout::{
        assign_speech, image_data_uri, render_html, summarize_pages, HandoutDoc, HandoutSlide,
    };
    let video = load_video(&state, &video_id).await?;
    let slides: Vec<(i64, i64, Option<i64>, String)> = sqlx::query_as(
        "SELECT page_no, start_ms, end_ms, image_path FROM slides WHERE video_id=? ORDER BY start_ms, page_no",
    )
    .bind(&video_id)
    .fetch_all(&state.db.pool)
    .await?;
    if slides.is_empty() {
        return Err(AppError::NotFound("no slides to export".into()));
    }
    let slides: Vec<HandoutSlide> = slides
        .into_iter()
        .map(|(page_no, start_ms, end_ms, image_path)| HandoutSlide { page_no, start_ms, end_ms, image_path })
        .collect();
    let segments = list_segments(&state.db, &video_id).await?;
    let video_end_ms = video
        .duration_ms
        .or_else(|| segments.last().map(|s| s.end_ms))
        .unwrap_or(0);
    let mut pages = assign_speech(&slides, &segments, video_end_ms);

    if use_ai {
        if let Some((provider, model)) =
            crate::commands::ai::provider_for_db(&state.db, crate::llm::profiles::AiTask::Notes).await?
        {
            summarize_pages(&provider, &model, &mut pages).await;
        }
    }

    let chapters: Vec<(i64, String)> = sqlx::query_as(
        "SELECT start_ms, title FROM chapters WHERE video_id=? ORDER BY start_ms, order_index",
    )
    .bind(&video_id)
    .fetch_all(&state.db.pool)
    .await?;
    let course: String = sqlx::query_scalar("SELECT name FROM courses WHERE id=?")
        .bind(&video.course_id)
        .fetch_optional(&state.db.pool)
        .await?
        .unwrap_or_default();
    let paths: Vec<String> = pages.iter().map(|p| p.image_path.clone()).collect();
    let images = tokio::task::spawn_blocking(move || {
        paths.iter().map(|p| image_data_uri(Path::new(p))).collect::<Vec<_>>()
    })
    .await
    .map_err(|error| AppError::Other(format!("read slide images: {error}")))?;
    let title = crate::export::display_title(&video.title);
    let html = render_html(&HandoutDoc {
        title: &title,
        course: &course,
        generated_at_ms: chrono::Utc::now().timestamp_millis(),
        chapters: &chapters,
        pages: &pages,
        images: &images,
        english,
    });
    let dir = export_dir(&video, &app)?;
    let path = dir.join("handout.html");
    std::fs::write(&path, html)?;

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if open {
        use tauri_plugin_opener::OpenerExt as _;
        app.opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|error| AppError::Other(format!("open handout: {error}")))?;
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let _ = open;

    Ok(path.to_string_lossy().to_string())
}

/// 分享图文件名只留安全字符：不能带路径分隔符，统一以 .png 结尾。
fn share_image_name(name: &str) -> String {
    let stem: String = name
        .trim()
        .trim_end_matches(".png")
        .chars()
        .map(|c| {
            let unsafe_char =
                matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control();
            if unsafe_char {
                '_'
            } else {
                c
            }
        })
        .collect();
    let stem = stem.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let stem: String = stem.chars().take(80).collect();
    format!("{}.png", if stem.is_empty() { "share" } else { &stem })
}

/// 保存前端画好的分享图（PNG base64）。有 video_id 时放进该视频的导出目录，
/// 否则（学习周报）放进应用数据目录下的 exports/share。`open` 时桌面端顺手用系统看图打开。
#[tauri::command]
pub async fn cmd_save_share_image(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    video_id: Option<String>,
    file_name: String,
    png_base64: String,
    open: bool,
) -> AppResult<String> {
    use base64::Engine as _;
    use tauri::Manager as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64.trim())
        .map_err(|error| AppError::Other(format!("invalid image data: {error}")))?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(AppError::Other("invalid image data: not a PNG".into()));
    }
    let dir = match video_id {
        Some(id) => {
            let video = load_video(&state, &id).await?;
            export_dir(&video, &app)?
        }
        None => {
            let root = app
                .path()
                .app_data_dir()
                .map_err(|error| AppError::Config(format!("app_data_dir: {error}")))?;
            let dir = root.join("exports").join("share");
            std::fs::create_dir_all(&dir)?;
            dir
        }
    };
    let path = dir.join(share_image_name(&file_name));
    std::fs::write(&path, bytes)?;

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if open {
        use tauri_plugin_opener::OpenerExt as _;
        app.opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|error| AppError::Other(format!("open image: {error}")))?;
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let _ = open;

    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_image_names_are_sanitized_png_files() {
        assert_eq!(share_image_name("笔记长图"), "笔记长图.png");
        assert_eq!(share_image_name("../../etc/passwd"), "_.._etc_passwd.png");
        assert_eq!(share_image_name("a:b?.png"), "a_b_.png");
        assert_eq!(share_image_name("  "), "share.png");
    }

    #[test]
    fn export_dir_is_nested_under_exports_and_video_id() {
        let root = Path::new("/tmp/course-ai");
        assert_eq!(
            export_dir_from_root(root, "video-1"),
            PathBuf::from("/tmp/course-ai/exports/video-1")
        );
    }

    #[test]
    fn current_notes_snapshot_wins_over_legacy_markdown() {
        assert_eq!(
            notes_markdown_for_export(Some("# Current".into()), Some("# Stale".into())).unwrap(),
            "# Current"
        );
    }

    #[test]
    fn blank_current_notes_do_not_fall_back_to_stale_markdown() {
        assert!(notes_markdown_for_export(Some("  \n".into()), Some("# Stale".into())).is_err());
    }

    #[test]
    fn legacy_callers_can_export_stored_markdown() {
        assert_eq!(
            notes_markdown_for_export(None, Some("# Stored".into())).unwrap(),
            "# Stored"
        );
    }
}
