//! 本地 Whisper 的幻觉清理。
//!
//! Whisper 在长讲座上有几种固定的失败形态，都出在「没人说话」或「被自己带偏」的时候：
//!
//! - **循环**：同一句话连着吐好几段。它把自己上一段的输出当提示往下写，错一次就一路错下去。
//!   根子上的解法是不让它看上文（whisper-cli 的 `-mc 0`，见 `asr::run_whisper`），这里再兜底
//!   把残留的连续重复段收成一段。
//! - **段内复读**：一段里是同一个词重复十几遍（「谢谢谢谢谢谢……」）。
//! - **静音里编字幕**：板书、翻页、等学生做题的长静音里，它会「听」出训练语料里的片尾字幕
//!   （「请不吝点赞 订阅 转发」「字幕由 Amara.org 社区提供」）。
//!
//! 规则都是纯函数，按「宁可漏删、不可错删」定阈值：老师自己重复两遍的话不动，
//! 只有在静音里、或者是课堂上根本不会出现的片尾套话才删。

use super::asr::{is_special_token, WhisperJson, WhisperSegment};
use super::silence::Silence;

/// 连续多少段一模一样才算循环。老师把一句话重复两遍很常见，三遍以上的逐字重复基本是机器。
const LOOP_RUN: usize = 3;
/// 段内复读：同一个单元至少重复这么多遍、且总长到这么长才收。「对对对对」不动。
const REPEAT_UNITS: usize = 4;
const REPEAT_MIN_CHARS: usize = 8;
const REPEAT_MAX_UNIT: usize = 20;
/// 多长的静音里冒出来的字才当成编的。短停顿里的字可能只是时间戳偏了一点。
pub const LONG_SILENCE_MS: i64 = 3_000;
/// 段落时间戳允许越出静音边界多少（whisper 的时间戳本来就不精确）。
const SILENCE_MARGIN_MS: i64 = 300;
/// 静音占了全片一半以上，多半是录音音量太小、阈值不适用，这时不按静音删任何东西。
const MAX_SILENCE_SHARE: f64 = 0.5;

/// 课堂录音里不会真出现、却是 Whisper 最常编出来的片尾套话。命中就删，不管在不在静音里。
/// 「谢谢观看」这类真可能是老师说的，不放进来——它只在静音里才删。
const NEVER_SPOKEN: &[&str] = &[
    "明镜与点点",
    "请不吝点赞",
    "点赞订阅转发打赏",
    "Amara.org",
    "优优独播剧场",
    "YoYoTelevisionSeries",
];

#[derive(Debug, Default, PartialEq, Eq)]
pub struct CleanupReport {
    /// 连续重复里删掉的段数。
    pub loop_segments: usize,
    /// 收成一遍的段内复读。
    pub collapsed_repeats: usize,
    /// 静音里编出来的段。
    pub silent_segments: usize,
    /// 片尾套话。
    pub boilerplate_segments: usize,
}

impl CleanupReport {
    pub fn changed(&self) -> bool {
        self.loop_segments + self.collapsed_repeats + self.silent_segments + self.boilerplate_segments > 0
    }
}

/// 比较用的正文：去掉空白和标点，只留字。
fn normalized(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_whitespace() && !c.is_ascii_punctuation() && !is_cjk_punctuation(*c))
        .collect()
}

fn is_cjk_punctuation(c: char) -> bool {
    matches!(c, '，' | '。' | '、' | '；' | '：' | '？' | '！' | '…' | '—' | '·' | '“' | '”' | '‘' | '’' | '（' | '）' | '《' | '》' | '「' | '」' | '『' | '』')
}

/// 整段是同一个单元重复 n 遍时返回那个单元。
fn repeated_unit(text: &str) -> Option<String> {
    let chars: Vec<char> = normalized(text).chars().collect();
    let len = chars.len();
    if len < REPEAT_MIN_CHARS {
        return None;
    }
    (1..=REPEAT_MAX_UNIT.min(len / REPEAT_UNITS))
        .filter(|unit| len % unit == 0)
        .find(|&unit| chars.chunks(unit).all(|chunk| chunk == &chars[..unit]))
        .map(|unit| chars[..unit].iter().collect())
}

