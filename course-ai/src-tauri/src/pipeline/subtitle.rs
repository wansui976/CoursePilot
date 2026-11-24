//! B站自带字幕（SRT）解析与入库消化。
//!
//! yt-dlp `--convert-subs srt` 落地的字幕统一为 SRT；这里解析为带毫秒时间轴的
//! 段落，复用 ASR 的写库逻辑写入 transcripts，使字幕成为「另一种来源的文稿」。

use crate::db::Db;
use crate::error::AppResult;
use crate::llm::Provider;
use crate::pipeline::asr::{store_segments_with_backup, StoredSegment};
use crate::pipeline::transcript_correction;

/// 一段字幕：时间轴（毫秒）+ 文本。
#[derive(Debug, Clone, PartialEq)]
pub struct SubSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// 把 `HH:MM:SS,mmm`（或 `.mmm`）解析为毫秒；不合法返回 None。
fn parse_srt_time(token: &str) -> Option<i64> {
    let token = token.trim().replace('.', ",");
    let (hms, millis) = token.split_once(',')?;
    let ms: i64 = millis.parse().ok()?;
    let mut parts = hms.split(':');
    let h: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let s: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(((h * 60 + m) * 60 + s) * 1000 + ms)
}

/// 时间轴行 `00:00:01,200 --> 00:00:03,400`（后面可能还跟着 VTT 的位置设置）。
fn parse_timing_line(line: &str) -> Option<(i64, i64)> {
    let (start, rest) = line.split_once("-->")?;
    let end = rest.split_whitespace().next()?;
    Some((parse_srt_time(start)?, parse_srt_time(end)?))
}

/// 一条字幕：时间轴 + 各行文字（还没拼接）。
struct Cue {
    start_ms: i64,
    end_ms: i64,
    lines: Vec<String>,
}

/// 逐行读出每条字幕。不按空行切块：YouTube 自动字幕转出来的 SRT 在时间轴和文字之间
/// 常夹一个空行（原本只有一个 `\r`），按空行切会把文字和时间轴拆散、整条丢掉。
fn parse_cues(input: &str) -> Vec<Cue> {
    let input = input.replace("\r\n", "\n").replace('\r', "\n");
    let mut cues: Vec<Cue> = Vec::new();
    // 上一行是不是空行；当前这条在空行之后有没有又出现文字。
    let mut after_blank = true;
    let mut index_candidate = false;
    for raw in input.lines() {
        let line = raw.trim();
        if line.is_empty() {
            after_blank = true;
            continue;
        }
        if let Some((start_ms, end_ms)) = parse_timing_line(line) {
            // 紧挨在时间轴上面、单独一行的数字是下一条的序号，不是上一条的文字。
            if index_candidate {
                if let Some(cue) = cues.last_mut() {
                    cue.lines.pop();
                }
            }
            cues.push(Cue {
                start_ms,
                end_ms,
                lines: Vec::new(),
            });
            after_blank = false;
            index_candidate = false;
            continue;
        }
        index_candidate = after_blank && line.bytes().all(|b| b.is_ascii_digit());
        if let Some(cue) = cues.last_mut() {
            // 空行之后的文字只在这一条还没有文字时才算它的（上面说的 YouTube 空行）；
            // 否则是两条之间的游离文字（或下一条的序号），先收下，序号遇到时间轴再丢。
            if !after_blank || cue.lines.is_empty() || index_candidate {
                cue.lines.push(line.to_string());
            }
        }
        after_blank = false;
    }
    cues
}

