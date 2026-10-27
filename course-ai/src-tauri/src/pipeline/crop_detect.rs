//! 用 ffmpeg `cropdetect` 探测视频自带的黑边（letterbox/pillarbox），
//! 换算成四边占比 insets 存库，供播放器做非破坏式显示裁剪。
//!
//! cropdetect 在一段时间窗内累积「非黑包围盒」，天然保守——只要某帧某处不是黑，
//! 该区域就不会被裁。我们在正片里采样几处（片头不算，见 [`sample_insets`]），每处取
//! 最后一个稳定的 `crop=W:H:X:Y`，按整帧分辨率换成比例，各处再按每边取最小值合并
//! （见 [`merge_samples`]）：任一处看到画面的地方都不裁，因此不会误切真实内容。
//! 比例与像素纵横比（SAR）无关，前端直接套到显示框上即可。

use crate::sidecar::{resolve, FFMPEG};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Semaphore;

/// 并发探测上限。探测要 ffmpeg 解码正片几十秒画面，是实打实的磁盘和 CPU 开销；
/// 导入改成后台任务后，一次连开多门课会同时排起好几个探测，必须限住并发，
/// 否则它们会互相抢磁盘、拖慢一切。2 足够：一个在跑、一个在等，其余排队。
const CROP_DETECT_MAX_CONCURRENT: usize = 2;

fn crop_semaphore() -> &'static Semaphore {
    static CROP_DETECT_SEMAPHORE: OnceLock<Semaphore> = OnceLock::new();
    CROP_DETECT_SEMAPHORE.get_or_init(|| Semaphore::new(CROP_DETECT_MAX_CONCURRENT))
}

/// 取消标志的轮询间隔。一趟探测要解好几十秒的画面，等它自己跑完再看标志就太迟了。
const CANCEL_POLL: Duration = Duration::from_millis(200);

/// 某个视频的黑边探测在取消登记表里的键。
///
/// 探测只对「用户正在看的这个视频」有意义。前端切走时按这个键置位，正在解码的
/// ffmpeg 就会被收掉——否则在一门课里连点几个视频，每个都留着几个 ffmpeg 在啃磁盘，
/// 全压在新视频的起播上。
pub fn cancel_key(video_id: &str) -> String {
    format!("crop-detect:{video_id}")
}

