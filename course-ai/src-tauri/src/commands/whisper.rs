use crate::commands::courses::AppState;
use crate::error::{AppError, AppResult};
use crate::pipeline::{asr, local_asr};
use futures_util::StreamExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

const DOWNLOAD_USER_AGENT: &str = "CourseAI/0.1 (https://dev.courseai.app)";

#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    pub id: &'static str,
    pub display_name: &'static str,
    pub size_bytes: u64,
    pub url: &'static str,
    /// 这台设备此刻放得下它（手机上按可用内存判断；桌面上总是 true）。
    pub fits_memory: bool,
}

pub const MODELS: &[ModelInfo] = &[
    ModelInfo {
        id: "tiny",
        display_name: "Tiny (75MB)",
        size_bytes: 77_700_000,
        url: "https://modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-tiny.bin",
        fits_memory: true,
    },
    ModelInfo {
        id: "base",
        display_name: "Base (142MB)",
        size_bytes: 148_000_000,
        url: "https://modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-base.bin",
        fits_memory: true,
    },
    ModelInfo {
        id: "small",
        display_name: "Small (466MB)",
        size_bytes: 488_000_000,
        url: "https://modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-small.bin",
        fits_memory: true,
    },
    ModelInfo {
        id: "medium",
        display_name: "Medium (1.5GB)",
        size_bytes: 1_530_000_000,
        url: "https://modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-medium.bin",
        fits_memory: true,
    },
    ModelInfo {
        id: "large-v3-turbo",
        display_name: "Large v3 Turbo (q5_0, 574MB)",
        size_bytes: 574_000_000,
        // 上面那个仓库没有 turbo（这个地址一直是 404，选它的人下载必失败）。换成另一个
        // ModelScope 镜像：文件大小和首尾各 2MB 的哈希都与 HuggingFace 上 ggerganov 的原文件一致。
        url: "https://modelscope.cn/models/OllmOne/whisper.cpp/resolve/master/ggml-large-v3-turbo-q5_0.bin",
        fits_memory: true,
    },
];

fn is_mobile_os(os: &str) -> bool {
    os == "android" || os == "ios"
}

pub fn model_path(app_data: &Path, id: &str) -> PathBuf {
    let file_name = MODELS
        .iter()
        .find(|model| model.id == id)
        .and_then(|model| model.url.rsplit('/').next())
        .unwrap_or("ggml-unknown.bin");
    app_data.join("whisper").join(file_name)
}

pub fn is_model_available(path: &Path) -> bool {
    asr::is_probably_whisper_model(path)
}

#[tauri::command]
pub async fn cmd_list_whisper_models(app: tauri::AppHandle) -> AppResult<Vec<(ModelInfo, bool)>> {
    // 手机上没有 whisper-cli，只列 sherpa 模型。
    let mobile = is_mobile_os(std::env::consts::OS);
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Config(error.to_string()))?;
    let available_mb = local_asr::available_memory_mb();
    // SenseVoice / Qwen3-ASR 排前面：中文课上它们比 Whisper 准得多（docs/asr-benchmark）。
    let sherpa = local_asr::MODELS.iter().map(|model| {
        (
            ModelInfo {
                id: model.id,
                display_name: model.display_name,
                size_bytes: model.download_size(),
                url: model.files[0].urls[0],
                fits_memory: model.fits_memory(available_mb),
            },
            local_asr::is_installed(&data_dir, model),
        )
    });
    let whisper = MODELS.iter().filter(|_| !mobile).map(|model| {
        let path = model_path(&data_dir, model.id);
        (model.clone(), is_model_available(&path))
    });
    Ok(sherpa.chain(whisper).collect())
}

