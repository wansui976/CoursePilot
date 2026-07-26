//! 跳停顿：找出课程录像里的长时间无声段，播放时一跃而过。
//!
//! 课堂录像的水分几乎都在「无声」里——老师写板书、翻页、等学生记笔记、调设备。
//! 探测走 ffmpeg 的 `silencedetect`（只读音轨，不解码画面，很快），结果落库，
//! 之后每次播放直接读。
//!
//! 但「没声音」不等于「没内容」：老师一边沉默一边在黑板上写公式时，画面正在变化，
//! 跳过去就跳掉了推导过程。所以最终跳哪些段由 [`plan_skips`] 决定——它拿课件换页的
//! 时间点把静音段切开，只跳画面同样没动的那截。判定是纯函数，可单测。

use crate::error::{AppError, AppResult};
use std::path::Path;

/// 一段静音（毫秒，左闭右开）。
pub type Silence = (i64, i64);

/// 探测参数。默认值按课堂录像调：-35dB 比「绝对无声」宽松（教室底噪、空调声都在这以下），
/// 0.8 秒以下的停顿是正常的说话换气，不该算。
pub const DEFAULT_NOISE_DB: f64 = -35.0;
pub const DEFAULT_MIN_SILENCE_MS: i64 = 800;

/// 规划跳过区间时的余量。
#[derive(Debug, Clone, Copy)]
pub struct SkipOptions {
    /// 跳过的最短长度：太短的跳跃只会让人觉得卡顿，不如不跳。
    pub min_skip_ms: i64,
    /// 静音起点后保留多少，免得把上一句话的尾音削掉。
    pub head_keep_ms: i64,
    /// 静音终点前保留多少，免得下一句话开口就被截。
    pub tail_keep_ms: i64,
}

impl Default for SkipOptions {
    fn default() -> Self {
        Self {
            min_skip_ms: 1_500,
            head_keep_ms: 400,
            tail_keep_ms: 250,
        }
    }
}

/// 一段建议跳过的区间（毫秒，左闭右开）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct SkipRange {
    pub start_ms: i64,
    pub end_ms: i64,
}

fn parse_seconds_to_ms(raw: &str) -> Option<i64> {
    let value: f64 = raw.trim().parse().ok()?;
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    Some((value * 1000.0).round() as i64)
}

/// 解析 ffmpeg `silencedetect` 打在 stderr 上的行。
///
/// 形如 `[silencedetect @ ...] silence_start: 12.345` /
/// `... silence_end: 20.1 | silence_duration: 7.755`。视频结尾就是静音时，
/// ffmpeg 可能只给 start 不给 end，用 `duration_ms` 补上收尾。
pub fn parse_silencedetect(log: &str, duration_ms: Option<i64>) -> Vec<Silence> {
    let mut out = Vec::new();
    let mut open: Option<i64> = None;
    for line in log.lines() {
        if let Some(rest) = line.split("silence_start:").nth(1) {
            // 同一行不会同时有 start 与 end；start 后面直到行尾都是数字。
            if let Some(start) = parse_seconds_to_ms(rest) {
                open = Some(start);
            }
            continue;
        }
        if let Some(rest) = line.split("silence_end:").nth(1) {
            let end = rest.split('|').next().and_then(parse_seconds_to_ms);
            if let (Some(start), Some(end)) = (open.take(), end) {
                if end > start {
                    out.push((start, end));
                }
            }
        }
    }
    // 收尾静音：ffmpeg 到文件末尾时不一定补 silence_end。
    if let (Some(start), Some(duration)) = (open, duration_ms) {
        if duration > start {
            out.push((start, duration));
        }
    }
    out
}

/// 把静音段变成「真正该跳」的区间。
///
/// `page_starts` 是课件换页的时刻。换页说明画面在动——老师可能正沉默着写板书或
/// 放动画，这段跳过去就丢了内容。所以静音段先被换页时刻切开，只保留其中画面也
/// 没动的那一截（取最长的一截，通常就是翻完页之后真正的空等）。
pub fn plan_skips(
    silences: &[Silence],
    page_starts: &[i64],
    options: SkipOptions,
) -> Vec<SkipRange> {
    let mut out = Vec::new();
    for &(start, end) in silences {
        if end <= start {
            continue;
        }
        let mut bounds = vec![start];
        bounds.extend(
            page_starts
                .iter()
                .copied()
                .filter(|at| *at > start && *at < end),
        );
        bounds.push(end);
        bounds.sort_unstable();

        let best = bounds
            .windows(2)
            .map(|pair| {
                let from = pair[0] + options.head_keep_ms;
                let to = pair[1] - options.tail_keep_ms;
                (from, to)
            })
            .filter(|(from, to)| to - from >= options.min_skip_ms)
            .max_by_key(|(from, to)| to - from);
        if let Some((start_ms, end_ms)) = best {
            out.push(SkipRange { start_ms, end_ms });
        }
    }
    out.sort_by_key(|range| range.start_ms);
    out
}

/// 播放到 `position_ms` 时该不该跳，跳到哪。返回落在区间内的那段的终点。
/// 播放器每次 timeupdate 都会问一遍，所以这里只做一次线性查找、不产生副作用。
pub fn skip_target(ranges: &[SkipRange], position_ms: i64) -> Option<i64> {
    ranges
        .iter()
        .find(|range| position_ms >= range.start_ms && position_ms < range.end_ms)
        .map(|range| range.end_ms)
}