/// 方括号里的音效标注（YouTube 自动字幕的 [music] / [Music] / [音乐] / [laughter] / [applause]，
/// 手打字幕里的 [Applause] 之类）：不是说的话，读着碍眼，翻译、摘要也会把它当内容。
/// 只认这张表里的词：B 站 CC 字幕里的「[第三章附录]」、讲课里的 [a b]、[sic] 都是正文，
/// 按「括号里是不是纯字母」去猜会把它们一起删掉。
fn is_sound_tag(inner: &str) -> bool {
    const TAGS: [&str; 26] = [
        "music", "music playing", "applause", "laughter", "laughing", "laughs", "laugh",
        "cheering", "cheers", "snorts", "chuckles", "chuckling", "sighs", "silence",
        "inaudible", "noise", "background noise", "foreign", "sound", "musik", "música",
        "musique", "音乐", "音樂", "掌声", "笑声",
    ];
    let inner = inner.trim().to_lowercase();
    TAGS.contains(&inner.as_str())
}

/// 去掉一行字幕里的音效标注和 ♪，顺手把 VTT 的不断行空格（ffmpeg 转出来写成 `\h`，
/// YouTube 脏话码 `[\h__\h]` 里就有）还原成空格。返回清理后的文字（可能为空）。
fn strip_sound_tags(line: &str) -> String {
    let line = line.replace("\\h", " ").replace('♪', " ");
    let mut out = String::with_capacity(line.len());
    let mut rest = line.as_str();
    while let Some(open) = rest.find(['[', '［']) {
        let open_len = rest[open..].chars().next().map_or(1, char::len_utf8);
        let after = &rest[open + open_len..];
        let Some(close) = after.find([']', '］']) else {
            break;
        };
        let inner = &after[..close];
        let close_len = after[close..].chars().next().map_or(1, char::len_utf8);
        out.push_str(&rest[..open]);
        if is_sound_tag(inner) {
            // 中文里去掉标注不留空格（「我们[音乐]开始」→「我们开始」）。
            let next = after[close + close_len..].chars().next();
            if !(out.chars().last().is_some_and(is_cjk) || next.is_some_and(is_cjk)) {
                out.push(' ');
            }
        } else {
            out.push_str(&rest[open..open + open_len + close + close_len]);
        }
        rest = &after[close + close_len..];
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 每条字幕去掉音效标注；去完只剩空的行不要了。
fn strip_cue_sound_tags(cues: Vec<Cue>) -> Vec<Cue> {
    cues.into_iter()
        .map(|mut cue| {
            cue.lines = cue
                .lines
                .iter()
                .map(|line| strip_sound_tags(line))
                .filter(|line| !line.is_empty())
                .collect();
            cue
        })
        .collect()
}

/// 是不是 YouTube 那种「滚动」自动字幕：每条显示「上一行 + 正在滚出来的新一行」，
/// 中间还夹着只有 10 毫秒、重复上一行的定格条。
fn is_rolling(cues: &[Cue]) -> bool {
    let repeats = cues
        .windows(2)
        .filter(|pair| {
            pair[0].lines.last().is_some() && pair[1].lines.first() == pair[0].lines.last()
        })
        .count();
    // 普通字幕偶尔也会连着两条一样（「对。」「对。」），要成规模才算滚动字幕。
    repeats >= 3 && repeats * 3 >= cues.len()
}

/// 滚动字幕原样入库，同一句话会出现两三遍（翻译也跟着译几遍）：把每条开头和上一条
/// 末尾重复的行去掉，只留新滚出来的那一行；什么都不剩的定格条并进上一段。
fn collapse_rolling_captions(cues: Vec<Cue>) -> Vec<Cue> {
    let mut out: Vec<Cue> = Vec::with_capacity(cues.len() / 2);
    let mut shown: Vec<String> = Vec::new();
    for mut cue in cues {
        // 去掉开头那些已经显示过的行（上一条的末尾几行）。
        let overlap = (1..=cue.lines.len().min(shown.len()))
            .rev()
            .find(|&n| cue.lines[..n] == shown[shown.len() - n..])
            .unwrap_or(0);
        let fresh = cue.lines.split_off(overlap);
        if fresh.is_empty() {
            if let Some(last) = out.last_mut() {
                last.end_ms = last.end_ms.max(cue.end_ms);
            }
            continue;
        }
        shown = cue.lines.into_iter().chain(fresh.iter().cloned()).collect();
        out.push(Cue {
            start_ms: cue.start_ms,
            end_ms: cue.end_ms,
            lines: fresh,
        });
    }
    out
}

/// 一段最长多久，到了就在行尾断开。老的自动字幕整篇没有标点，只能这样分段；
/// 有标点的只给特别长的句子兜底。
const MAX_UNPUNCTUATED_MS: i64 = 8_000;
const MAX_SENTENCE_MS: i64 = 25_000;

/// 一个词（或一段不带空格的中日文）和它大约什么时候说出来。
struct Token {
    text: String,
    at_ms: i64,
    /// 和前一个词之间要不要空格。
    spaced: bool,
    /// 这一条字幕的最后一个词：这里可以在行尾断开。
    line_end: bool,
}

fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x3000..=0x303F
            | 0x3040..=0x30FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0xFF00..=0xFFEF
    )
}