#[derive(Serialize, Clone)]
struct DownloadEvent {
    id: String,
    received: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

#[tauri::command]
pub async fn cmd_download_whisper_model(
    app: tauri::AppHandle,
    _state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Config(error.to_string()))?;
    if let Some(model) = local_asr::find(&id) {
        return download_sherpa_model(&app, &data_dir, model).await;
    }
    if is_mobile_os(std::env::consts::OS) {
        return Err(AppError::Config(
            "手机上没有 Whisper，本地识别请下载 SenseVoice 或 Qwen3-ASR".into(),
        ));
    }
    let info = MODELS
        .iter()
        .find(|model| model.id == id)
        .ok_or_else(|| AppError::NotFound(format!("model {id}")))?
        .clone();
    let path = model_path(&data_dir, info.id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let client = reqwest::Client::builder()
        .user_agent(DOWNLOAD_USER_AGENT)
        .build()
        .map_err(|error| AppError::Other(error.to_string()))?;
    let resp = client
        .get(info.url)
        .send()
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
        .error_for_status()
        .map_err(|error| AppError::Other(error.to_string()))?;
    let total = resp.content_length().unwrap_or(info.size_bytes);
    let mut stream = resp.bytes_stream();
    let tmp = path.with_extension("bin.part");
    let mut file = tokio::fs::File::create(&tmp).await?;
    let mut received = 0_u64;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|error| AppError::Other(error.to_string()))?;
        file.write_all(&bytes).await?;
        received += bytes.len() as u64;
        app.emit(
            "whisper:download",
            DownloadEvent {
                id: info.id.into(),
                received,
                total,
                done: false,
                error: None,
            },
        )
        .ok();
    }
    file.flush().await?;
    drop(file);
    asr::validate_whisper_model(&tmp)?;
    tokio::fs::rename(&tmp, &path).await?;
    app.emit(
        "whisper:download",
        DownloadEvent {
            id: info.id.into(),
            received,
            total,
            done: true,
            error: None,
        },
    )
    .ok();
    Ok(())
}

/// 下载一个 sherpa 模型缺的文件（含共用的 VAD）。
///
/// 一个文件一个文件来：每个文件依次试它的下载源，边下边算 SHA-256，和官方发布包里那份
/// 对上了才改名就位。所以中途断网、换了源都不会留下坏文件，已经下好的文件下次不再重下。
/// 进度按全部缺失文件的总字节数报，前端看到的是一根连续的进度条。
async fn download_sherpa_model(
    app: &tauri::AppHandle,
    data_dir: &Path,
    model: &'static local_asr::SherpaModel,
) -> AppResult<()> {
    let missing = local_asr::missing_files(data_dir, model);
    let total: u64 = missing.iter().map(|(_, file)| file.size).sum();
    let client = reqwest::Client::builder()
        .user_agent(DOWNLOAD_USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| AppError::Other(error.to_string()))?;
    let _keep_alive = crate::keep_alive::hold(
        crate::keep_alive::Kind::ModelDownload,
        model.id,
        model.display_name,
    );
    let emit = |received: u64, done: bool| {
        if total > 0 {
            crate::keep_alive::report(
                model.id,
                "download",
                received as f64 / total as f64,
                &format!("{:.0} / {:.0} MB", received as f64 / 1e6, total as f64 / 1e6),
            );
        }
        app.emit(
            "whisper:download",
            DownloadEvent {
                id: model.id.into(),
                received,
                total,
                done,
                error: None,
            },
        )
        .ok();
    };
    download_files(&client, model.display_name, missing, |received| emit(received, false)).await?;
    emit(total, true);
    Ok(())
}

/// 换着下载源试几轮。慢网上一个源下到一半断掉很常见：每次都从已经下好的地方接着下，
/// 所以多试几轮的代价很小。
const DOWNLOAD_ROUNDS: usize = 3;
/// 这么久一个字节都没收到就当连接卡死了，断开换下一个源（已下的部分留着续传）。
const STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// 依次下载这些文件。每个文件轮流试它的下载源，失败就换下一个、断点续传，最多 DOWNLOAD_ROUNDS 轮。
async fn download_files(
    client: &reqwest::Client,
    label: &str,
    files: Vec<(PathBuf, &'static local_asr::ModelFile)>,
    progress: impl Fn(u64),
) -> AppResult<()> {
    let mut finished = 0_u64;
    for (path, file) in files {
        let mut last_error = String::new();
        let mut ok = false;
        'rounds: for _ in 0..DOWNLOAD_ROUNDS {
            for url in file.urls {
                match fetch_verified(client, url, &path, file, |got| progress(finished + got)).await {
                    Ok(()) => {
                        ok = true;
                        break 'rounds;
                    }
                    Err(error) => {
                        tracing::warn!(%url, %error, "模型文件下载中断，换下一个源接着下");
                        last_error = error.to_string();
                    }
                }
            }
        }
        if !ok {
            return Err(AppError::Other(format!(
                "{label} 的 {} 所有下载源都失败了：{last_error}",
                file.path
            )));
        }
        finished += file.size;
        progress(finished);
    }
    Ok(())
}

fn part_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    path.with_file_name(name)
}

