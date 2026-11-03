//! 本地语音识别的第二条通道：sherpa-onnx 跑的中文模型（SenseVoice、Qwen3-ASR）。
//!
//! 为什么要它：在三段带人工转写的讲课录音上（docs/asr-benchmark），大陆普通话的混合错误率
//! Whisper base 13.4%、large-v3-turbo 7.3%，SenseVoice 3.3%、Qwen3-ASR 2.5%；SenseVoice
//! 和 Whisper base 一样快。中英混杂的课 Whisper turbo 仍然最好，所以 Whisper 那条通道保留。
//!
//! 这里只放「有哪些模型、文件从哪下、装好了没有」这类纯数据，各平台都编译；
//! 真正跑模型的在 `sherpa_asr`（只在桌面）。
//!
//! 下载源：sherpa-onnx 官方只把模型放在 GitHub Release 和 HuggingFace，国内都慢。
//! 每个文件先试 ModelScope 上的镜像，再退到 HuggingFace / GitHub；**不管从哪下，
//! 都按官方发布包里那份文件的 SHA-256 校验**，镜像被换了内容也装不进来。

use std::path::{Path, PathBuf};

/// sherpa-onnx 能跑的模型种类（决定识别器怎么配）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SherpaKind {
    SenseVoice,
    Qwen3Asr,
}

/// 模型里的一个文件。`path` 是相对模型目录的路径，下载源依次尝试。
#[derive(Debug)]
pub struct ModelFile {
    pub path: &'static str,
    pub sha256: &'static str,
    pub size: u64,
    pub urls: &'static [&'static str],
}

#[derive(Debug)]
pub struct SherpaModel {
    /// 设置里 `whisper_model` 存的值（和 Whisper 的 tiny / base… 放在同一个列表里）。
    pub id: &'static str,
    pub display_name: &'static str,
    pub kind: SherpaKind,
    /// 装在 `<app_data>/asr/<dir>/` 下。
    pub dir: &'static str,
    pub files: &'static [ModelFile],
    /// 支持的识别语言；`None` 表示设置里的语言都支持。
    pub languages: Option<&'static [&'static str]>,
}

macro_rules! urls {
    ($($url:expr),+ $(,)?) => { &[$($url),+] };
}

pub const SENSE_VOICE: SherpaModel = SherpaModel {
    id: "sensevoice",
    display_name: "SenseVoice（中文推荐 · 快）",
    kind: SherpaKind::SenseVoice,
    dir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
    // 2024-07-17 这一版开 ITN 会带标点；2025-09-09 版不出标点，文稿读起来是一整坨。
    files: &[
        ModelFile {
            path: "model.int8.onnx",
            sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
            size: 239_233_841,
            urls: urls![
                "https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master/model.int8.onnx",
                "https://modelscope.cn/models/chriscrs/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/resolve/master/model.int8.onnx",
                "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx",
            ],
        },
        ModelFile {
            path: "tokens.txt",
            sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
            size: 315_894,
            urls: urls![
                "https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master/tokens.txt",
                "https://modelscope.cn/models/chriscrs/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/resolve/master/tokens.txt",
                "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt",
            ],
        },
    ],
    languages: Some(&["zh", "en", "ja", "ko", "yue", "auto"]),
};

