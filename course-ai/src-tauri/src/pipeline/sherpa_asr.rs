//! 用 sherpa-onnx 跑本地中文识别（SenseVoice / Qwen3-ASR），产出和 Whisper 一样的 `WhisperJson`，
//! 之后的入库、纠错、切句一概照旧。
//!
//! 流程：silero VAD 把整段音频切成 ≤ 20 秒的语音段（顺带把长静音整个跳过——Whisper 那条通道
//! 要靠事后清理去掉静音里编出来的字，这里压根不送进模型）→ 逐段识别 → 按标点切成一句一行，
//! 时间用 token 时间戳或按字数在段内分配。
//!
//! 模型推理是阻塞的 CPU 活，放在 `spawn_blocking` 里；进度通过原子量带出来，由异步那边定时
//! 汇报。调用方丢弃 future（取消处理）时，守卫会置位停止标志，识别线程在下一段之前退出。
//! 不走 GPU：Mac 上 ONNX Runtime 只能经 CoreML，实测比 CPU 慢 3–6 倍、内存翻几倍（见 docs/asr-benchmark）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use sherpa_onnx::{
    LinearResampler, OfflineRecognizer, OfflineRecognizerConfig, OfflineQwen3ASRModelConfig,
    OfflineSenseVoiceModelConfig, SileroVadModelConfig, VadModelConfig, VoiceActivityDetector,
};

use super::asr::{Offsets, WhisperJson, WhisperSegment};
use super::local_asr::{self, SherpaKind, SherpaModel};
use crate::error::{AppError, AppResult};

const SAMPLE_RATE: i32 = 16_000;
/// silero VAD 一次喂这么多个采样点（模型固定的窗口）。
const VAD_WINDOW: usize = 512;
/// 单段语音上限。Qwen3-ASR 的生成预算按这个长度留（见 `qwen3_config`）。
const MAX_SPEECH_SECONDS: f32 = 20.0;

/// 识别线程数。Apple Silicon 上取性能核数（M4 是 4）：实测 4 线程 6.9 秒、5 线程 8.1 秒、8 线程 7.7 秒——
/// 多出来的线程落到能效核上，拖慢整批。其他机器取一半核数，2–8 之间。
fn threads() -> i32 {
    static THREADS: std::sync::OnceLock<i32> = std::sync::OnceLock::new();
    *THREADS.get_or_init(|| {
        if let Some(n) = std::env::var("CP_ASR_THREADS").ok().and_then(|v| v.parse().ok()) {
            return n;
        }
        #[cfg(target_os = "macos")]
        if let Some(n) = performance_cores() {
            return n.clamp(2, 8);
        }
        std::thread::available_parallelism()
            .map(|n| (n.get() / 2).clamp(2, 8))
            .unwrap_or(4) as i32
    })
}

