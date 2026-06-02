//! 本地媒体 HTTP 服务（127.0.0.1，随机端口）。
//!
//! 为什么需要它：macOS 的 WKWebView 通过自定义 URL scheme（Tauri 的 `asset://`）
//! 给 `<video>` 喂媒体时，对较大的文件支持不全——典型表现是「有画面、没声音」，
//! 甚至直接报 MEDIA_ERR_SRC_NOT_SUPPORTED。这是 WKWebView 自定义 scheme 的已知限制：
//! 它不会用完整的 HTTP Range/流式机制驱动自定义 scheme。
//!
//! 解决办法是社区通行做法：用一个本地 HTTP 服务（支持 Range、回 `Accept-Ranges`）
//! 来提供视频，`<video>` 指向 http://127.0.0.1:port/...，绕开 asset 协议。
//!
//! 安全：只服务显式注册过的文件（video_id → 路径），不暴露任意路径读取。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

type Registry = Arc<Mutex<HashMap<String, PathBuf>>>;

#[derive(Clone)]
pub struct MediaServer {
    pub port: u16,
    registry: Registry,
}

impl MediaServer {
    pub fn register(&self, id: &str, path: PathBuf) {
        self.registry.lock().unwrap().insert(id.to_string(), path);
    }

    pub fn url(&self, id: &str) -> String {
        format!("http://127.0.0.1:{}/m/{}", self.port, id)
    }
}

/// 绑定随机端口并在后台 accept 循环。返回带端口的句柄。
pub async fn start() -> std::io::Result<MediaServer> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let registry: Registry = Arc::new(Mutex::new(HashMap::new()));
    let server = MediaServer {
        port,
        registry: registry.clone(),
    };
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let reg = registry.clone();
                    tokio::spawn(async move {
                        let _ = handle(stream, reg).await;
                    });
                }
                Err(_) => break,
            }
        }
    });
    Ok(server)
}

async fn handle(mut stream: TcpStream, registry: Registry) -> std::io::Result<()> {
    // 读取请求头（到 \r\n\r\n 为止；头部很小）。
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 1024];
    loop {
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 16384 {
            break;
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let mut range_header: Option<String> = None;
    for line in lines {
        if let Some(value) = strip_prefix_ci(line, "range:") {
            range_header = Some(value.trim().to_string());
        }
    }

    let id = target.strip_prefix("/m/").unwrap_or("");
    let path = registry.lock().unwrap().get(id).cloned();
    let Some(path) = path else {
        let _ = stream
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
        return Ok(());
    };

    let mut file = match tokio::fs::File::open(&path).await {
        Ok(file) => file,
        Err(_) => {
            let _ = stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            return Ok(());
        }
    };
    let total = file.metadata().await?.len();
    let (start, end) = parse_range(range_header.as_deref(), total);
    let len = end + 1 - start;
    let partial = range_header.is_some();
    let status = if partial {
        "206 Partial Content"
    } else {
        "200 OK"
    };

    let mut header = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: {ct}\r\n\
         Accept-Ranges: bytes\r\n\
         Content-Length: {len}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n",
        ct = content_type(&path),
    );
    if partial {
        header.push_str(&format!("Content-Range: bytes {start}-{end}/{total}\r\n"));
    }
    header.push_str("\r\n");
    stream.write_all(header.as_bytes()).await?;

    // HEAD 只回头部。
    if method.eq_ignore_ascii_case("HEAD") {
        let _ = stream.flush().await;
        return Ok(());
    }

    file.seek(std::io::SeekFrom::Start(start)).await?;
    let mut remaining = len;
    let mut chunk = vec![0_u8; 64 * 1024];
    while remaining > 0 {
        let want = remaining.min(chunk.len() as u64) as usize;
        let n = file.read(&mut chunk[..want]).await?;
        if n == 0 {
            break;
        }
        if stream.write_all(&chunk[..n]).await.is_err() {
            break; // 客户端断开（seek 会断流），正常。
        }
        remaining -= n as u64;
    }
    let _ = stream.flush().await;
    Ok(())
}

fn strip_prefix_ci<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    if line.len() >= prefix.len() && line[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&line[prefix.len()..])
    } else {
        None
    }
}

/// 解析 `bytes=start-end` / `bytes=start-` / `bytes=-suffix`，返回闭区间，钳到 [0,total-1]。
pub fn parse_range(header: Option<&str>, total: u64) -> (u64, u64) {
    let last = total.saturating_sub(1);
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return (0, last);
    };
    let spec = spec.split(',').next().unwrap_or("").trim();
    let Some((a, b)) = spec.split_once('-') else {
        return (0, last);
    };
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        // 后缀：最后 N 字节
        let n: u64 = b.parse().unwrap_or(0);
        let start = total.saturating_sub(n.max(1));
        return (start.min(last), last);
    }
    let start: u64 = a.parse().unwrap_or(0).min(last);
    let end: u64 = if b.is_empty() {
        last
    } else {
        b.parse().unwrap_or(last).min(last)
    };
    if end < start {
        (start, last)
    } else {
        (start, end)
    }
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("webm") => "video/webm",
        Some("ogv") => "video/ogg",
        Some("m4a") => "audio/mp4",
        Some("mp3") => "audio/mpeg",
        _ => "video/mp4", // mp4/mov/m4v 及默认
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn no_range_returns_whole_file() {
        assert_eq!(parse_range(None, 1000), (0, 999));
        assert_eq!(parse_range(Some("bytes=0-"), 1000), (0, 999));
    }

    #[test]
    fn explicit_range_is_inclusive_and_clamped() {
        assert_eq!(parse_range(Some("bytes=100-199"), 1000), (100, 199));
        assert_eq!(parse_range(Some("bytes=100-"), 1000), (100, 999));
        assert_eq!(parse_range(Some("bytes=900-100000"), 1000), (900, 999));
    }

    #[test]
    fn suffix_range_returns_tail() {
        assert_eq!(parse_range(Some("bytes=-200"), 1000), (800, 999));
    }

    #[test]
    fn content_type_by_extension() {
        assert_eq!(content_type(Path::new("a.mp4")), "video/mp4");
        assert_eq!(content_type(Path::new("a.MOV")), "video/mp4");
        assert_eq!(content_type(Path::new("a.webm")), "video/webm");
    }
}