pub const QWEN3_ASR: SherpaModel = SherpaModel {
    id: "qwen3-asr",
    display_name: "Qwen3-ASR 0.6B（中文高精度）",
    kind: SherpaKind::Qwen3Asr,
    dir: "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
    files: &[
        ModelFile {
            path: "conv_frontend.onnx",
            sha256: "d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e",
            size: 44_148_281,
            urls: urls![
                "https://modelscope.cn/models/jkman2023/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/master/conv_frontend.onnx",
                "https://huggingface.co/cattle12/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/main/conv_frontend.onnx",
                "https://huggingface.co/aoiandroid/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/main/conv_frontend.onnx",
            ],
        },
        ModelFile {
            path: "encoder.int8.onnx",
            sha256: "60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9",
            size: 182_491_662,
            urls: urls![
                "https://modelscope.cn/models/jkman2023/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/master/encoder.int8.onnx",
                "https://huggingface.co/cattle12/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/main/encoder.int8.onnx",
                "https://huggingface.co/aoiandroid/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/main/encoder.int8.onnx",
            ],
        },
        ModelFile {
            path: "decoder.int8.onnx",
            sha256: "4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771",
            size: 755_914_231,
            urls: urls![
                "https://modelscope.cn/models/jkman2023/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/master/decoder.int8.onnx",
                "https://huggingface.co/cattle12/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/main/decoder.int8.onnx",
                "https://huggingface.co/aoiandroid/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/main/decoder.int8.onnx",
            ],
        },
        ModelFile {
            path: "tokenizer/merges.txt",
            sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
            size: 1_671_853,
            urls: urls![
                "https://modelscope.cn/models/jkman2023/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/master/tokenizer/merges.txt",
                "https://huggingface.co/cattle12/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/main/tokenizer/merges.txt",
            ],
        },
        ModelFile {
            path: "tokenizer/tokenizer_config.json",
            sha256: "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c",
            size: 12_487,
            urls: urls![
                "https://modelscope.cn/models/jkman2023/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/master/tokenizer/tokenizer_config.json",
                "https://huggingface.co/cattle12/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/main/tokenizer/tokenizer_config.json",
            ],
        },
        ModelFile {
            path: "tokenizer/vocab.json",
            sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
            size: 2_776_833,
            urls: urls![
                "https://modelscope.cn/models/jkman2023/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/master/tokenizer/vocab.json",
                "https://huggingface.co/cattle12/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/main/tokenizer/vocab.json",
            ],
        },
    ],
    languages: None,
};

/// 切句用的 silero VAD，所有 sherpa 模型共用一份，装在 `<app_data>/asr/` 下。
pub const VAD: ModelFile = ModelFile {
    path: "silero_vad.onnx",
    sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
    size: 643_854,
    urls: urls![
        "https://modelscope.cn/models/fuyuantech/fuyuan-sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/resolve/master/silero_vad.onnx",
        "https://modelscope.cn/models/jkman2023/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/master/silero_vad.onnx",
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
    ],
};

pub const MODELS: &[&SherpaModel] = &[&SENSE_VOICE, &QWEN3_ASR];

pub fn find(id: &str) -> Option<&'static SherpaModel> {
    MODELS.iter().copied().find(|model| model.id == id)
}

pub fn asr_root(app_data: &Path) -> PathBuf {
    app_data.join("asr")
}

pub fn model_dir(app_data: &Path, model: &SherpaModel) -> PathBuf {
    asr_root(app_data).join(model.dir)
}

pub fn vad_path(app_data: &Path) -> PathBuf {
    asr_root(app_data).join(VAD.path)
}

impl SherpaModel {
    /// 模型文件 + 共用的 VAD 加起来要下多少。
    pub fn download_size(&self) -> u64 {
        self.files.iter().map(|file| file.size).sum::<u64>() + VAD.size
    }

    pub fn supports_language(&self, language: &str) -> bool {
        self.languages
            .is_none_or(|languages| languages.contains(&language))
    }
}

/// 文件在、大小对得上就算装好了。哈希只在下载时校验一次：每次打开设置页都把
/// 近 1GB 的模型读一遍算哈希，不值得。
fn file_ok(path: &Path, file: &ModelFile) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() == file.size)
}

pub fn is_installed(app_data: &Path, model: &SherpaModel) -> bool {
    let dir = model_dir(app_data, model);
    model.files.iter().all(|file| file_ok(&dir.join(file.path), file))
        && file_ok(&vad_path(app_data), &VAD)
}