/// 把一条字幕拆成词，按字数在这条的时间里摊开估出每个词的时间（转成 SRT 后逐词时间已经没了，
/// 一行只有两三秒，估出来差不到一秒）。中文没有空格，在句末标点后面断开。
fn tokenize_cue(cue: &Cue, prev_last: Option<char>, out: &mut Vec<Token>) {
    let text = cue.lines.join(" ");
    let total = text.chars().count().max(1) as i64;
    let span = (cue.end_ms - cue.start_ms).max(0);
    let first = out.len();
    let mut word = String::new();
    let mut word_start = 0usize;
    // 和上一条之间：英文照常空一格，中文接中文不空。
    let mut spaced = prev_last.is_some_and(|last| {
        !(is_cjk(last) && text.trim_start().chars().next().is_some_and(is_cjk))
    });
    for (i, c) in text.chars().enumerate() {
        if c.is_whitespace() {
            if !word.is_empty() {
                out.push(Token {
                    text: std::mem::take(&mut word),
                    at_ms: cue.start_ms + span * word_start as i64 / total,
                    spaced,
                    line_end: false,
                });
            }
            spaced = true;
            continue;
        }
        if word.is_empty() {
            word_start = i;
        }
        word.push(c);
        if matches!(c, '。' | '！' | '？') {
            out.push(Token {
                text: std::mem::take(&mut word),
                at_ms: cue.start_ms + span * word_start as i64 / total,
                spaced,
                line_end: false,
            });
            spaced = false;
        }
    }
    if !word.is_empty() {
        out.push(Token {
            text: word,
            at_ms: cue.start_ms + span * word_start as i64 / total,
            spaced,
            line_end: false,
        });
    }
    if out.len() > first {
        if let Some(last) = out.last_mut() {
            last.line_end = true;
        }
    }
}

/// 这个词是不是一句话的结尾。缩写（Mr. / e.g. / U.S.）和小数不算。
fn ends_sentence(word: &str) -> bool {
    let core = word.trim_end_matches(['"', '\'', '”', '’', ')', '）', '」', '』']);
    let Some(last) = core.chars().last() else {
        return false;
    };
    if matches!(last, '。' | '！' | '？' | '?' | '!') {
        return true;
    }
    if last != '.' || core.ends_with("..") {
        return core.ends_with("...") || core.ends_with('…');
    }
    let stem = core.trim_end_matches('.').to_lowercase();
    const ABBREVIATIONS: [&str; 12] = [
        "mr", "mrs", "ms", "dr", "prof", "st", "vs", "etc", "e.g", "i.e", "jr", "sr",
    ];
    // 单个字母（「A.」）和中间也带点的（「U.S.」）多半是缩写。
    !(ABBREVIATIONS.contains(&stem.as_str()) || stem.chars().count() == 1 || stem.contains('.'))
}