/// 从一个源把文件下到 `<path>.part`：已经有一截就用 Range 接着下（各个源的内容按哈希核对过是同一份，
/// 换源续传也没问题）。下满了核对大小和 SHA-256，对上才改名成 `path`；对不上说明这份是坏的，删掉重来。
/// 中途出错（断线、卡住）不删已下的部分，留给下一次续传。
async fn fetch_verified(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    file: &local_asr::ModelFile,
    progress: impl Fn(u64),
) -> AppResult<()> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncReadExt;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp = part_path(path);

    // 续传前把已下的部分喂进哈希。
    let mut hasher = Sha256::new();
    let mut have = 0_u64;
    if let Ok(mut existing) = tokio::fs::File::open(&tmp).await {
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = existing.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            have += n as u64;
        }
    }
    if have > file.size {
        tokio::fs::remove_file(&tmp).await?;
        hasher = Sha256::new();
        have = 0;
    }

    if have < file.size {
        let mut request = client.get(url);
        if have > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let resp = request
            .send()
            .await
            .map_err(|error| AppError::Other(error.to_string()))?
            .error_for_status()
            .map_err(|error| AppError::Other(error.to_string()))?;
        let mut out = if have > 0 && resp.status() == reqwest::StatusCode::PARTIAL_CONTENT {
            tokio::fs::OpenOptions::new().append(true).open(&tmp).await?
        } else {
            // 没要 Range，或者这个源不支持 Range、把整份又发了一遍：从头写。
            hasher = Sha256::new();
            have = 0;
            tokio::fs::File::create(&tmp).await?
        };
        progress(have);
        let mut stream = resp.bytes_stream();
        loop {
            let next = tokio::time::timeout(STALL_TIMEOUT, stream.next())
                .await
                .map_err(|_| AppError::Other(format!("{} 下载卡住超过 {} 秒", file.path, STALL_TIMEOUT.as_secs())))?;
            let Some(chunk) = next else { break };
            let bytes = chunk.map_err(|error| AppError::Other(error.to_string()))?;
            hasher.update(&bytes);
            out.write_all(&bytes).await?;
            have += bytes.len() as u64;
            if have > file.size {
                break;
            }
            progress(have);
        }
        out.flush().await?;
        drop(out);
        if have < file.size {
            return Err(AppError::Other(format!("{} 只下到 {have} / {} 字节，连接就断了", file.path, file.size)));
        }
    }

    let digest = format!("{:x}", hasher.finalize());
    if have != file.size || digest != file.sha256 {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(AppError::Other(format!(
            "{} 校验不通过（大小 {have}，期望 {}）",
            file.path, file.size
        )));
    }
    tokio::fs::rename(&tmp, path).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_registry_has_required_ids() {
        let ids: Vec<&str> = MODELS.iter().map(|model| model.id).collect();
        for required in ["tiny", "base", "small", "medium", "large-v3-turbo"] {
            assert!(ids.contains(&required), "missing {required}");
        }
    }

    #[test]
    fn model_path_uses_app_data() {
        let path = model_path(&PathBuf::from("/tmp/app"), "tiny");
        assert_eq!(path, PathBuf::from("/tmp/app/whisper/ggml-tiny.bin"));
    }

    #[test]
    fn turbo_model_path_keeps_quantized_file_name() {
        let path = model_path(&PathBuf::from("/tmp/app"), "large-v3-turbo");
        assert_eq!(
            path,
            PathBuf::from("/tmp/app/whisper/ggml-large-v3-turbo-q5_0.bin")
        );
    }

    /// 本地起一个 HTTP 服务回 `body`：路径 /404… 回 404；/half… 声称整份、只发一半就断开；
    /// 其余照 Range 头回 206（没有 Range 回 200）。收到的每个 Range 头记在返回的列表里。
    async fn serve(body: &'static [u8]) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let ranges = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = ranges.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let seen = seen.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..n]).to_string();
                    let from = request
                        .lines()
                        .find_map(|line| line.to_ascii_lowercase().strip_prefix("range: bytes=").map(str::to_owned))
                        .map(|range| {
                            seen.lock().unwrap().push(range.clone());
                            range.trim_end_matches('-').trim().parse::<usize>().unwrap()
                        });
                    let reply = if request.starts_with("GET /404") {
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
                    } else if request.starts_with("GET /half") {
                        let mut r = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
                        r.extend_from_slice(&body[..body.len() / 2]);
                        r
                    } else if let Some(from) = from {
                        let mut r = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {from}-{}/{}\r\nConnection: close\r\n\r\n",
                            body.len() - from,
                            body.len() - 1,
                            body.len()
                        )
                        .into_bytes();
                        r.extend_from_slice(&body[from..]);
                        r
                    } else {
                        let mut r = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
                        r.extend_from_slice(body);
                        r
                    };
                    let _ = socket.write_all(&reply).await;
                });
            }
        });
        (format!("http://{addr}"), ranges)
    }

    fn leak_file(path: &'static str, body: &[u8], urls: Vec<String>) -> &'static local_asr::ModelFile {
        use sha2::{Digest, Sha256};
        let urls: Vec<&'static str> = urls.into_iter().map(|u| &*Box::leak(u.into_boxed_str())).collect();
        Box::leak(Box::new(local_asr::ModelFile {
            path,
            sha256: Box::leak(format!("{:x}", Sha256::digest(body)).into_boxed_str()),
            size: body.len() as u64,
            urls: Box::leak(urls.into_boxed_slice()),
        }))
    }

    #[tokio::test]
    async fn a_failing_source_falls_through_to_the_next_and_the_file_lands_verified() {
        let (base, _) = serve(b"model bytes").await;
        let file = leak_file("m/model.onnx", b"model bytes", vec![format!("{base}/404/a"), format!("{base}/ok/a")]);
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("m/model.onnx");
        let seen = std::sync::Mutex::new(Vec::new());
        download_files(&reqwest::Client::new(), "测试模型", vec![(target.clone(), file)], |n| seen.lock().unwrap().push(n))
            .await
            .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"model bytes");
        assert_eq!(*seen.lock().unwrap().last().unwrap(), 11);
        assert!(!dir.path().join("m/model.onnx.part").exists());
    }

    #[tokio::test]
    async fn a_mirror_serving_different_bytes_is_rejected_and_leaves_nothing_behind() {
        let (base, _) = serve(b"tampered!!!").await;
        let file = leak_file("model.onnx", b"model bytes", vec![format!("{base}/ok/a")]);
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("model.onnx");
        let error = download_files(&reqwest::Client::new(), "测试模型", vec![(target.clone(), file)], |_| {})
            .await
            .unwrap_err();
        assert!(error.to_string().contains("所有下载源都失败"), "{error}");
        assert!(!target.exists());
        assert!(!dir.path().join("model.onnx.part").exists());
    }

    /// 手动跑（要联网，约 240MB）：`cargo test --lib real_sense_voice_download -- --ignored`。
    /// 走真实的下载源，把 SenseVoice 和 VAD 下到临时目录，校验全部通过才算装好。
    #[tokio::test]
    #[ignore]
    async fn real_sense_voice_download() {
        let dir = tempfile::tempdir().unwrap();
        let missing = local_asr::missing_files(dir.path(), &local_asr::SENSE_VOICE);
        let started = std::time::Instant::now();
        download_files(&reqwest::Client::new(), "SenseVoice", missing, |_| {}).await.unwrap();
        assert!(local_asr::is_installed(dir.path(), &local_asr::SENSE_VOICE));
        eprintln!("下载 + 校验用时 {:.0}s", started.elapsed().as_secs_f64());
    }

    #[tokio::test]
    async fn a_dropped_connection_resumes_from_where_it_stopped_on_the_next_source() {
        const BODY: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
        let (base, ranges) = serve(BODY).await;
        // 第一个源发到一半就断；第二个源应该带着 Range 从断点接着下，而不是从头。
        let file = leak_file("model.onnx", BODY, vec![format!("{base}/half/a"), format!("{base}/ok/a")]);
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("model.onnx");
        download_files(&reqwest::Client::new(), "测试模型", vec![(target.clone(), file)], |_| {})
            .await
            .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), BODY);
        assert_eq!(*ranges.lock().unwrap(), vec![format!("{}-", BODY.len() / 2)]);
    }

    #[tokio::test]
    async fn a_leftover_partial_file_is_continued_not_restarted() {
        const BODY: &[u8] = b"the whole model file";
        let (base, ranges) = serve(BODY).await;
        let file = leak_file("model.onnx", BODY, vec![format!("{base}/ok/a")]);
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("model.onnx");
        std::fs::write(part_path(&target), &BODY[..8]).unwrap();
        download_files(&reqwest::Client::new(), "测试模型", vec![(target.clone(), file)], |_| {})
            .await
            .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), BODY);
        assert_eq!(*ranges.lock().unwrap(), vec!["8-".to_string()]);
    }

    #[test]
    fn invalid_html_model_is_not_available() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        let path = model_path(app_data, "base");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"<!DOCTYPE HTML><html>403 Forbidden</html>").unwrap();

        assert!(!is_model_available(&path));
    }
}
