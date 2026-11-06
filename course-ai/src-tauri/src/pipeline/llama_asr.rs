//! 桌面上的 Qwen3-ASR：模型是官方 GGUF（ggml-org/Qwen3-ASR-0.6B-GGUF），由 llama.cpp 的
//! llama-server 跑，能用 GPU——Windows 走 Vulkan（N 卡、A 卡、Intel 核显都行，不用装 CUDA），
//! Apple 芯片走 Metal；没有可用的显卡就自动用 CPU。
//!
//! 为什么不沿用 sherpa-onnx：它的 int8 量化模型交给 GPU 执行器反而更慢（量化算子 GPU 不支持，
//! 来回搬数据；Mac 上 CoreML 实测慢 6 倍），Windows 上官方也只有 N 卡专用、要自己装 CUDA 的版本。
//! 同一段 5 分钟讲课（M4）：sherpa CPU 58 秒；这里 GPU（Metal）12.6 秒，纯 CPU 也只要 22.5 秒。
//!
//! 流程和 sherpa 那条一样：silero VAD 切成 ≤ 20 秒的语音段（长静音不送进模型）→ 逐段识别 →
//! 按标点切句、按字数在段内分配时间。只是「逐段识别」换成把每段 WAV 发给本机起的 llama-server。
//! 服务进程随这次识别起、随这次识别停（丢弃即杀掉），不常驻。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use futures_util::{stream, StreamExt};

use super::asr::{WhisperJson, WhisperSegment};
use super::sherpa_asr;
use crate::error::{AppError, AppResult};

/// GGUF 主模型和音频编码器（mmproj）的文件名，装在模型目录里。
pub const MODEL_FILE: &str = "Qwen3-ASR-0.6B-Q8_0.gguf";
pub const MMPROJ_FILE: &str = "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf";

/// 同时识别几段，llama-server 开同样多的槽位。VAD 按停顿切，5 分钟的课切出九十来段，每段请求
/// 都有固定开销，多开几路能把它摊掉。M4 上 5 分钟讲课：GPU 2 路 14.0 秒、4 路 12.6 秒；
/// CPU 2 路 24.3 秒、4 路 22.5 秒。0.6B 模型每路只多占几十 MB。
const PARALLEL: usize = 4;
/// 每个槽位的上下文。一段 ≤ 20 秒的语音编码出来只有几百个 token，加上文字输出也远不到 2048。
/// 不限的话 llama-server 按模型上限（6.5 万）给每个槽位开 KV 缓存，显存吃满、速度慢一倍多。
const CTX_PER_SLOT: usize = 2048;
/// 模型加载（大模型首次读盘、GPU 编着色器）最多等这么久。
const STARTUP_TIMEOUT: Duration = Duration::from_secs(180);
/// 单段识别最多等这么久。20 秒语音在纯 CPU 的老机器上也就几秒到十几秒。
const SEGMENT_TIMEOUT: Duration = Duration::from_secs(180);

pub struct LlamaJob {
    pub audio: PathBuf,
    pub model_dir: PathBuf,
    pub vad: PathBuf,
    /// 设置里的识别语言（zh / en / auto…），只用来决定要不要转简体。模型自己认语言。
    pub language: Option<String>,
    /// 热词（逗号分隔）。按 Qwen3-ASR 的用法放进系统提示当上下文。
    pub hotwords: Option<String>,
    /// 用不用 GPU（设置里的开关）。
    pub use_gpu: bool,
}

/// 这次识别实际跑在哪：「GPU：NVIDIA GeForce RTX 3060」或「CPU」。显示在进度里。
pub fn device_label(device: Option<&str>) -> String {
    match device {
        Some(name) => format!("GPU：{name}"),
        None => "CPU".into(),
    }
}