/// 不打算取消的调用（导入时的探测）用它，省得每处都造一个标志。
fn never_cancel() -> AtomicBool {
    AtomicBool::new(false)
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct CropInsets {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// 无黑边（也用作「已探测、无黑边」的写库标记值）。
pub const NO_CROP: CropInsets = CropInsets {
    top: 0.0,
    right: 0.0,
    bottom: 0.0,
    left: 0.0,
};

/// 跑一遍 ffmpeg cropdetect，返回 stderr 文本；**spawn 失败或被取消返回 None**
/// （区分「跑过」与「没跑成」）。
async fn run_cropdetect(
    path: &Path,
    at_s: i64,
    window_s: i64,
    cancel: &AtomicBool,
) -> Option<String> {
    if cancel.load(Ordering::SeqCst) {
        return None;
    }
    let ffmpeg = resolve(&FFMPEG, None).ok()?;
    let child = crate::sidecar::command(&ffmpeg)
        .kill_on_drop(true)
        // cropdetect 在窗口内累积包围盒；null 输出不落地、不编码。
        .args([
            "-hide_banner",
            "-nostats",
            "-ss",
            &at_s.to_string(),
            "-t",
            &window_s.to_string(),
            "-i",
        ])
        .arg(path)
        .args([
            "-vf",
            "cropdetect=limit=24:round=2:reset=0",
            "-an",
            "-f",
            "null",
            "-",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    // 一边等 ffmpeg 一边看取消标志：人已经翻到下一个视频了，这一趟解码纯属白占
    // CPU 和磁盘，还会和新视频的起播抢。future 被丢掉时 kill_on_drop 负责收子进程。
    let wait = child.wait_with_output();
    tokio::pin!(wait);
    loop {
        tokio::select! {
            finished = &mut wait => {
                let output = finished.ok()?;
                return Some(String::from_utf8_lossy(&output.stderr).into_owned());
            }
            _ = tokio::time::sleep(CANCEL_POLL) => {
                if cancel.load(Ordering::SeqCst) {
                    return None;
                }
            }
        }
    }
}

/// 跑 cropdetect 并解析出四边黑边占比；无黑边/失败返回 None。
pub async fn detect_crop(path: &Path) -> Option<CropInsets> {
    let samples = sample_insets(path, &never_cancel()).await?;
    merge_samples(&samples)
}

/// 采样正片多处，返回各处测到的包围盒。
///
/// 开头那一段（3–33 秒）不能当正片看：课程录像的片头常和正片取景不同（标题卡、片花、
/// 全屏欢迎页、铺满边缘的动画），cropdetect 又是在整个窗口里累积包围盒（reset=0），
/// 片头里任何一帧铺到边缘，这一处就会测成「这条边没有黑边」，合并时把正片一直存在的
/// 黑边否掉；照着标题卡的黑边去裁，又会把正片削掉一条。
///
/// 所以开头那一趟只用来读片长：够长（> [`BODY_SAMPLE_MIN_S`]）的视频改在正片 20% / 50% /
/// 80% 三处采样，开头那段不参与合并；太短的视频没有正片可挑，才拿开头那段当样本。
/// 正片几处都没测出来（解码失败等）时也退回开头那段。
/// 被取消时返回 None（而不是「已采到的那几处」）：只拿一部分去写库会留下错误结论。
async fn sample_insets(path: &Path, cancel: &AtomicBool) -> Option<Vec<CropInsets>> {
    let first = run_cropdetect(path, 3, 30, cancel).await?;
    let mut samples = Vec::new();
    for at_s in body_offsets(parse_duration_ms(&first)) {
        let Some(stderr) = run_cropdetect(path, at_s, 20, cancel).await else {
            continue;
        };
        if let Some(insets) = measure_sample(&stderr) {
            samples.push(insets);
        }
    }
    if cancel.load(Ordering::SeqCst) {
        return None;
    }
    if samples.is_empty() {
        if let Some(insets) = measure_sample(&first) {
            samples.push(insets);
        }
    }
    Some(samples)
}

/// 视频至少这么长（秒），才在正片里另外采样、不用开头那段。
const BODY_SAMPLE_MIN_S: i64 = 120;

/// 正片里该采样哪几处（秒）。太短的视频没有正片可挑，返回空、只看开头那段。
pub fn body_offsets(duration_ms: Option<i64>) -> Vec<i64> {
    let Some(duration_s) = duration_ms.map(|ms| ms / 1000) else {
        return Vec::new();
    };
    if duration_s <= BODY_SAMPLE_MIN_S {
        return Vec::new();
    }
    [20, 50, 80]
        .into_iter()
        .map(|percent| duration_s * percent / 100)
        .collect()
}

/// 从 ffmpeg 头部信息里读片长（`Duration: 00:12:34.56`）。
/// cropdetect 那一趟本来就打了这行，不必再单独跑一次 ffprobe。
pub fn parse_duration_ms(stderr: &str) -> Option<i64> {
    let rest = stderr.split("Duration:").nth(1)?;
    let token = rest.trim_start().split(',').next()?.trim();
    let mut parts = token.split(':');
    let hours: i64 = parts.next()?.trim().parse().ok()?;
    let minutes: i64 = parts.next()?.trim().parse().ok()?;
    let seconds: f64 = parts.next()?.trim().parse().ok()?;
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    Some(((hours * 3600 + minutes * 60) as f64 + seconds).round() as i64 * 1000)
}

/// 合并多处采样：每边取**最小值**。
///
/// 只要有一处看到这条边有画面，就不裁——宁可留一条黑边，也不切掉真实内容（课件页、
/// 画中画、某一段满屏的演示）。片头带偏采样的问题不靠放宽合并规则解决，而是在
/// [`sample_insets`] 里根本不让片头参与。
pub fn merge_samples(samples: &[CropInsets]) -> Option<CropInsets> {
    if samples.is_empty() {
        return None;
    }
    let min = |side: fn(&CropInsets) -> f64| samples.iter().map(side).fold(f64::INFINITY, f64::min);
    let merged = CropInsets {
        top: min(|s| s.top),
        right: min(|s| s.right),
        bottom: min(|s| s.bottom),
        left: min(|s| s.left),
    };
    meaningful(merged)
}

/// 探测并写库，返回 insets（无黑边为 0）。
///
/// 至少有一处**测出了结果**（无论是否检出黑边）才写库——无黑边写 0，把该视频标记为
/// 「已探测」，避免每次打开都重跑。ffmpeg 没跑成（spawn 失败）、中途被取消，或者跑了
/// 却一处都没解出画面（文件在没接上的外置盘上、解码失败），都不写库：保持 NULL，下次
/// 打开这个视频时再测。否则会把「没测成」写成「测过、没黑边」，以后再也不补测。
pub async fn ensure_crop(
    db: &crate::db::Db,
    video_id: &str,
    path: PathBuf,
    cancel: &AtomicBool,
) -> CropInsets {
    // 并发上限：导入后台任务、流水线、课件提取、播放器兜底会同时要探测，
    // 不该让 ffmpeg 成批抢磁盘。拿不到许可就排队等，取消照旧在解码循环里生效。
    let _permit = crop_semaphore().acquire().await;
    let Some(samples) = sample_insets(&path, cancel).await else {
        return NO_CROP;
    };
    if samples.is_empty() {
        return NO_CROP;
    }
    let insets = merge_samples(&samples).unwrap_or(NO_CROP);
    let _ = sqlx::query(
        "UPDATE videos SET crop_top=?,crop_right=?,crop_bottom=?,crop_left=? WHERE id=?",
    )
    .bind(insets.top)
    .bind(insets.right)
    .bind(insets.bottom)
    .bind(insets.left)
    .bind(video_id)
    .execute(&db.pool)
    .await;
    insets
}

/// 从 ffmpeg stderr 里找整帧分辨率（"Video: ... WxH"）。
fn parse_dims(stderr: &str) -> Option<(i64, i64)> {
    for line in stderr.lines() {
        let Some(idx) = line.find("Video:") else {
            continue;
        };
        for tok in line[idx..].split(|c: char| c == ',' || c.is_whitespace()) {
            if let Some((a, b)) = tok.split_once('x') {
                if let (Ok(w), Ok(h)) = (a.parse::<i64>(), b.parse::<i64>()) {
                    if w > 0 && h > 0 {
                        return Some((w, h));
                    }
                }
            }
        }
    }
    None
}

/// 取最后一个 `crop=W:H:X:Y`（cropdetect 越往后越稳定）。
fn parse_last_crop(stderr: &str) -> Option<(i64, i64, i64, i64)> {
    let mut last = None;
    let mut rest = stderr;
    while let Some(i) = rest.find("crop=") {
        let after = &rest[i + 5..];
        let tok: String = after
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == ':')
            .collect();
        let parts: Vec<i64> = tok.split(':').filter_map(|p| p.parse().ok()).collect();
        if parts.len() == 4 {
            last = Some((parts[0], parts[1], parts[2], parts[3]));
        }
        rest = after;
    }
    last
}

/// 单段采样的测量结果。
///
/// `None` 表示这段**没解出包围盒**（`-ss` 超出片长、解码失败），不该参与合并；
/// `Some(全 0)` 表示这段解出来了、就是没有黑边——这是反对裁剪的最强证据，
/// 必须参与合并，不能当作「没测到」丢掉。
fn measure_sample(stderr: &str) -> Option<CropInsets> {
    let (w, h) = parse_dims(stderr)?;
    let (cw, ch, cx, cy) = parse_last_crop(stderr)?;
    if cw <= 0 || ch <= 0 || cw > w || ch > h {
        return None;
    }
    let left = (cx.max(0) as f64) / (w as f64);
    let top = (cy.max(0) as f64) / (h as f64);
    let right = ((w - cx - cw).max(0) as f64) / (w as f64);
    let bottom = ((h - cy - ch).max(0) as f64) / (h as f64);

    // 单边超 45% 视为异常（整帧偏暗等）→ 该边不裁。
    let clamp = |v: f64| if v > 0.45 { 0.0 } else { v };
    Some(CropInsets {
        top: clamp(top),
        right: clamp(right),
        bottom: clamp(bottom),
        left: clamp(left),
    })
}

/// 黑边不足 1% 视为无（避免编码边缘的 1~2px 抖动）。
fn meaningful(insets: CropInsets) -> Option<CropInsets> {
    let max = insets
        .top
        .max(insets.right)
        .max(insets.bottom)
        .max(insets.left);
    if max < 0.01 {
        None
    } else {
        Some(insets)
    }
}

/// 解析 cropdetect 输出 → 四边占比。无有意义黑边返回 None。
pub fn parse_cropdetect(stderr: &str) -> Option<CropInsets> {
    meaningful(measure_sample(stderr)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_DIMS: &str =
        "  Stream #0:0(und): Video: h264 (High), yuv420p, 1920x1080, 2500 kb/s, 25 fps\n";

    #[tokio::test]
    async fn a_cancelled_detection_starts_no_ffmpeg_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course = crate::commands::courses::create_course(
            &db,
            "c".into(),
            dir.path().to_string_lossy().into(),
        )
        .await
        .unwrap();
        let video_path = dir.path().join("01.mp4");
        std::fs::write(&video_path, b"not really a video").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, video_path, None)
            .await
            .unwrap();

        // 已置位的取消标志：一个 ffmpeg 都不该起（这个文件本来也解不动，
        // 真跑了会花时间、还会把「已探测」的 0 写进库）。
        let cancelled = AtomicBool::new(true);
        let insets = ensure_crop(&db, &video.id, PathBuf::from(&video.file_path), &cancelled).await;
        assert_eq!(insets, NO_CROP);

        // 关键：不写库。写了就等于把这个视频标成「测过、没黑边」，
        // 下次打开再也不会补测——被打断的一趟不该留下结论。
        let top: Option<f64> = sqlx::query_scalar("SELECT crop_top FROM videos WHERE id=?")
            .bind(&video.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(top, None);
    }

    #[test]
    fn cancel_key_is_scoped_to_one_video() {
        assert_eq!(cancel_key("v1"), "crop-detect:v1");
        assert_ne!(cancel_key("v1"), cancel_key("v2"));
    }

    #[tokio::test]
    async fn a_detection_that_measured_nothing_writes_nothing() {
        // 文件在没接上的外置盘上 / 解码失败：ffmpeg 跑了，但一处画面都没解出来。
        // 不能把「没测成」写成「测过、没黑边」（0），那样以后再也不会补测。
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course = crate::commands::courses::create_course(
            &db,
            "c".into(),
            dir.path().to_string_lossy().into(),
        )
        .await
        .unwrap();
        let video_path = dir.path().join("01.mp4");
        std::fs::write(&video_path, b"not really a video").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, video_path, None)
            .await
            .unwrap();
        let gone = PathBuf::from(&video.file_path).with_file_name("unplugged.mp4");
        ensure_crop(&db, &video.id, gone, &never_cancel()).await;
        let top: Option<f64> = sqlx::query_scalar("SELECT crop_top FROM videos WHERE id=?")
            .bind(&video.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(top, None);
    }

    #[test]
    fn merging_samples_never_crops_more_than_the_least_black_one() {
        // 片头是 4:3 加左右黑边的标题卡，正片其实是满屏（或黑边窄得多）。
        // 只看片头就会照着 12.5% 去裁，正片左右各被削掉一条真实画面。
        let intro = CropInsets {
            top: 0.0,
            right: 0.125,
            bottom: 0.0,
            left: 0.125,
        };
        let body = CropInsets {
            top: 0.0,
            right: 0.04,
            bottom: 0.0,
            left: 0.0,
        };
        let merged = merge_samples(&[intro, body]).unwrap();
        assert_eq!(merged.left, 0.0);
        assert_eq!(merged.right, 0.04);

        // 各处一致的真信箱黑边照旧保留。
        let letterbox = CropInsets {
            top: 0.13,
            right: 0.0,
            bottom: 0.13,
            left: 0.0,
        };
        assert_eq!(merge_samples(&[letterbox, letterbox]).unwrap(), letterbox);

        // 有一处明确「没有黑边」就不该裁——那是反对裁剪的最强证据。
        assert_eq!(merge_samples(&[letterbox, NO_CROP]), None);
        assert_eq!(merge_samples(&[]), None);
    }

    #[test]
    fn one_full_frame_sample_vetoes_cropping_even_against_two_with_bars() {
        // 两处是带左右黑边的课件页，一处是满屏的演示：满屏那段的画面不能被切掉，
        // 所以三处里只要一处是满屏，这条边就不裁（取最小值，不是少数服从多数）。
        let pillarbox = CropInsets {
            top: 0.0,
            right: 0.125,
            bottom: 0.0,
            left: 0.125,
        };
        assert_eq!(merge_samples(&[pillarbox, pillarbox, NO_CROP]), None);
    }

    #[test]
    fn a_sample_with_no_bars_still_counts_as_a_measurement() {
        // 「解出包围盒 = 整帧」必须参与合并（Some(全 0)），不能和「这段没帧」混为一谈。
        let full_frame = format!("{SAMPLE_DIMS}[Parsed_cropdetect_0 @ 0x1] crop=1920:1080:0:0\n");
        assert_eq!(measure_sample(&full_frame), Some(NO_CROP));
        // 没有 crop= 行（-ss 超出片长）→ 这段没测到，不参与合并。
        assert_eq!(measure_sample(SAMPLE_DIMS), None);
    }

    #[test]
    fn reads_duration_from_the_ffmpeg_header() {
        let log = "  Duration: 00:47:12.34, start: 0.000000, bitrate: 1500 kb/s\n";
        assert_eq!(parse_duration_ms(log), Some(2_832_000));
        assert_eq!(parse_duration_ms(SAMPLE_DIMS), None);
        // 直播流等拿不到片长时不瞎猜，只看开头那段。
        assert_eq!(parse_duration_ms("  Duration: N/A, bitrate: N/A\n"), None);
    }

    #[test]
    fn long_enough_videos_are_sampled_in_the_body_not_the_intro() {
        // 太短的视频没有正片可挑，只看开头那段。
        assert!(body_offsets(Some(90_000)).is_empty());
        assert!(body_offsets(Some(120_000)).is_empty());
        // 2~5 分钟的短课也在正片里采三处（原来只有一处，还和片头那段一起取最小值）。
        assert_eq!(body_offsets(Some(240_000)), vec![48, 120, 192]);
        // 三处都远离开头的片头。
        assert_eq!(body_offsets(Some(3_600_000)), vec![720, 1_800, 2_880]);
        assert!(body_offsets(None).is_empty());
    }

    #[test]
    fn parses_letterbox_top_bottom() {
        let log = format!(
            "{SAMPLE_DIMS}\
             [Parsed_cropdetect_0 @ 0x1] x1:0 x2:1919 y1:140 y2:939 crop=1920:800:0:140\n\
             [Parsed_cropdetect_0 @ 0x1] x1:0 x2:1919 y1:140 y2:939 crop=1920:800:0:140\n"
        );
        let insets = parse_cropdetect(&log).unwrap();
        assert!((insets.top - 140.0 / 1080.0).abs() < 1e-6);
        assert!((insets.bottom - 140.0 / 1080.0).abs() < 1e-6);
        assert_eq!(insets.left, 0.0);
        assert_eq!(insets.right, 0.0);
    }

    #[test]
    fn parses_pillarbox_left_right() {
        let log = format!("{SAMPLE_DIMS}[Parsed_cropdetect_0 @ 0x1] crop=1440:1080:240:0\n");
        let insets = parse_cropdetect(&log).unwrap();
        assert!((insets.left - 240.0 / 1920.0).abs() < 1e-6);
        assert!((insets.right - 240.0 / 1920.0).abs() < 1e-6);
        assert_eq!(insets.top, 0.0);
        assert_eq!(insets.bottom, 0.0);
    }

    #[test]
    fn full_frame_crop_is_no_bars() {
        let log = format!("{SAMPLE_DIMS}[Parsed_cropdetect_0 @ 0x1] crop=1920:1080:0:0\n");
        assert_eq!(parse_cropdetect(&log), None);
    }

    #[test]
    fn no_crop_line_is_none() {
        assert_eq!(parse_cropdetect(SAMPLE_DIMS), None);
    }

    #[test]
    fn takes_the_last_crop_value() {
        let log = format!(
            "{SAMPLE_DIMS}\
             [cropdetect] crop=1920:1040:0:20\n\
             [cropdetect] crop=1920:800:0:140\n"
        );
        let insets = parse_cropdetect(&log).unwrap();
        assert!((insets.top - 140.0 / 1080.0).abs() < 1e-6);
    }
}