/// 段内复读收成一遍。token 只留拼得出这一遍的那几个，后面按 token 切句时才对得上。
fn collapse_repeat(segment: &mut WhisperSegment) -> bool {
    let Some(unit) = repeated_unit(&segment.text) else {
        return false;
    };
    let unit_len = unit.chars().count();
    let mut covered = 0;
    let mut keep = 0;
    for token in &segment.tokens {
        if covered >= unit_len {
            break;
        }
        keep += 1;
        if !is_special_token(&token.text) {
            covered += normalized(&token.text).chars().count();
        }
    }
    segment.tokens.truncate(keep);
    segment.text = unit;
    true
}

fn is_boilerplate(text: &str) -> bool {
    let compact: String = text.chars().filter(|c| !c.is_whitespace() && !is_cjk_punctuation(*c)).collect();
    NEVER_SPOKEN.iter().any(|phrase| compact.contains(phrase))
}

/// 这一段整个落在某段长静音里。
fn inside_long_silence(segment: &WhisperSegment, silences: &[Silence]) -> bool {
    silences.iter().any(|&(start, end)| {
        end - start >= LONG_SILENCE_MS
            && segment.offsets.from >= start - SILENCE_MARGIN_MS
            && segment.offsets.to <= end + SILENCE_MARGIN_MS
    })
}

fn silence_share(silences: &[Silence], total_ms: i64) -> f64 {
    if total_ms <= 0 {
        return 0.0;
    }
    let silent: i64 = silences.iter().map(|(start, end)| (end - start).max(0)).sum();
    silent as f64 / total_ms as f64
}