#[cfg(target_os = "macos")]
fn performance_cores() -> Option<i32> {
    let out = std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "hw.perflevel0.physicalcpu"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// 一段一段识别，不批量：批量解码要把一批里的段补齐到最长那段，实测 SenseVoice 一批 4 段比
/// 逐段慢近一倍；Qwen3-ASR 批量还要多吃几 GB 内存。
fn batch_size(_kind: SherpaKind) -> usize {
    std::env::var("CP_ASR_BATCH").ok().and_then(|v| v.parse().ok()).unwrap_or(1)
}

pub struct SherpaJob {
    pub audio: PathBuf,
    pub model: &'static SherpaModel,
    pub model_dir: PathBuf,
    pub vad: PathBuf,
    /// 设置里的识别语言（zh / en / auto…）。
    pub language: Option<String>,
}

/// 丢弃时置位：异步那边被取消，识别线程就在下一段之前停下。
struct StopOnDrop(Arc<AtomicBool>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

pub async fn transcribe(job: SherpaJob, progress: super::ai::Progress<'_>) -> AppResult<WhisperJson> {
    let stop = Arc::new(AtomicBool::new(false));
    let _guard = StopOnDrop(stop.clone());
    let done = Arc::new(AtomicU64::new(0f64.to_bits()));
    let language = job.language.clone();
    let handle = {
        let stop = stop.clone();
        let done = done.clone();
        tokio::task::spawn_blocking(move || transcribe_blocking(&job, &done, &stop))
    };
    tokio::pin!(handle);
    let mut json = loop {
        tokio::select! {
            result = &mut handle => {
                break result.map_err(|error| AppError::Pipeline(format!("本地识别线程异常退出：{error}")))??;
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {
                if let Some(report) = progress {
                    report(f64::from_bits(done.load(Ordering::Relaxed)), "");
                }
            }
        }
    };
    super::asr::simplify_mandarin(&mut json, language.as_deref(), None);
    // VAD 已经把静音挡在外面，这里只剩文本规则（循环、复读、片尾套话）——Qwen3-ASR 是生成式的，也会复读。
    let report = super::whisper_cleanup::clean(&mut json, &[]);
    if report.changed() {
        tracing::info!(?report, "清理了本地识别的复读 / 套话");
    }
    Ok(json)
}

fn transcribe_blocking(job: &SherpaJob, done: &AtomicU64, stop: &AtomicBool) -> AppResult<WhisperJson> {
    let samples = load_16k_mono(&job.audio, stop)?;
    let samples = samples.as_slice();
    let started = std::time::Instant::now();
    let segments = speech_segments(&job.vad, samples, stop)?;
    let vad_s = started.elapsed().as_secs_f64();

    let recognizer = OfflineRecognizer::create(&recognizer_config(job))
        .ok_or_else(|| AppError::Pipeline(format!("加载 {} 失败，模型文件可能不完整，重新下载试试", job.model.display_name)))?;

    let load_s = started.elapsed().as_secs_f64() - vad_s;
    let mut out = Vec::new();
    let batch = batch_size(job.model.kind);
    let mut finished = 0;
    for chunk in segments.chunks(batch) {
        if stop.load(Ordering::SeqCst) {
            return Err(AppError::Pipeline("已取消".into()));
        }
        let streams: Vec<_> = chunk
            .iter()
            .map(|&(start, end)| {
                let stream = recognizer.create_stream();
                stream.accept_waveform(SAMPLE_RATE, &to_f32(&samples[start..end]));
                stream
            })
            .collect();
        recognizer.decode_multiple_streams(&streams.iter().collect::<Vec<_>>());
        for (stream, &(start, end)) in streams.iter().zip(chunk) {
            if let Some(result) = stream.get_result() {
                let start_ms = start as i64 * 1000 / SAMPLE_RATE as i64;
                let end_ms = end as i64 * 1000 / SAMPLE_RATE as i64;
                out.extend(to_segments(&result.text, &result.tokens, result.timestamps.as_deref(), start_ms, end_ms));
            }
        }
        finished += chunk.len();
        done.store((finished as f64 / segments.len() as f64).to_bits(), Ordering::Relaxed);
    }
    let audio_s = samples.len() as f64 / SAMPLE_RATE as f64;
    let total_s = started.elapsed().as_secs_f64();
    tracing::info!(
        model = job.model.id,
        segments = segments.len(),
        audio_s,
        vad_s,
        load_s,
        decode_s = total_s - vad_s - load_s,
        rtf = total_s / audio_s.max(1.0),
        "本地识别完成"
    );
    Ok(WhisperJson { transcription: out })
}

fn to_f32(samples: &[i16]) -> Vec<f32> {
    samples.iter().map(|&s| s as f32 / 32768.0).collect()
}

/// 读 WAV，混成单声道、重采样到 16kHz，存成 i16（一小时的课 115MB，存 f32 要翻倍——手机上要省着用）。
/// 边读边转，不把原始文件整个读进内存：手机导出的 48kHz 立体声一小时就是 660MB。
fn load_16k_mono(path: &Path, stop: &AtomicBool) -> AppResult<Vec<i16>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)
        .map_err(|error| AppError::Pipeline(format!("读不了音频 {}：{error}", path.display())))?;
    let file_len = file.metadata()?.len();
    let mut head = vec![0u8; 64 * 1024];
    let read = file.read(&mut head)?;
    head.truncate(read);
    let format = local_asr::parse_wav_header(&head, file_len).ok_or_else(|| {
        AppError::Pipeline("本地识别只认 16 位或 32 位浮点的 PCM WAV，这份音频读不了".into())
    })?;
    let resampler = (format.sample_rate != SAMPLE_RATE as u32)
        .then(|| LinearResampler::create(format.sample_rate as i32, SAMPLE_RATE))
        .flatten();
    if format.sample_rate != SAMPLE_RATE as u32 && resampler.is_none() {
        return Err(AppError::Pipeline(format!("没法把 {} Hz 的音频重采样到 16kHz", format.sample_rate)));
    }
    file.seek(SeekFrom::Start(format.data_offset))?;
    let mut reader = std::io::BufReader::new(file).take(format.data_len);
    let estimate = format.data_len / format.block_align() as u64 * SAMPLE_RATE as u64 / format.sample_rate as u64;
    let mut out: Vec<i16> = Vec::with_capacity(estimate as usize + SAMPLE_RATE as usize);
    let mut push = |samples: &[f32]| {
        out.extend(samples.iter().map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16));
    };
    // 一次读一秒左右，按整帧切。
    let block = format.block_align() * format.sample_rate as usize;
    let mut buf = vec![0u8; block];
    let mut carry: Vec<u8> = Vec::new();
    loop {
        if stop.load(Ordering::SeqCst) {
            return Err(AppError::Pipeline("已取消".into()));
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        carry.extend_from_slice(&buf[..n]);
        let whole = carry.len() / format.block_align() * format.block_align();
        let mono = local_asr::frames_to_mono(&carry[..whole], &format);
        carry.drain(..whole);
        match &resampler {
            Some(r) => push(&r.resample(&mono, false)),
            None => push(&mono),
        }
    }
    if let Some(r) = &resampler {
        push(&r.resample(&[], true));
    }
    Ok(out)
}

/// silero VAD 切出语音段，返回采样点区间。
fn speech_segments(vad_model: &Path, samples: &[i16], stop: &AtomicBool) -> AppResult<Vec<(usize, usize)>> {
    let config = VadModelConfig {
        silero_vad: SileroVadModelConfig {
            model: Some(vad_model.to_string_lossy().into_owned()),
            threshold: 0.5,
            min_silence_duration: 0.3,
            min_speech_duration: 0.25,
            window_size: VAD_WINDOW as i32,
            max_speech_duration: MAX_SPEECH_SECONDS,
        },
        sample_rate: SAMPLE_RATE,
        num_threads: 1,
        provider: Some("cpu".into()),
        ..Default::default()
    };
    let vad = VoiceActivityDetector::create(&config, 60.0)
        .ok_or_else(|| AppError::Pipeline("加载 VAD 失败，重新下载模型试试".into()))?;
    let mut segments = Vec::new();
    let drain = |vad: &VoiceActivityDetector, segments: &mut Vec<(usize, usize)>| {
        while let Some(segment) = vad.front() {
            let start = segment.start().max(0) as usize;
            let end = (start + segment.n().max(0) as usize).min(samples.len());
            if end > start {
                segments.push((start, end));
            }
            vad.pop();
        }
    };
    for (i, window) in samples.chunks(VAD_WINDOW).enumerate() {
        // 一小时的课 11 万个窗口，每一千个看一次取消就够了。
        if i % 1000 == 0 && stop.load(Ordering::SeqCst) {
            return Err(AppError::Pipeline("已取消".into()));
        }
        vad.accept_waveform(&to_f32(window));
        drain(&vad, &mut segments);
    }
    vad.flush();
    drain(&vad, &mut segments);
    Ok(segments)
}

fn recognizer_config(job: &SherpaJob) -> OfflineRecognizerConfig {
    let dir = &job.model_dir;
    let path = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.num_threads = threads();
    config.model_config.provider = Some("cpu".into());
    match job.model.kind {
        SherpaKind::SenseVoice => {
            config.model_config.tokens = path("tokens.txt");
            config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
                model: path("model.int8.onnx"),
                // SenseVoice 认 zh / en / ja / ko / yue / auto；别的语言在选模型时就已经挡掉了。
                language: Some(job.language.clone().unwrap_or_else(|| "auto".into())),
                // 开 ITN 才出标点和阿拉伯数字。
                use_itn: true,
            };
        }
        SherpaKind::Qwen3Asr => {
            config.feat_config.feature_dim = 128;
            config.model_config.qwen3_asr = qwen3_config(dir);
        }
    }
    config
}

