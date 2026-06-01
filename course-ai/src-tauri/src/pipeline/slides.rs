use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sidecar::{resolve, FFMPEG};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct SlideFrame {
    pub page_no: i64,
    pub image_path: String,
    pub start_ms: i64,
}

/// 解析 ffmpeg `metadata=print` 输出里的 `pts_time:SS.sss`，转成毫秒（按出现顺序）。
pub fn parse_pts_times(meta: &str) -> Vec<i64> {
    let mut out = Vec::new();
    for line in meta.lines() {
        if let Some(idx) = line.find("pts_time:") {
            let rest = &line[idx + "pts_time:".len()..];
            let token: String = rest
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            if let Ok(secs) = token.parse::<f64>() {
                out.push((secs * 1000.0).round() as i64);
            }
        }
    }
    out
}

/// 用场景切换检测抽"换页帧"。threshold 越大越不敏感（默认 0.3）。
pub async fn extract_slides(
    video: &Path,
    out_dir: &Path,
    threshold: f64,
) -> AppResult<Vec<SlideFrame>> {
    let slides_dir = out_dir.join("slides");
    std::fs::create_dir_all(&slides_dir)?;
    let meta_path = out_dir.join("slides_meta.txt");
    // metadata=print:file 需要绝对路径里没有特殊字符；用 to_string_lossy。
    let vf = format!(
        "select='gt(scene,{threshold})',metadata=print:file={}",
        meta_path.to_string_lossy()
    );
    let pattern = slides_dir.join("%04d.jpg");
    let ffmpeg = resolve(&FFMPEG, None)?;
    let status = Command::new(&ffmpeg)
        .args(["-y", "-i"])
        .arg(video)
        .args(["-vf", &vf, "-vsync", "vfr"])
        .arg(&pattern)
        .status()
        .await
        .map_err(|error| AppError::Pipeline(format!("ffmpeg spawn: {error}")))?;
    if !status.success() {
        return Err(AppError::Pipeline(format!("ffmpeg slides failed: {status}")));
    }

    let meta = std::fs::read_to_string(&meta_path).unwrap_or_default();
    let times = parse_pts_times(&meta);

    // 收集生成的 jpg，按文件名排序，与 times 按序配对。
    let mut images: Vec<PathBuf> = std::fs::read_dir(&slides_dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "jpg").unwrap_or(false))
        .collect();
    images.sort();

    let mut frames = Vec::new();
    for (idx, image) in images.iter().enumerate() {
        let start_ms = times.get(idx).copied().unwrap_or(0);
        frames.push(SlideFrame {
            page_no: idx as i64,
            image_path: image.to_string_lossy().to_string(),
            start_ms,
        });
    }
    Ok(frames)
}

pub async fn store_slides(db: &Db, video_id: &str, frames: &[SlideFrame]) -> AppResult<usize> {
    sqlx::query("DELETE FROM slides WHERE video_id=?")
        .bind(video_id)
        .execute(&db.pool)
        .await?;
    for (idx, f) in frames.iter().enumerate() {
        let end_ms = frames.get(idx + 1).map(|n| n.start_ms);
        sqlx::query(
            "INSERT INTO slides(video_id,image_path,start_ms,end_ms,page_no)
             VALUES (?,?,?,?,?)",
        )
        .bind(video_id)
        .bind(&f.image_path)
        .bind(f.start_ms)
        .bind(end_ms)
        .bind(f.page_no)
        .execute(&db.pool)
        .await?;
    }
    Ok(frames.len())
}

/// 在 at_ms 处截一帧到 screenshots/，返回落地路径。
pub async fn capture_frame(video: &Path, out_dir: &Path, at_ms: i64) -> AppResult<PathBuf> {
    let shots_dir = out_dir.join("screenshots");
    std::fs::create_dir_all(&shots_dir)?;
    let out = shots_dir.join(format!("{at_ms}.jpg"));
    let seconds = at_ms as f64 / 1000.0;
    let ffmpeg = resolve(&FFMPEG, None)?;
    let status = Command::new(&ffmpeg)
        .args(["-y", "-ss", &format!("{seconds}"), "-i"])
        .arg(video)
        .args(["-frames:v", "1", "-q:v", "2"])
        .arg(&out)
        .status()
        .await
        .map_err(|error| AppError::Pipeline(format!("ffmpeg spawn: {error}")))?;
    if !status.success() {
        return Err(AppError::Pipeline(format!("ffmpeg capture failed: {status}")));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;
    use tempfile::tempdir;

    #[test]
    fn parses_pts_times_to_ms() {
        let meta = "\
frame:0    pts:0       pts_time:0\n\
lavfi.scene_score=0.5\n\
frame:1    pts:90000   pts_time:1.5\n\
frame:2    pts:180000  pts_time:3.25\n";
        assert_eq!(parse_pts_times(meta), vec![0, 1500, 3250]);
    }

    #[test]
    fn parses_empty_meta_to_nothing() {
        assert!(parse_pts_times("").is_empty());
    }

    #[tokio::test]
    async fn extracts_slides_from_color_changes() {
        if which::which("ffmpeg").is_err() {
            eprintln!("skipping: no ffmpeg");
            return;
        }
        let dir = tempdir().unwrap();
        let video = dir.path().join("in.mp4");
        // 三段不同纯色拼接，制造两次明显场景切换。
        let gen = StdCommand::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=160x90:d=1",
                "-f",
                "lavfi",
                "-i",
                "color=c=green:s=160x90:d=1",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=160x90:d=1",
                "-filter_complex",
                "[0:v][1:v][2:v]concat=n=3:v=1:a=0",
            ])
            .arg(&video)
            .output()
            .expect("ffmpeg gen");
        assert!(gen.status.success(), "gen failed: {gen:?}");

        // 用较低阈值确保至少捕获到画面切换；精确页数随 ffmpeg 版本而异，
        // 故只断言链路产出 ≥1 页（时间戳解析由 parse_pts_times 单测精确覆盖）。
        let frames = extract_slides(&video, dir.path(), 0.1).await.unwrap();
        assert!(
            !frames.is_empty(),
            "expected at least one slide frame from scene cuts"
        );
        assert!(Path::new(&frames[0].image_path).is_file());

        let dbdir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dbdir.path().join("t.db"))
            .await
            .unwrap();
        let course =
            crate::commands::courses::create_course(&db, "c".into(), dir.path().to_string_lossy().into())
                .await
                .unwrap();
        let vrow = crate::commands::videos::add_local_video(&db, &course.id, video.clone(), None)
            .await
            .unwrap();
        let n = store_slides(&db, &vrow.id, &frames).await.unwrap();
        assert_eq!(n, frames.len());
    }

    #[tokio::test]
    async fn captures_single_frame() {
        if which::which("ffmpeg").is_err() {
            eprintln!("skipping: no ffmpeg");
            return;
        }
        let dir = tempdir().unwrap();
        let video = dir.path().join("in.mp4");
        let gen = StdCommand::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=160x90:d=2",
            ])
            .arg(&video)
            .output()
            .expect("gen");
        assert!(gen.status.success());
        let shot = capture_frame(&video, dir.path(), 1000).await.unwrap();
        assert!(shot.is_file());
    }
}