/// 滚动字幕按屏幕上的一行切，一句话常被拦腰截成两段（翻译也只能一段段译半句）。
/// 去重后把各行连成词流，在句末标点处重新断句；没有标点的攒到七八秒在行尾断开。
fn regroup_into_sentences(cues: Vec<Cue>) -> Vec<Cue> {
    let Some(final_end) = cues.last().map(|cue| cue.end_ms) else {
        return cues;
    };
    let mut tokens: Vec<Token> = Vec::new();
    for cue in &cues {
        let prev_last = tokens.last().and_then(|token| token.text.chars().last());
        tokenize_cue(cue, prev_last, &mut tokens);
    }
    // 平均几十个词才有一个句末标点，就当这份字幕没有标点。
    let sentence_ends = tokens.iter().filter(|token| ends_sentence(&token.text)).count();
    let max_ms = if sentence_ends * 60 >= tokens.len() {
        MAX_SENTENCE_MS
    } else {
        MAX_UNPUNCTUATED_MS
    };
    let mut out = Vec::new();
    let mut text = String::new();
    let mut start_ms = 0;
    for (i, token) in tokens.iter().enumerate() {
        if text.is_empty() {
            start_ms = token.at_ms;
        } else if token.spaced {
            text.push(' ');
        }
        text.push_str(&token.text);
        let next_at = tokens.get(i + 1).map_or(final_end, |next| next.at_ms);
        let too_long = token.line_end && next_at - start_ms >= max_ms;
        if ends_sentence(&token.text) || too_long || i + 1 == tokens.len() {
            out.push(Cue {
                start_ms,
                end_ms: next_at.max(start_ms),
                lines: vec![std::mem::take(&mut text)],
            });
        }
    }
    out
}

/// 解析 SRT 文本为段落。容错：忽略空条目、缺时间轴的文字；多行文本用空格拼接。
/// 去掉 [music] 这类音效标注；YouTube 的滚动自动字幕会去掉重复的行，并按句子重新分段。
pub fn parse_srt(input: &str) -> Vec<SubSegment> {
    let cues = strip_cue_sound_tags(parse_cues(input));
    let cues = if is_rolling(&cues) {
        regroup_into_sentences(collapse_rolling_captions(cues))
    } else {
        cues
    };
    cues.into_iter()
        .filter_map(|cue| {
            let text = cue.lines.join(" ").trim().to_string();
            (!text.is_empty()).then_some(SubSegment {
                start_ms: cue.start_ms,
                end_ms: cue.end_ms,
                text,
            })
        })
        .collect()
}

/// 该视频是否应做字幕 AI 纠错：视频级偏好（B站导入时勾选）优先，
/// NULL 回落全局设置 subtitle_autocorrect（默认开）。是否有可用 LLM 由调用方再判。
pub async fn autocorrect_enabled(db: &Db, video_id: &str) -> AppResult<bool> {
    let per_video: Option<Option<bool>> =
        sqlx::query_scalar("SELECT subtitle_autocorrect FROM videos WHERE id=?")
            .bind(video_id)
            .fetch_optional(&db.pool)
            .await?;
    if let Some(Some(preference)) = per_video {
        return Ok(preference);
    }
    Ok(sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key='subtitle_autocorrect'",
    )
    .fetch_optional(&db.pool)
    .await?
    .map(|value| value != "false")
    .unwrap_or(true))
}