/// 构造 silencedetect 的 ffmpeg 参数：只读音轨（`-vn`），输出丢弃，只要 stderr 上的日志。
pub fn build_silencedetect_args(input: &str, noise_db: f64, min_silence_ms: i64) -> Vec<String> {
    let seconds = min_silence_ms as f64 / 1000.0;
    vec![
        "-hide_banner".into(),
        "-nostats".into(),
        "-i".into(),
        input.into(),
        "-vn".into(),
        "-af".into(),
        format!("silencedetect=noise={noise_db}dB:d={seconds}"),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]
}

/// 扫一遍音轨找静音段。只解码音频，1 小时的课堂录像通常几秒到十几秒。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn detect_silences(
    input: &Path,
    duration_ms: Option<i64>,
    noise_db: f64,
    min_silence_ms: i64,
) -> AppResult<Vec<Silence>> {
    use crate::sidecar::{resolve, FFMPEG};
    let ffmpeg = resolve(&FFMPEG, None)?;
    let args = build_silencedetect_args(&input.to_string_lossy(), noise_db, min_silence_ms);
    let output = tokio::process::Command::new(&ffmpeg)
        .args(&args)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| AppError::Pipeline(format!("ffmpeg spawn: {e}")))?;
    if !output.status.success() {
        return Err(AppError::Pipeline(format!(
            "silencedetect failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(parse_silencedetect(
        &String::from_utf8_lossy(&output.stderr),
        duration_ms,
    ))
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn detect_silences(
    _input: &Path,
    _duration_ms: Option<i64>,
    _noise_db: f64,
    _min_silence_ms: i64,
) -> AppResult<Vec<Silence>> {
    Err(AppError::Config("移动端暂不支持静音探测".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_silence_pairs_and_closes_a_dangling_tail() {
        let log = "\
[silencedetect @ 0x1] silence_start: 12.5
[silencedetect @ 0x1] silence_end: 20.25 | silence_duration: 7.75
size=N/A time=00:00:30.00 bitrate=N/A
[silencedetect @ 0x1] silence_start: 55
";
        let ranges = parse_silencedetect(log, Some(60_000));
        assert_eq!(ranges, vec![(12_500, 20_250), (55_000, 60_000)]);

        // 不知道总时长时，收不了尾的那段就丢掉，不能瞎猜一个终点去跳。
        assert_eq!(parse_silencedetect(log, None), vec![(12_500, 20_250)]);
    }

    #[test]
    fn plans_skips_with_headroom_and_drops_short_gaps() {
        let options = SkipOptions::default();
        // 10 秒静音，掐头去尾后还剩 9.35 秒，值得跳。
        let ranges = plan_skips(&[(10_000, 20_000)], &[], options);
        assert_eq!(
            ranges,
            vec![SkipRange {
                start_ms: 10_400,
                end_ms: 19_750
            }]
        );
        // 1.8 秒的停顿掐头去尾只剩 1.15 秒，跳过去只会显得卡，不如不跳。
        assert!(plan_skips(&[(10_000, 11_800)], &[], options).is_empty());
    }

    #[test]
    fn does_not_skip_over_a_slide_change_inside_the_silence() {
        let options = SkipOptions::default();
        // 老师沉默着写板书：静音中间画面变了，跳过去就丢了推导过程。
        // 只跳换页之后画面也不动的那截。
        let ranges = plan_skips(&[(10_000, 30_000)], &[14_000], options);
        assert_eq!(
            ranges,
            vec![SkipRange {
                start_ms: 14_400,
                end_ms: 29_750
            }]
        );

        // 静音被切碎到每截都不够长时，一段都不跳。
        assert!(plan_skips(&[(10_000, 14_000)], &[11_000, 12_500], options).is_empty());
    }

    #[test]
    fn skip_target_only_fires_inside_a_range() {
        let ranges = vec![SkipRange {
            start_ms: 1_000,
            end_ms: 5_000,
        }];
        assert_eq!(skip_target(&ranges, 999), None);
        assert_eq!(skip_target(&ranges, 1_000), Some(5_000));
        assert_eq!(skip_target(&ranges, 4_999), Some(5_000));
        // 终点是开区间：跳到位之后不该再被同一段抓住，否则会原地反复跳。
        assert_eq!(skip_target(&ranges, 5_000), None);
    }

    #[tokio::test]
    async fn detects_the_quiet_middle_of_a_real_recording() {
        if which::which("ffmpeg").is_err() {
            eprintln!("skipping: no ffmpeg");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("in.wav");
        // 说话 2 秒 → 沉默 4 秒 → 说话 2 秒，模拟老师写板书时的空档。
        let gen = std::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=2",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=44100:cl=mono:d=4",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=2",
                "-filter_complex",
                "[0:a][1:a][2:a]concat=n=3:v=0:a=1",
            ])
            .arg(&audio)
            .output()
            .unwrap();
        assert!(gen.status.success(), "ffmpeg: {:?}", gen.status);

        let ranges = detect_silences(
            &audio,
            Some(8_000),
            DEFAULT_NOISE_DB,
            DEFAULT_MIN_SILENCE_MS,
        )
        .await
        .unwrap();
        assert_eq!(ranges.len(), 1, "ranges: {ranges:?}");
        let (start, end) = ranges[0];
        // 边界由 ffmpeg 的能量窗口决定，只要落在中间那 4 秒附近就算对。
        assert!((1_800..2_400).contains(&start), "start: {start}");
        assert!((5_800..6_400).contains(&end), "end: {end}");
    }

    #[test]
    fn silencedetect_args_read_audio_only_and_discard_output() {
        let args = build_silencedetect_args("/tmp/a.mp4", -35.0, 800);
        assert!(args.contains(&"-vn".to_string()));
        assert!(args.contains(&"silencedetect=noise=-35dB:d=0.8".to_string()));
        assert_eq!(args.last().unwrap(), "-");
    }
}