pub async fn transcribe(
    job: LlamaJob,
    progress: &(dyn Fn(f64, &str) + Send + Sync),
) -> AppResult<WhisperJson> {
    // 读音频、VAD 切段是阻塞的 CPU 活；取消（丢弃 future）时让它在下一个检查点停下。
    let stop = Arc::new(AtomicBool::new(false));
    let _guard = sherpa_asr::StopOnDrop(stop.clone());
    let (samples, segments) = {
        let (audio, vad, stop) = (job.audio.clone(), job.vad.clone(), stop.clone());
        tokio::task::spawn_blocking(move || -> AppResult<_> {
            let samples = sherpa_asr::load_16k_mono(&audio, &stop)?;
            let segments = sherpa_asr::speech_segments(&vad, &samples, &stop)?;
            Ok((samples, segments))
        })
        .await
        .map_err(|e| AppError::Pipeline(format!("本地识别线程异常退出：{e}")))??
    };
    if segments.is_empty() {
        return Ok(WhisperJson { transcription: Vec::new() });
    }

    let model = job.model_dir.join(MODEL_FILE);
    let mmproj = job.model_dir.join(MMPROJ_FILE);
    // GPU 起不来（驱动太旧、显存不够、Vulkan 运行库坏了）就换 CPU 再起一次，不让整次识别失败。
    let server = match LlamaServer::start(&model, &mmproj, job.use_gpu).await {
        Ok(server) => server,
        Err(error) if job.use_gpu => {
            tracing::warn!(%error, "llama-server 用 GPU 起不来，改用 CPU");
            LlamaServer::start(&model, &mmproj, false).await?
        }
        Err(error) => return Err(error),
    };
    let device = device_label(server.device().as_deref());
    tracing::info!(%device, segments = segments.len(), "Qwen3-ASR（llama.cpp）开始识别");
    progress(0.0, &device);

    let started = std::time::Instant::now();
    let finished = AtomicUsize::new(0);
    let detected: Mutex<Option<String>> = Mutex::new(None);
    let client = reqwest::Client::builder()
        .timeout(SEGMENT_TIMEOUT)
        .no_proxy()
        .build()
        .map_err(|e| AppError::Other(e.to_string()))?;
    let results: Vec<AppResult<Vec<WhisperSegment>>> = stream::iter(segments.iter().copied())
        .map(|(start, end)| {
            let (client, server, samples) = (&client, &server, &samples);
            let (finished, detected, total, device) = (&finished, &detected, segments.len(), &device);
            let hotwords = job.hotwords.as_deref();
            async move {
                let wav = wav_bytes(&samples[start..end]);
                let raw = server.transcribe(client, &wav, hotwords).await?;
                let (language, text) = split_language_prefix(&raw);
                if let Some(language) = language {
                    detected.lock().unwrap().get_or_insert(language);
                }
                let start_ms = start as i64 * 1000 / SAMPLE_RATE;
                let end_ms = end as i64 * 1000 / SAMPLE_RATE;
                let count = finished.fetch_add(1, Ordering::SeqCst) + 1;
                progress(count as f64 / total as f64, device);
                Ok(sherpa_asr::to_segments(text, &[], None, start_ms, end_ms))
            }
        })
        .buffered(PARALLEL)
        .collect()
        .await;
    let mut out = Vec::new();
    for result in results {
        out.extend(result?);
    }
    let audio_s = samples.len() as f64 / SAMPLE_RATE as f64;
    tracing::info!(
        %device,
        segments = segments.len(),
        audio_s,
        decode_s = started.elapsed().as_secs_f64(),
        "Qwen3-ASR（llama.cpp）识别完成"
    );
    drop(server);

    let mut json = WhisperJson { transcription: out };
    let detected = detected.into_inner().unwrap();
    super::asr::simplify_mandarin(&mut json, job.language.as_deref(), detected.as_deref());
    let report = super::whisper_cleanup::clean(&mut json, &[]);
    if report.changed() {
        tracing::info!(?report, "清理了本地识别的复读 / 套话");
    }
    Ok(json)
}

const SAMPLE_RATE: i64 = 16_000;