/// 还缺哪些文件（含共用 VAD），给下载用：已经下好的不再重下。
pub fn missing_files(app_data: &Path, model: &'static SherpaModel) -> Vec<(PathBuf, &'static ModelFile)> {
    let dir = model_dir(app_data, model);
    let mut missing: Vec<(PathBuf, &'static ModelFile)> = model
        .files
        .iter()
        .map(|file| (dir.join(file.path), file))
        .filter(|(path, file)| !file_ok(path, file))
        .collect();
    let vad = vad_path(app_data);
    if !file_ok(&vad, &VAD) {
        missing.push((vad, &VAD));
    }
    missing
}

/// 交给 Qwen3-ASR 的热词：最多这么多个、拼起来最多这么长。热词进的是模型的提示，
/// 太长会挤占生成预算；也别贪多——实测给了课里没讲的词，模型会往文稿里硬塞（docs/asr-benchmark）。
const MAX_HOTWORDS: usize = 100;
const MAX_HOTWORDS_CHARS: usize = 1000;

/// 用户的热词表 → Qwen3-ASR 要的格式（ASCII 逗号分隔）。词里的逗号会把一个词拆成两个，去掉；
/// 超出上限的丢弃（保留靠前的，用户通常把最要紧的写在前面）。没有热词返回 None。
pub fn qwen3_hotwords(terms: &[String]) -> Option<String> {
    let mut out = String::new();
    let mut count = 0;
    for term in terms {
        let term: String = term.chars().filter(|c| !matches!(c, ',' | '，')).collect();
        let term = term.trim();
        if term.is_empty() {
            continue;
        }
        let extra = term.chars().count() + usize::from(!out.is_empty());
        if count == MAX_HOTWORDS || out.chars().count() + extra > MAX_HOTWORDS_CHARS {
            break;
        }
        if !out.is_empty() {
            out.push(',');
        }
        out.push_str(term);
        count += 1;
    }
    (!out.is_empty()).then_some(out)
}

// ---------------------------------------------------------------------------
// WAV：桌面上 ffmpeg 已经转好 16kHz 单声道；手机上原生桥导出的是视频原本的采样率和声道数
// （44.1 / 48kHz 立体声居多），读的时候再混成单声道、重采样。这里只管解析，重采样在 sherpa_asr。
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WavFormat {
    pub channels: u16,
    pub sample_rate: u32,
    pub bits: u16,
    /// 32 位浮点样本（format tag 3，或扩展头里的浮点子格式）。
    pub float: bool,
    pub data_offset: u64,
    pub data_len: u64,
}

impl WavFormat {
    pub fn block_align(&self) -> usize {
        self.channels as usize * (self.bits as usize / 8)
    }
}

fn le16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn le32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// 解析 WAV 头（`head` 是文件开头一段，足够覆盖到 data 块的起点即可）。
/// 只认 16 位整数和 32 位浮点 PCM；data 块声明的长度超过文件就按文件实际长度算
/// （边写边封口的 WAV 常把长度写成 0 或 0xFFFFFFFF）。
pub fn parse_wav_header(head: &[u8], file_len: u64) -> Option<WavFormat> {
    if head.get(0..4)? != b"RIFF" || head.get(8..12)? != b"WAVE" {
        return None;
    }
    let mut at = 12;
    let mut fmt: Option<(u16, u16, u32, u16)> = None;
    while at + 8 <= head.len() {
        let id = &head[at..at + 4];
        let size = le32(head, at + 4)? as usize;
        let body = at + 8;
        if id == b"fmt " {
            let mut tag = le16(head, body)?;
            let channels = le16(head, body + 2)?;
            let rate = le32(head, body + 4)?;
            let bits = le16(head, body + 14)?;
            if tag == 0xFFFE {
                // WAVE_FORMAT_EXTENSIBLE：真正的格式在子格式 GUID 的前两个字节。
                tag = le16(head, body + 24)?;
            }
            fmt = Some((tag, channels, rate, bits));
        } else if id == b"data" {
            let (tag, channels, sample_rate, bits) = fmt?;
            let float = tag == 3 && bits == 32;
            if !(tag == 1 && bits == 16) && !float || channels == 0 || sample_rate == 0 {
                return None;
            }
            let available = file_len.saturating_sub(body as u64);
            let declared = size as u64;
            let data_len = if declared == 0 || declared > available { available } else { declared };
            return Some(WavFormat {
                channels,
                sample_rate,
                bits,
                float,
                data_offset: body as u64,
                data_len,
            });
        }
        // 块按偶数字节对齐。
        at = body + size + (size & 1);
    }
    None
}

/// 一段交错的多声道样本混成单声道浮点（-1..1）。末尾不满一帧的字节丢掉。
pub fn frames_to_mono(bytes: &[u8], format: &WavFormat) -> Vec<f32> {
    let channels = format.channels as usize;
    let width = format.bits as usize / 8;
    bytes
        .chunks_exact(format.block_align())
        .map(|frame| {
            let sum: f32 = frame
                .chunks_exact(width)
                .map(|sample| {
                    if format.float {
                        f32::from_le_bytes(sample.try_into().unwrap())
                    } else {
                        i16::from_le_bytes(sample.try_into().unwrap()) as f32 / 32768.0
                    }
                })
                .sum();
            sum / channels as f32
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 识别结果 → 文稿行。纯函数，各平台都编译，方便测。
// ---------------------------------------------------------------------------

/// 一句话一行，超过这么多字还没遇到句末标点，就在逗号处断开。
const LONG_SENTENCE_CHARS: usize = 40;
/// 断在逗号处时，前半截至少要这么长，免得切出一堆「好，」「然后，」。
const MIN_CLAUSE_CHARS: usize = 12;

fn is_sentence_end(c: char) -> bool {
    matches!(c, '。' | '！' | '？' | '!' | '?' | '；' | ';' | '…')
}

fn is_clause_end(c: char) -> bool {
    matches!(c, '，' | ',' | '、' | '：' | ':')
}

/// 去掉模型输出里的控制标记（SenseVoice 的 `<|zh|>`、`<|NEUTRAL|>` 这类）。
pub fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<|") {
        out.push_str(&rest[..start]);
        match rest[start..].find("|>") {
            Some(end) => rest = &rest[start + end + 2..],
            None => {
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// 一段 VAD 语音（≤ 20 秒）的识别结果切成句子，返回（起止字符位置）。
pub fn split_sentences(text: &str) -> Vec<(usize, usize)> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut start = 0;
    let mut last_clause: Option<usize> = None;
    for (i, &c) in chars.iter().enumerate() {
        if is_sentence_end(c) {
            out.push((start, i + 1));
            start = i + 1;
            last_clause = None;
            continue;
        }
        if is_clause_end(c) && i + 1 - start >= MIN_CLAUSE_CHARS {
            last_clause = Some(i + 1);
        }
        if i + 1 - start > LONG_SENTENCE_CHARS {
            if let Some(cut) = last_clause.take() {
                out.push((start, cut));
                start = cut;
            }
        }
    }
    if start < chars.len() {
        out.push((start, chars.len()));
    }
    // 只剩标点 / 空白的碎片并回前一句。
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (a, b) in out {
        let has_content = chars[a..b].iter().any(|c| c.is_alphanumeric());
        match merged.last_mut() {
            Some(last) if !has_content => last.1 = b,
            _ => merged.push((a, b)),
        }
    }
    merged
}

/// 段内第 `char_idx` 个字大约在什么时刻（毫秒）。
///
/// 有逐 token 时间戳（SenseVoice）时按 token 定位：token 依次拼起来就是正文，数到第几个字
/// 落在哪个 token 上，就取那个 token 的时间。拼不上（ITN 把「二零二三」改成了「2023」之类）
/// 或者模型不给时间戳（Qwen3-ASR），就按字数在整段里平均分——段本身是 VAD 切出来的，
/// 起止很准，段内按比例分误差不过一两秒。
pub fn char_time_ms(
    char_idx: usize,
    total_chars: usize,
    seg_start_ms: i64,
    seg_end_ms: i64,
    token_times: Option<&[(usize, f32)]>,
) -> i64 {
    if let Some(times) = token_times {
        if let Some(&(_, t)) = times.iter().rev().find(|(at, _)| *at <= char_idx) {
            return (seg_start_ms + (t * 1000.0) as i64).clamp(seg_start_ms, seg_end_ms);
        }
    }
    if total_chars == 0 {
        return seg_start_ms;
    }
    seg_start_ms + (seg_end_ms - seg_start_ms) * char_idx as i64 / total_chars as i64
}

/// token 文本依次在正文里的起始字符位置，配上它的时间戳。对不上就返回 None。
pub fn token_char_times(text: &str, tokens: &[String], timestamps: &[f32]) -> Option<Vec<(usize, f32)>> {
    if tokens.len() != timestamps.len() || tokens.is_empty() {
        return None;
    }
    let chars: Vec<char> = text.chars().collect();
    let mut pos = 0;
    let mut out = Vec::with_capacity(tokens.len());
    for (token, &t) in tokens.iter().zip(timestamps) {
        // SentencePiece 的词首标记「▁」和空格不占正文位置。
        let piece: Vec<char> = token.chars().filter(|c| *c != '▁' && !c.is_whitespace()).collect();
        if piece.is_empty() {
            continue;
        }
        // 正文里 token 之间可能夹着标点 / 空格（ITN 加的），往后找第一次出现的位置。
        let found = (pos..chars.len()).find(|&at| chars[at..].starts_with(&piece))?;
        out.push((found, t));
        pos = found + piece.len();
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_ids_do_not_collide_with_whisper_models() {
        for model in MODELS {
            assert!(crate::commands::whisper::MODELS.iter().all(|w| w.id != model.id));
            assert!(model.files.iter().all(|f| f.sha256.len() == 64 && !f.urls.is_empty()));
            assert!(model.files.iter().all(|f| f.urls[0].starts_with("https://modelscope.cn/")), "国内镜像排第一");
        }
        assert_eq!(find("sensevoice").unwrap().kind, SherpaKind::SenseVoice);
        assert!(find("base").is_none());
    }

    #[test]
    fn install_state_follows_file_sizes_and_includes_the_shared_vad() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        assert!(!is_installed(app_data, &SENSE_VOICE));
        assert_eq!(missing_files(app_data, &SENSE_VOICE).len(), 3);

        let model = model_dir(app_data, &SENSE_VOICE);
        std::fs::create_dir_all(&model).unwrap();
        std::fs::write(model.join("tokens.txt"), vec![0u8; 315_894]).unwrap();
        // 大小不对（下了一半）不算。
        std::fs::write(model.join("model.int8.onnx"), b"partial").unwrap();
        let missing: Vec<&str> = missing_files(app_data, &SENSE_VOICE).iter().map(|(_, f)| f.path).collect();
        assert_eq!(missing, ["model.int8.onnx", "silero_vad.onnx"]);
    }

    #[test]
    fn sense_voice_only_covers_its_languages() {
        assert!(SENSE_VOICE.supports_language("zh"));
        assert!(!SENSE_VOICE.supports_language("fr"));
        assert!(QWEN3_ASR.supports_language("fr"));
    }

    fn wav_bytes(channels: u16, rate: u32, samples: &[i16], extra_chunk: bool) -> Vec<u8> {
        let mut out = Vec::new();
        let data: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
        out.extend_from_slice(&(channels * 2).to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        if extra_chunk {
            // ffmpeg 会在 data 前塞一个 LIST 块；奇数长度要补一个字节。
            out.extend_from_slice(b"LIST");
            out.extend_from_slice(&3u32.to_le_bytes());
            out.extend_from_slice(b"abc\0");
        }
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&data);
        out
    }

    #[test]
    fn parses_android_style_stereo_wav_and_downmixes_it() {
        let bytes = wav_bytes(2, 44_100, &[16_384, 0, -16_384, -16_384], true);
        let format = parse_wav_header(&bytes, bytes.len() as u64).unwrap();
        assert_eq!((format.channels, format.sample_rate, format.bits, format.float), (2, 44_100, 16, false));
        assert_eq!(format.data_len, 8);
        let mono = frames_to_mono(&bytes[format.data_offset as usize..], &format);
        assert_eq!(mono, vec![0.25, -0.5]);
    }

    #[test]
    fn data_length_written_as_zero_or_too_large_falls_back_to_the_file_size() {
        let mut bytes = wav_bytes(1, 16_000, &[1, 2, 3], false);
        let data_size_at = bytes.len() - 6 - 4;
        bytes[data_size_at..data_size_at + 4].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        let format = parse_wav_header(&bytes, bytes.len() as u64).unwrap();
        assert_eq!(format.data_len, 6);
    }

    #[test]
    fn rejects_formats_we_cannot_read() {
        let mut bytes = wav_bytes(1, 16_000, &[1], false);
        bytes[34] = 24; // 24 位
        assert!(parse_wav_header(&bytes, bytes.len() as u64).is_none());
        assert!(parse_wav_header(b"not a wav file at all", 21).is_none());
    }

    #[test]
    fn hotwords_are_joined_with_ascii_commas_and_capped() {
        let terms: Vec<String> = ["勒沙特列原理", " 焓变 ", "", "a,b"].iter().map(|s| s.to_string()).collect();
        assert_eq!(qwen3_hotwords(&terms).as_deref(), Some("勒沙特列原理,焓变,ab"));
        assert_eq!(qwen3_hotwords(&[]), None);
        let many: Vec<String> = (0..500).map(|i| format!("术语{i}")).collect();
        let joined = qwen3_hotwords(&many).unwrap();
        assert_eq!(joined.split(',').count(), MAX_HOTWORDS);
        assert!(joined.chars().count() <= MAX_HOTWORDS_CHARS);
    }

    #[test]
    fn strips_control_tags() {
        assert_eq!(strip_tags("<|zh|><|NEUTRAL|><|Speech|><|withitn|>你好。"), "你好。");
        assert_eq!(strip_tags("没有标记"), "没有标记");
    }

    #[test]
    fn splits_at_sentence_ends_and_long_clauses() {
        let text = "大家好，我是张老师。今天讲梯度下降！为什么呢？";
        let parts: Vec<String> = split_sentences(text)
            .into_iter()
            .map(|(a, b)| text.chars().skip(a).take(b - a).collect())
            .collect();
        assert_eq!(parts, ["大家好，我是张老师。", "今天讲梯度下降！", "为什么呢？"]);

        let long = "我们这节课给大家介绍的学校都是一些性价比很高的学校，不管是各位同学你是考得好还是考得不好，今天要介绍的这么一大堆学校的话呢绝对有一个是适合你的";
        let parts = split_sentences(long);
        assert!(parts.len() >= 2, "{parts:?}");
        assert_eq!(parts.first().unwrap().0, 0);
        assert_eq!(parts.last().unwrap().1, long.chars().count());
    }

    #[test]
    fn trailing_punctuation_fragments_join_the_previous_sentence() {
        let text = "好的。」";
        assert_eq!(split_sentences(text), vec![(0, 4)]);
    }

    #[test]
    fn maps_tokens_to_text_positions_and_falls_back_to_proportional_times() {
        let tokens: Vec<String> = ["▁大家", "好", "我", "是"].iter().map(|s| s.to_string()).collect();
        let times = token_char_times("大家好，我是", &tokens, &[0.1, 0.5, 1.0, 1.2]).unwrap();
        assert_eq!(times, vec![(0, 0.1), (2, 0.5), (4, 1.0), (5, 1.2)]);
        assert_eq!(char_time_ms(4, 6, 10_000, 12_000, Some(&times)), 11_000);
        // 拼不上就退回按比例。
        assert!(token_char_times("完全不同", &tokens, &[0.1, 0.5, 1.0, 1.2]).is_none());
        assert_eq!(char_time_ms(3, 6, 10_000, 12_000, None), 11_000);
    }
}