/// 就地清理。`silences` 是音轨上的静音段（毫秒），拿不到时传空。
pub fn clean(json: &mut WhisperJson, silences: &[Silence]) -> CleanupReport {
    let mut report = CleanupReport::default();
    let total_ms = json
        .transcription
        .iter()
        .map(|segment| segment.offsets.to)
        .max()
        .unwrap_or(0)
        .max(silences.iter().map(|&(_, end)| end).max().unwrap_or(0));
    let use_silences = silence_share(silences, total_ms) <= MAX_SILENCE_SHARE;

    let segments = std::mem::take(&mut json.transcription);
    let mut kept: Vec<WhisperSegment> = Vec::with_capacity(segments.len());
    // 当前这串连续相同段的正文和已经出现的次数。
    let mut run_text = String::new();
    let mut run_len = 0usize;
    for mut segment in segments {
        if is_boilerplate(&segment.text) {
            report.boilerplate_segments += 1;
            continue;
        }
        if use_silences && inside_long_silence(&segment, silences) {
            report.silent_segments += 1;
            continue;
        }
        if collapse_repeat(&mut segment) {
            report.collapsed_repeats += 1;
        }
        let text = normalized(&segment.text);
        if text.is_empty() {
            kept.push(segment);
            continue;
        }
        if text == run_text {
            run_len += 1;
        } else {
            run_text = text;
            run_len = 1;
        }
        if run_len < LOOP_RUN {
            kept.push(segment);
            continue;
        }
        // 第三遍起：前两遍已经留着了，到这里能确定是循环——连前面那一遍重复也一起去掉，
        // 只留第一遍，并把它的结束时间延到循环末尾，后面的文稿时间轴不留空洞。
        if run_len == LOOP_RUN {
            kept.pop();
            report.loop_segments += 1;
        }
        report.loop_segments += 1;
        if let Some(first) = kept.last_mut() {
            first.offsets.to = first.offsets.to.max(segment.offsets.to);
        }
    }
    json.transcription = kept;
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::asr::{Offsets, TokenObj};

    fn seg(text: &str, from: i64, to: i64) -> WhisperSegment {
        WhisperSegment {
            text: text.into(),
            offsets: Offsets { from, to },
            tokens: Vec::new(),
        }
    }

    fn texts(json: &WhisperJson) -> Vec<&str> {
        json.transcription.iter().map(|s| s.text.as_str()).collect()
    }

    #[test]
    fn a_loop_of_identical_segments_keeps_only_the_first_and_spans_the_whole_run() {
        let mut json = WhisperJson {
            transcription: vec![
                seg("我们来看梯度下降。", 0, 2_000),
                seg("学习率决定步长。", 2_000, 4_000),
                seg("学习率决定步长。", 4_000, 6_000),
                seg("学习率决定步长", 6_000, 8_000),
                seg("学习率决定步长。", 8_000, 10_000),
                seg("下面看例题。", 10_000, 12_000),
            ],
        };
        let report = clean(&mut json, &[]);
        assert_eq!(texts(&json), ["我们来看梯度下降。", "学习率决定步长。", "下面看例题。"]);
        assert_eq!(json.transcription[1].offsets.to, 10_000);
        assert_eq!(report.loop_segments, 3);
    }

    #[test]
    fn a_sentence_said_twice_is_left_alone() {
        let mut json = WhisperJson {
            transcription: vec![
                seg("这个要考。", 0, 1_000),
                seg("这个要考。", 1_000, 2_000),
                seg("我们继续。", 2_000, 3_000),
            ],
        };
        let report = clean(&mut json, &[]);
        assert_eq!(json.transcription.len(), 3);
        assert!(!report.changed());
    }

    #[test]
    fn in_segment_repetition_collapses_to_one_unit_but_short_fillers_stay() {
        let mut json = WhisperJson {
            transcription: vec![
                WhisperSegment {
                    text: "谢谢谢谢谢谢谢谢谢谢".into(),
                    offsets: Offsets { from: 0, to: 3_000 },
                    tokens: vec![
                        TokenObj { text: "[_BEG_]".into(), offsets: Offsets { from: 0, to: 0 } },
                        TokenObj { text: "谢".into(), offsets: Offsets { from: 0, to: 300 } },
                        TokenObj { text: "谢".into(), offsets: Offsets { from: 300, to: 600 } },
                        TokenObj { text: "谢".into(), offsets: Offsets { from: 600, to: 900 } },
                    ],
                },
                seg("我们来看看我们来看看我们来看看我们来看看", 3_000, 6_000),
                seg("对对对对", 6_000, 7_000),
            ],
        };
        let report = clean(&mut json, &[]);
        assert_eq!(texts(&json), ["谢", "我们来看看", "对对对对"]);
        assert_eq!(json.transcription[0].tokens.len(), 2, "只留拼得出一遍的 token");
        assert_eq!(report.collapsed_repeats, 2);
    }

    #[test]
    fn text_inside_a_long_silence_is_dropped_but_speech_at_its_edges_is_kept() {
        let mut json = WhisperJson {
            transcription: vec![
                seg("这一步写在黑板上。", 0, 4_000),
                seg("谢谢观看", 12_000, 15_000),
                seg("好，写完了。", 19_800, 22_000),
                seg("我们接着往下推。", 22_000, 45_000),
            ],
        };
        let silences = [(4_200, 20_000), (30_000, 31_000)];
        let report = clean(&mut json, &silences);
        assert_eq!(texts(&json), ["这一步写在黑板上。", "好，写完了。", "我们接着往下推。"]);
        assert_eq!(report.silent_segments, 1);
    }

    #[test]
    fn short_pauses_never_drop_text() {
        let mut json = WhisperJson {
            transcription: vec![seg("嗯", 1_000, 1_500), seg("接着讲", 2_000, 20_000)],
        };
        let report = clean(&mut json, &[(800, 2_000)]);
        assert_eq!(json.transcription.len(), 2);
        assert!(!report.changed());
    }

    #[test]
    fn a_mostly_silent_recording_means_the_threshold_is_wrong_so_silences_are_ignored() {
        // 录音音量太小：静音段盖住了大半，不能拿它删字。
        let mut json = WhisperJson {
            transcription: vec![seg("老师声音很小", 1_000, 5_000), seg("但确实在讲", 6_000, 9_000)],
        };
        let report = clean(&mut json, &[(0, 10_000)]);
        assert_eq!(json.transcription.len(), 2);
        assert_eq!(report.silent_segments, 0);
    }

    #[test]
    fn known_outro_boilerplate_is_dropped_anywhere() {
        let mut json = WhisperJson {
            transcription: vec![
                seg("今天就讲到这里。", 0, 2_000),
                seg("请不吝点赞 订阅 转发 打赏支持明镜与点点栏目", 2_000, 5_000),
                seg("字幕由Amara.org社区提供", 5_000, 7_000),
            ],
        };
        let report = clean(&mut json, &[]);
        assert_eq!(texts(&json), ["今天就讲到这里。"]);
        assert_eq!(report.boilerplate_segments, 2);
    }
}