/// 16kHz 单声道 16 位 PCM 的 WAV 文件内容。
fn wav_bytes(samples: &[i16]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // 单声道
    out.extend_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE as u32 * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

/// Qwen3-ASR 的输出以 `language Chinese<asr_text>` 开头，后面才是正文。拆出语言（换成语言代码）和正文。
fn split_language_prefix(raw: &str) -> (Option<String>, &str) {
    let raw = raw.trim();
    let Some((head, text)) = raw.split_once("<asr_text>") else {
        return (None, raw);
    };
    let language = head
        .trim()
        .strip_prefix("language")
        .map(str::trim)
        .and_then(language_code);
    (language, text.trim())
}

fn language_code(name: &str) -> Option<String> {
    let code = match name.to_ascii_lowercase().as_str() {
        "chinese" | "mandarin" => "zh",
        "cantonese" => "yue",
        "english" => "en",
        "japanese" => "ja",
        "korean" => "ko",
        "french" => "fr",
        "german" => "de",
        "spanish" => "es",
        "russian" => "ru",
        "none" | "" => return None,
        other => return Some(other.to_string()),
    };
    Some(code.to_string())
}

/// 这次识别专用的 llama-server 进程。丢弃即杀掉。
struct LlamaServer {
    child: tokio::process::Child,
    base: String,
    /// stderr 的最后几十行：起不来时拼进报错；也从里面认出用的是哪块显卡。
    log: Arc<Mutex<Vec<String>>>,
}

impl LlamaServer {
    async fn start(model: &Path, mmproj: &Path, use_gpu: bool) -> AppResult<Self> {
        for file in [model, mmproj] {
            if !file.is_file() {
                return Err(AppError::Config(format!(
                    "Qwen3-ASR 模型文件不全（缺 {}），在 设置 → 语音识别 重新下载",
                    file.file_name().unwrap_or_default().to_string_lossy()
                )));
            }
        }
        let binary = crate::sidecar::resolve(&crate::sidecar::LLAMA_SERVER, None)?;
        let port = free_port()?;
        let mut command = crate::sidecar::command(&binary);
        command
            .arg("-m")
            .arg(model)
            .arg("--mmproj")
            .arg(mmproj)
            .args(["--host", "127.0.0.1", "--port", &port.to_string()])
            .args(["-np", &PARALLEL.to_string()])
            .args(["-c", &(CTX_PER_SLOT * PARALLEL).to_string()])
            .args(["-t", &threads().to_string()])
            // 日志级别 4 才会打出「using device MTL0 (Apple M4)」，用来告诉用户 GPU 有没有用上。
            .args(["-lv", "4"])
            .arg("--no-webui");
        if use_gpu {
            command.args(["-ngl", "999"]);
        } else {
            command.args(["-ngl", "0", "--no-mmproj-offload", "--device", "none"]);
        }
        let mut child = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| AppError::Pipeline(format!("启动识别引擎失败：{e}")))?;
        let log = Arc::new(Mutex::new(Vec::new()));
        if let Some(stderr) = child.stderr.take() {
            let log = log.clone();
            tokio::spawn(async move {
                use tokio::io::AsyncBufReadExt;
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut log = log.lock().unwrap();
                    log.push(line);
                    let excess = log.len().saturating_sub(200);
                    log.drain(..excess);
                }
            });
        }
        let mut server = LlamaServer {
            child,
            base: format!("http://127.0.0.1:{port}"),
            log,
        };
        server.wait_ready().await?;
        Ok(server)
    }

    async fn wait_ready(&mut self) -> AppResult<()> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .no_proxy()
            .build()
            .map_err(|e| AppError::Other(e.to_string()))?;
        let deadline = tokio::time::Instant::now() + STARTUP_TIMEOUT;
        loop {
            if let Ok(response) = http.get(format!("{}/health", self.base)).send().await {
                if response.status().is_success() {
                    return Ok(());
                }
            }
            // 进程已经退出（缺 DLL、模型读不了、显卡初始化失败）就别干等到超时。
            let exited = matches!(self.child.try_wait(), Ok(Some(_)));
            if exited || tokio::time::Instant::now() >= deadline {
                return Err(AppError::Pipeline(format!(
                    "识别引擎没能启动：{}",
                    self.log_tail(8)
                )));
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    fn log_tail(&self, lines: usize) -> String {
        let log = self.log.lock().unwrap();
        let start = log.len().saturating_sub(lines);
        log[start..].join(" | ")
    }

    /// 用的是哪块显卡；全在 CPU 上就是 None。
    fn device(&self) -> Option<String> {
        gpu_device_from_log(&self.log.lock().unwrap())
    }

    async fn transcribe(
        &self,
        client: &reqwest::Client,
        wav: &[u8],
        hotwords: Option<&str>,
    ) -> AppResult<String> {
        let audio = serde_json::json!({
            "type": "input_audio",
            "input_audio": {
                "data": base64::engine::general_purpose::STANDARD.encode(wav),
                "format": "wav",
            },
        });
        let mut messages = Vec::new();
        if let Some(context) = hotwords.map(str::trim).filter(|h| !h.is_empty()) {
            messages.push(serde_json::json!({"role": "system", "content": context}));
        }
        messages.push(serde_json::json!({"role": "user", "content": [audio]}));
        let body = serde_json::json!({
            "messages": messages,
            "temperature": 0,
            "max_tokens": 1024,
        });
        let response = client
            .post(format!("{}/v1/chat/completions", self.base))
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Pipeline(format!("识别引擎没有响应：{e}")))?;
        let status = response.status();
        let value: serde_json::Value = response
            .json()
            .await
            .map_err(|e| AppError::Pipeline(format!("识别引擎返回的内容读不了：{e}")))?;
        if !status.is_success() {
            return Err(AppError::Pipeline(format!("识别引擎出错（{status}）：{value}")));
        }
        Ok(value["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .to_string())
    }
}

/// llama.cpp 加载模型时打 `using device Vulkan0 (NVIDIA GeForce RTX 3060) - 11264 MiB free` 这样的行；
/// 没有这一行（或只用了 CPU）就是没用上显卡。
fn gpu_device_from_log(lines: &[String]) -> Option<String> {
    lines.iter().find_map(|line| {
        let rest = line.split_once("using device ")?.1;
        let (id, rest) = rest.split_once(" (")?;
        if id.to_ascii_lowercase().starts_with("cpu") {
            return None;
        }
        let name = rest.split_once(')')?.0.trim();
        (!name.is_empty()).then(|| name.to_string())
    })
}

/// 本机随便找一个空闲端口。
fn free_port() -> AppResult<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// CPU 线程数：用一半核数（2–8），给界面和别的处理留余地。GPU 模式下主要活在显卡上，影响不大。
fn threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| (n.get() / 2).clamp(2, 8))
        .unwrap_or(4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_language_prefix_is_split_off_the_transcript() {
        assert_eq!(
            split_language_prefix("language Chinese<asr_text>去找啊！这个时候"),
            (Some("zh".to_string()), "去找啊！这个时候")
        );
        assert_eq!(
            split_language_prefix(" language English<asr_text> Hello world "),
            (Some("en".to_string()), "Hello world")
        );
        // 没检测到语言（静音段）时是 language None。
        assert_eq!(split_language_prefix("language None<asr_text>"), (None, ""));
        // 没有前缀就原样当正文。
        assert_eq!(split_language_prefix("纯文本"), (None, "纯文本"));
    }

    #[test]
    fn the_gpu_in_use_is_read_from_the_server_log() {
        let log = |lines: &[&str]| lines.iter().map(|l| l.to_string()).collect::<Vec<_>>();
        assert_eq!(
            gpu_device_from_log(&log(&[
                "build: 12167",
                "llama_model_load_from_file_impl: using device Vulkan0 (NVIDIA GeForce RTX 3060) - 11264 MiB free",
            ])),
            Some("NVIDIA GeForce RTX 3060".into())
        );
        assert_eq!(
            gpu_device_from_log(&log(&["load: using device MTL0 (Apple M4) - 21845 MiB free"])),
            Some("Apple M4".into())
        );
        assert_eq!(gpu_device_from_log(&log(&["main: loading model", "using device CPU (Intel)"])), None);
        assert_eq!(device_label(None), "CPU");
        assert_eq!(device_label(Some("Apple M4")), "GPU：Apple M4");
    }

    #[test]
    fn wav_bytes_is_a_valid_16k_mono_pcm_file() {
        let wav = wav_bytes(&[0, 1000, -1000]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 6);
        assert_eq!(wav.len(), 44 + 6);
    }

    /// 手动跑：`LLAMA_E2E_WAV=<16k wav> [LLAMA_E2E_CPU=1] LLAMA_E2E_OUT=<txt> cargo test --release --lib
    /// llama_asr::tests::real_lecture -- --ignored --nocapture`，PATH 里要有 llama-server，
    /// 模型装在 `~/Library/Application Support/dev.courseai.app/asr/` 下。
    #[tokio::test]
    #[ignore]
    async fn real_lecture() {
        let wav = PathBuf::from(std::env::var("LLAMA_E2E_WAV").expect("LLAMA_E2E_WAV"));
        let app = PathBuf::from(std::env::var("HOME").unwrap())
            .join("Library/Application Support/dev.courseai.app");
        let model = &crate::pipeline::local_asr::QWEN3_ASR_GGUF;
        let job = LlamaJob {
            audio: wav,
            model_dir: crate::pipeline::local_asr::model_dir(&app, model),
            vad: crate::pipeline::local_asr::vad_path(&app),
            language: Some("zh".into()),
            hotwords: None,
            use_gpu: std::env::var("LLAMA_E2E_CPU").is_err(),
        };
        let devices = Mutex::new(Vec::<String>::new());
        let started = std::time::Instant::now();
        let json = transcribe(job, &|_, device| {
            let mut seen = devices.lock().unwrap();
            if !seen.iter().any(|d| d == device) {
                seen.push(device.to_string());
            }
        })
        .await
        .unwrap();
        let text: String = json.transcription.iter().map(|s| s.text.as_str()).collect();
        println!(
            "{:.1}s, {} lines, {} chars, device {:?}",
            started.elapsed().as_secs_f64(),
            json.transcription.len(),
            text.chars().count(),
            devices.into_inner().unwrap()
        );
        for line in json.transcription.iter().take(3) {
            println!("{:?} {}", line.offsets, line.text);
        }
        if let Ok(out) = std::env::var("LLAMA_E2E_OUT") {
            std::fs::write(out, &text).unwrap();
        }
    }
}