/// 消化一份 SRT 字幕：解析 → 存原始快照(bilibili_sub) → 写文稿 →（可选）AI 纠错。
/// 返回写入的段数。
pub async fn ingest_subtitle(
    db: &Db,
    video_id: &str,
    srt_text: &str,
    correct: Option<(Provider, String)>,
    progress: crate::pipeline::ai::Progress<'_>,
) -> AppResult<usize> {
    let segs: Vec<StoredSegment> = parse_srt(srt_text)
        .into_iter()
        .map(|s| StoredSegment {
            start_ms: s.start_ms,
            end_ms: s.end_ms,
            text: s.text,
            words_json: "[]".into(),
        })
        .collect();
    let count = store_segments_with_backup(db, video_id, "bilibili_sub", &segs).await?;
    // 字幕到底还是来了（比如之后手动导入）：「没拿到字幕」的说明作废。
    sqlx::query("UPDATE videos SET subtitle_missing=NULL WHERE id=?")
        .bind(video_id)
        .execute(&db.pool)
        .await?;
    if let Some((provider, model)) = correct {
        transcript_correction::autocorrect_transcript(db, &provider, &model, video_id, progress)
            .await?;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_srt() {
        let srt = "1\n00:00:01,200 --> 00:00:03,400\n你好世界\n\n2\n00:00:03,400 --> 00:00:05,000\n第二句";
        let segs = parse_srt(srt);
        assert_eq!(segs.len(), 2);
        assert_eq!(
            segs[0],
            SubSegment {
                start_ms: 1200,
                end_ms: 3400,
                text: "你好世界".into()
            }
        );
        assert_eq!(segs[1].start_ms, 3400);
    }

    #[test]
    fn parses_crlf_srt() {
        // SRT 标准用 CRLF；yt-dlp/ffmpeg 落地的字幕常带 \r\n，块分隔为 \r\n\r\n。
        let srt = "1\r\n00:00:01,200 --> 00:00:03,400\r\n你好世界\r\n\r\n2\r\n00:00:03,400 --> 00:00:05,000\r\n第二句";
        let segs = parse_srt(srt);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].start_ms, 1200);
        assert_eq!(segs[0].text, "你好世界");
        assert_eq!(segs[1].start_ms, 3400);
        assert_eq!(segs[1].text, "第二句");
    }

    #[test]
    fn joins_multiline_and_skips_blank_blocks() {
        let srt = "1\n00:00:00,000 --> 00:00:02,000\n第一行\n第二行\n\n\n\n2\n00:00:02,000 --> 00:00:04,000\n下一段";
        let segs = parse_srt(srt);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].text, "第一行 第二行");
    }

    #[test]
    fn tolerates_dot_millis_and_drops_timeless_blocks() {
        let srt = "00:00:01.500 --> 00:00:02.500\nA\n\nnonsense block without arrow\n\n00:01:00,000 --> 00:01:01,000\nB";
        let segs = parse_srt(srt);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].start_ms, 1500);
        assert_eq!(segs[1].start_ms, 60_000);
    }

    /// yt-dlp 把 YouTube 自动字幕（VTT）转成 SRT 后的原样片段（MIT 18.06 第一讲开头）。
    const YOUTUBE_ROLLING_SRT: &str = "1\r\n00:00:07,940 --> 00:00:12,140\r\n\r\n\
        hi this is the first lecture in MIT s\r\n\r\n\
        2\r\n00:00:12,140 --> 00:00:12,150\r\nhi this is the first lecture in MIT s\r\n \r\n\r\n\
        3\r\n00:00:12,150 --> 00:00:16,670\r\nhi this is the first lecture in MIT s\r\ncourse 1806 linear algebra and I'm\r\n\r\n\
        4\r\n00:00:16,670 --> 00:00:16,680\r\ncourse 1806 linear algebra and I'm\r\n \r\n\r\n\
        5\r\n00:00:16,680 --> 00:00:20,630\r\ncourse 1806 linear algebra and I'm\r\nGilbert Strang the text for the course\r\n\r\n\
        6\r\n00:00:20,630 --> 00:00:20,640\r\nGilbert Strang the text for the course\r\n \r\n\r\n\
        7\r\n00:00:20,640 --> 00:00:24,710\r\nGilbert Strang the text for the course\r\nis this book introduction to linear\r\n";

    #[test]
    fn youtube_rolling_captions_keep_each_line_once() {
        // 这份没有标点：去重后攒到七八秒在行尾断开。
        let segs = parse_srt(YOUTUBE_ROLLING_SRT);
        let texts: Vec<&str> = segs.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(
            texts,
            vec![
                "hi this is the first lecture in MIT s course 1806 linear algebra and I'm",
                "Gilbert Strang the text for the course is this book introduction to linear",
            ]
        );
        // 第一条（时间轴和文字之间夹着空行）不能丢。
        assert_eq!((segs[0].start_ms, segs[0].end_ms), (7940, 16680));
        assert_eq!((segs[1].start_ms, segs[1].end_ms), (16680, 24710));
    }

    /// 按 yt-dlp 转出来的样子拼一份滚动字幕：每行一条「上一行 + 新行」，后面跟一条 10 毫秒的定格条。
    fn rolling_srt(lines: &[(i64, &str)], end_ms: i64) -> String {
        let fmt = |ms: i64| {
            format!(
                "{:02}:{:02}:{:02},{:03}",
                ms / 3_600_000,
                ms / 60_000 % 60,
                ms / 1000 % 60,
                ms % 1000
            )
        };
        let mut out = String::new();
        let mut index = 1;
        for (i, (start, text)) in lines.iter().enumerate() {
            let next = lines.get(i + 1).map_or(end_ms, |(at, _)| *at);
            let prev = if i == 0 { "" } else { lines[i - 1].1 };
            out += &format!(
                "{index}\r\n{} --> {}\r\n{prev}\r\n{text}\r\n\r\n",
                fmt(*start),
                fmt(next - 10)
            );
            out += &format!(
                "{}\r\n{} --> {}\r\n{text}\r\n \r\n\r\n",
                index + 1,
                fmt(next - 10),
                fmt(next)
            );
            index += 2;
        }
        out
    }

    #[test]
    fn youtube_rolling_captions_are_regrouped_into_sentences() {
        // 「Yes, you should panic about AI」开头：句号常落在一行中间。
        let srt = rolling_srt(
            &[
                (0, "Imagine you've got two groups of"),
                (2000, "experts. Group one says all kinds of"),
                (4319, "reasonable things you intuitively agree"),
                (6319, "with, but they've been wrong again and"),
                (8480, "again for over a decade. Then there's"),
                (10960, "group two. They say Mr. Smith was right"),
            ],
            13360,
        );
        let segs = parse_srt(&srt);
        let texts: Vec<&str> = segs.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(
            texts,
            vec![
                "Imagine you've got two groups of experts.",
                "Group one says all kinds of reasonable things you intuitively agree with, \
                 but they've been wrong again and again for over a decade.",
                "Then there's group two.",
                "They say Mr. Smith was right",
            ]
        );
        // 句中断开的地方按字数在那一行里估时间：「Group」大约在第二行的四分之一处。
        assert_eq!(segs[0].start_ms, 0);
        assert!((2000..2900).contains(&segs[1].start_ms), "{}", segs[1].start_ms);
        assert_eq!(segs[0].end_ms, segs[1].start_ms);
        assert_eq!(segs.last().unwrap().end_ms, 13360);
    }

    #[test]
    fn chinese_rolling_captions_split_after_full_stops() {
        let srt = rolling_srt(
            &[
                (0, "我们先回忆一下上节课的"),
                (2000, "损失函数。梯度指向函数"),
                (4000, "值增长最快的方向。"),
                (6000, "所以要沿着负梯度走"),
            ],
            8000,
        );
        let texts: Vec<String> = parse_srt(&srt).into_iter().map(|s| s.text).collect();
        assert_eq!(
            texts,
            vec![
                "我们先回忆一下上节课的损失函数。",
                "梯度指向函数值增长最快的方向。",
                "所以要沿着负梯度走",
            ]
        );
    }

    #[test]
    fn sound_tags_are_dropped_but_other_brackets_stay() {
        assert_eq!(strip_sound_tags("than you [music] think."), "than you think.");
        assert_eq!(strip_sound_tags("[Music]"), "");
        assert_eq!(strip_sound_tags("［music］ Next, we"), "Next, we");
        assert_eq!(strip_sound_tags("pause either. [snorts] Anthropic"), "pause either. Anthropic");
        assert_eq!(strip_sound_tags("我们[音乐]开始"), "我们开始");
        assert_eq!(strip_sound_tags("♪ la la ♪"), "la la");
        // YouTube 的脏话码、区间、数字这些不是音效，原样留着（\h 还原成空格）。
        assert_eq!(strip_sound_tags("wanted to [\\h__\\h] an entire"), "wanted to [ __ ] an entire");
        assert_eq!(strip_sound_tags("on [a, b] we have"), "on [a, b] we have");
        assert_eq!(strip_sound_tags("see [1] and [x]"), "see [1] and [x]");
        assert_eq!(strip_sound_tags("请看[第三章附录]的推导"), "请看[第三章附录]的推导");
        assert_eq!(strip_sound_tags("the interval [a b], [sic]"), "the interval [a b], [sic]");
        assert_eq!(strip_sound_tags("[Applause] thanks"), "thanks");
        assert_eq!(strip_sound_tags("word\\hword"), "word word");
    }

    #[test]
    fn rolling_captions_drop_music_tags_without_breaking_sentences() {
        let srt = rolling_srt(
            &[
                (0, "It's right. [music]"),
                (2000, "[music]"),
                (4000, "Today's models are [music] better."),
            ],
            6000,
        );
        let texts: Vec<String> = parse_srt(&srt).into_iter().map(|s| s.text).collect();
        assert_eq!(texts, vec!["It's right.", "Today's models are better."]);
    }

    #[test]
    fn a_cue_that_is_only_a_sound_tag_disappears() {
        let srt = "1\n00:00:01,000 --> 00:00:02,000\n[Applause]\n\n2\n00:00:02,000 --> 00:00:03,000\n谢谢大家";
        let texts: Vec<String> = parse_srt(srt).into_iter().map(|s| s.text).collect();
        assert_eq!(texts, vec!["谢谢大家"]);
    }

    #[test]
    fn ordinary_subtitles_with_a_repeated_line_are_left_alone() {
        let srt = "1\n00:00:01,000 --> 00:00:02,000\n对。\n\n2\n00:00:02,000 --> 00:00:03,000\n对。\n\n\
                   3\n00:00:03,000 --> 00:00:04,000\n我们开始吧\n\n4\n00:00:04,000 --> 00:00:05,000\n今天讲梯度";
        let texts: Vec<String> = parse_srt(srt).into_iter().map(|s| s.text).collect();
        assert_eq!(texts, vec!["对。", "对。", "我们开始吧", "今天讲梯度"]);
    }

    #[test]
    fn a_numeric_line_inside_a_cue_is_text_not_an_index() {
        let srt = "1\n00:00:01,000 --> 00:00:02,000\n答案是\n42\n\n2\n00:00:02,000 --> 00:00:03,000\n下一句";
        let texts: Vec<String> = parse_srt(srt).into_iter().map(|s| s.text).collect();
        assert_eq!(texts, vec!["答案是 42", "下一句"]);
    }

    async fn seed_video_for_gate(dir: &tempfile::TempDir) -> (crate::db::Db, String) {
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
        let vpath = dir.path().join("v.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, vpath, None)
            .await
            .unwrap();
        (db, video.id)
    }

    #[tokio::test]
    async fn autocorrect_gate_prefers_per_video_over_global() {
        let dir = tempfile::tempdir().unwrap();
        let (db, video_id) = seed_video_for_gate(&dir).await;

        // 都未设置：默认开。
        assert!(autocorrect_enabled(&db, &video_id).await.unwrap());

        // 全局关、视频未设置 → 跟随全局：关。
        sqlx::query("INSERT INTO settings(key,value) VALUES('subtitle_autocorrect','false')")
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(!autocorrect_enabled(&db, &video_id).await.unwrap());

        // 视频级 true 覆盖全局 false。
        sqlx::query("UPDATE videos SET subtitle_autocorrect=1 WHERE id=?")
            .bind(&video_id)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(autocorrect_enabled(&db, &video_id).await.unwrap());

        // 视频级 false 覆盖全局 true。
        sqlx::query("UPDATE settings SET value='true' WHERE key='subtitle_autocorrect'")
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE videos SET subtitle_autocorrect=0 WHERE id=?")
            .bind(&video_id)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(!autocorrect_enabled(&db, &video_id).await.unwrap());
    }

    #[tokio::test]
    async fn ingest_writes_segments_without_correction() {
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
        let vpath = dir.path().join("v.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, vpath, None)
            .await
            .unwrap();

        let srt =
            "1\n00:00:00,000 --> 00:00:01,000\n第一句\n\n2\n00:00:01,000 --> 00:00:02,000\n第二句";
        let n = ingest_subtitle(&db, &video.id, srt, None, None)
            .await
            .unwrap();
        assert_eq!(n, 2);
        let cnt: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcripts WHERE video_id=?")
            .bind(&video.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(cnt, 2);
        // 字幕到底还是导进来了：下载时记下的「没拿到字幕」作废。
        sqlx::query("UPDATE videos SET subtitle_missing='rateLimited' WHERE id=?")
            .bind(&video.id)
            .execute(&db.pool)
            .await
            .unwrap();
        ingest_subtitle(&db, &video.id, srt, None, None)
            .await
            .unwrap();
        let missing: Option<String> =
            sqlx::query_scalar("SELECT subtitle_missing FROM videos WHERE id=?")
                .bind(&video.id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(missing, None);
    }

    /// 字幕纠错也要逐批报进度：此前整段停在 60%，进度条只靠前端按时间估着往前挪。
    #[tokio::test]
    async fn subtitle_correction_reports_progress() {
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
        let vpath = dir.path().join("v.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, vpath, None)
            .await
            .unwrap();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(f64, String)>::new()));
        let sink = {
            let seen = std::sync::Arc::clone(&seen);
            move |at: f64, message: &str| seen.lock().unwrap().push((at, message.to_string()))
        };

        let srt = "1\n00:00:00,000 --> 00:00:01,000\n第一句";
        // 空补丁：不改任何字，这里只看进度有没有报出来。
        let correct = Some((
            Provider::Mock {
                canned: "[]".into(),
            },
            "m".to_string(),
        ));
        ingest_subtitle(&db, &video.id, srt, correct, Some(&sink))
            .await
            .unwrap();

        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.last().map(|(at, _)| *at), Some(1.0), "实际 {seen:?}");
    }

    #[tokio::test]
    async fn invalid_subtitle_does_not_erase_existing_transcript() {
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
        let vpath = dir.path().join("v.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, vpath, None)
            .await
            .unwrap();
        let valid = "1\n00:00:00,000 --> 00:00:01,000\n原文";
        ingest_subtitle(&db, &video.id, valid, None, None)
            .await
            .unwrap();
        let backups_before: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM transcript_backups WHERE video_id=?")
                .bind(&video.id)
                .fetch_one(&db.pool)
                .await
                .unwrap();

        assert!(
            ingest_subtitle(&db, &video.id, "not an srt file", None, None)
                .await
                .is_err()
        );

        let texts: Vec<String> = sqlx::query_scalar(
            "SELECT text FROM transcripts WHERE video_id=? ORDER BY segment_idx",
        )
        .bind(&video.id)
        .fetch_all(&db.pool)
        .await
        .unwrap();
        assert_eq!(texts, vec!["原文"]);
        let backups_after: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM transcript_backups WHERE video_id=?")
                .bind(&video.id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(backups_after, backups_before);
    }
}