/// 默认的 max_total_len=512 / max_new_tokens=128 会把 20 秒以上的段悄悄截掉（sherpa-onnx #4034），放宽。
fn qwen3_config(dir: &Path) -> OfflineQwen3ASRModelConfig {
    let path = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
    OfflineQwen3ASRModelConfig {
        conv_frontend: path("conv_frontend.onnx"),
        encoder: path("encoder.int8.onnx"),
        decoder: path("decoder.int8.onnx"),
        tokenizer: path("tokenizer"),
        max_total_len: 2048,
        max_new_tokens: 512,
        ..Default::default()
    }
}

/// 一段识别结果 → 一句一行的文稿段。
fn to_segments(
    raw: &str,
    tokens: &[String],
    timestamps: Option<&[f32]>,
    start_ms: i64,
    end_ms: i64,
) -> Vec<WhisperSegment> {
    let text = local_asr::strip_tags(raw);
    if text.is_empty() {
        return Vec::new();
    }
    let chars: Vec<char> = text.chars().collect();
    let token_times = timestamps.and_then(|times| local_asr::token_char_times(&text, tokens, times));
    let at = |idx: usize| local_asr::char_time_ms(idx, chars.len(), start_ms, end_ms, token_times.as_deref());
    let sentences = local_asr::split_sentences(&text);
    let count = sentences.len();
    sentences
        .into_iter()
        .enumerate()
        .map(|(i, (a, b))| WhisperSegment {
            text: chars[a..b].iter().collect::<String>().trim().to_string(),
            offsets: Offsets {
                from: if i == 0 { start_ms } else { at(a) },
                to: if i + 1 == count { end_ms } else { at(b).max(at(a)) },
            },
            tokens: Vec::new(),
        })
        .filter(|segment| !segment.text.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_vad_segment_becomes_sentence_lines_spanning_the_segment() {
        let segments = to_segments(
            "<|zh|><|withitn|>大家好，我是张老师。今天讲梯度下降。",
            &[],
            None,
            10_000,
            16_000,
        );
        let texts: Vec<&str> = segments.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, ["大家好，我是张老师。", "今天讲梯度下降。"]);
        assert_eq!(segments[0].offsets.from, 10_000);
        assert_eq!(segments[1].offsets.to, 16_000);
        // 按字数分：第二句从第 10 个字开始，大约在 10s + 6s×10/18。
        assert_eq!(segments[0].offsets.to, segments[1].offsets.from);
        assert_eq!(segments[1].offsets.from, 10_000 + 6_000 * 10 / 18);
    }

    #[test]
    fn empty_results_produce_no_lines() {
        assert!(to_segments("<|zh|><|nospeech|>", &[], None, 0, 1_000).is_empty());
    }

    fn write_wav(path: &Path, channels: u16, rate: u32, frames: usize, value: impl Fn(usize) -> i16) {
        let mut data = Vec::with_capacity(frames * channels as usize * 2);
        for i in 0..frames {
            for _ in 0..channels {
                data.extend_from_slice(&value(i).to_le_bytes());
            }
        }
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
        out.extend_from_slice(&(channels * 2).to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&data);
        std::fs::write(path, out).unwrap();
    }

    #[test]
    fn phone_style_48k_stereo_comes_out_as_16k_mono_of_the_same_length() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        // 3 秒 440Hz 正弦，48kHz 立体声（手机原生桥导出的样子）。
        write_wav(&path, 2, 48_000, 144_000, |i| {
            ((i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 16_000.0) as i16
        });
        let samples = load_16k_mono(&path, &AtomicBool::new(false)).unwrap();
        assert!((samples.len() as i64 - 48_000).abs() < 400, "{}", samples.len());
        let peak = samples.iter().map(|s| s.unsigned_abs()).max().unwrap();
        assert!((14_000..18_000).contains(&peak), "峰值保住，没被混音或重采样削掉：{peak}");
    }

    #[test]
    fn desktop_16k_mono_is_read_as_is() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        write_wav(&path, 1, 16_000, 1_000, |i| i as i16);
        let samples = load_16k_mono(&path, &AtomicBool::new(false)).unwrap();
        assert_eq!(samples.len(), 1_000);
        assert_eq!(samples[999], 998); // 只有 i16 → f32 → i16 的舍入
    }

    #[test]
    fn thread_count_stays_in_range() {
        assert!((2..=8).contains(&threads()));
    }

    /// 真跑一遍：本机装了 SenseVoice 才跑（`<app_data>/asr/`），用 macOS 的 say 合成两句中文中间夹 8 秒静音。
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn transcribes_speech_and_skips_the_silence_with_a_local_model() {
        let app_data = dirs_app_data();
        let Some(app_data) = app_data.filter(|dir| local_asr::is_installed(dir, &local_asr::SENSE_VOICE)) else {
            eprintln!("skip: SenseVoice 没装");
            return;
        };
        let work = tempfile::tempdir().unwrap();
        let wav = work.path().join("audio.wav");
        let a = work.path().join("a.aiff");
        let b = work.path().join("b.aiff");
        for (out, text) in [(&a, "我们来看梯度下降，学习率决定每一步走多远。"), (&b, "好，板书写完了，我们接着往下推导。")] {
            assert!(std::process::Command::new("say").args(["-v", "Tingting", "-o"]).arg(out).arg(text).status().unwrap().success());
        }
        let ffmpeg = crate::sidecar::resolve(&crate::sidecar::FFMPEG, None).unwrap();
        let status = std::process::Command::new(ffmpeg)
            .args(["-v", "error", "-y", "-i"]).arg(&a)
            .args(["-f", "lavfi", "-t", "8", "-i", "anullsrc=r=16000:cl=mono", "-i"]).arg(&b)
            .args(["-filter_complex", "[0:a]aresample=16000,aformat=channel_layouts=mono[x];[2:a]aresample=16000,aformat=channel_layouts=mono[y];[x][1:a][y]concat=n=3:v=0:a=1", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"])
            .arg(&wav)
            .status()
            .unwrap();
        assert!(status.success());

        // 手机导出的是原采样率立体声：再转一份 48kHz 立体声，两种输入都要认得。
        let stereo = work.path().join("stereo.wav");
        let ffmpeg = crate::sidecar::resolve(&crate::sidecar::FFMPEG, None).unwrap();
        assert!(std::process::Command::new(&ffmpeg)
            .args(["-v", "error", "-y", "-i"]).arg(&wav)
            .args(["-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le"]).arg(&stereo)
            .status().unwrap().success());
        let stereo_job = SherpaJob {
            audio: stereo,
            model: &local_asr::SENSE_VOICE,
            model_dir: local_asr::model_dir(&app_data, &local_asr::SENSE_VOICE),
            vad: local_asr::vad_path(&app_data),
            language: Some("zh".into()),
        };
        let stereo_text: String = transcribe(stereo_job, None).await.unwrap().transcription.iter().map(|s| s.text.clone()).collect();
        assert!(stereo_text.contains("梯度下降"), "{stereo_text}");

        let job = SherpaJob {
            audio: wav.clone(),
            model: &local_asr::SENSE_VOICE,
            model_dir: local_asr::model_dir(&app_data, &local_asr::SENSE_VOICE),
            vad: local_asr::vad_path(&app_data),
            language: Some("zh".into()),
        };
        let json = transcribe(job, None).await.unwrap();
        let text: String = json.transcription.iter().map(|s| s.text.as_str()).collect();
        assert!(text.contains("梯度下降"), "{text}");
        // 「推导 / 推倒」这类同音词合成语音里分不出来，只认没有歧义的词。
        assert!(text.contains("板书"), "{text}");
        // 第二句在 8 秒静音之后才开始。
        let last = json.transcription.last().unwrap();
        assert!(last.offsets.from >= 8_000, "{:?}", last.offsets);
    }

    /// 手动跑：`SHERPA_E2E_WAV=<16k wav> SHERPA_E2E_OUT=<json> cargo test --lib real_lecture -- --ignored`，
    /// 用 docs/asr-benchmark 的样本核对接进应用之后的效果和基准测试一致。
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore]
    async fn real_lecture_through_the_app_path() {
        let _ = tracing_subscriber::fmt().with_test_writer().try_init();
        let wav = PathBuf::from(std::env::var("SHERPA_E2E_WAV").expect("SHERPA_E2E_WAV"));
        let model = local_asr::find(&std::env::var("SHERPA_E2E_MODEL").unwrap_or_else(|_| "sensevoice".into())).unwrap();
        let app_data = dirs_app_data().unwrap();
        let job = SherpaJob {
            audio: wav,
            model,
            model_dir: local_asr::model_dir(&app_data, model),
            vad: local_asr::vad_path(&app_data),
            language: Some("zh".into()),
        };
        let started = std::time::Instant::now();
        let json = transcribe(job, None).await.unwrap();
        eprintln!("{} 行，用时 {:.1}s", json.transcription.len(), started.elapsed().as_secs_f64());
        if let Ok(out) = std::env::var("SHERPA_E2E_OUT") {
            std::fs::write(out, serde_json::to_string(&json).unwrap()).unwrap();
        }
    }

    #[cfg(target_os = "macos")]
    fn dirs_app_data() -> Option<PathBuf> {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Application Support/dev.courseai.app"))
    }
}
