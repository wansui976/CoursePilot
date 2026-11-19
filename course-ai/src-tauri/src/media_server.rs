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
//!
//! 本机没有文件、但同一个局域网里的电脑上有（lan_share.rs）：注册的是那台电脑的地址，
//! 这里把 `<video>` 的 Range 请求原样转过去。播放器永远只连 127.0.0.1，不用放宽 CSP，
//! 访问电脑用的口令和证书校验也都留在 Rust 这边。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;

/// 一个视频从哪来：本机文件，或局域网里另一台设备。
#[derive(Clone)]
pub enum Source {
    File(PathBuf),
    Remote(RemoteSource),
}

#[derive(Clone)]
pub struct RemoteSource {
    /// 视频的完整地址：局域网里那台设备（https://192.168.1.5:47321/v/<id>），或 WebDAV 上的文件。
    pub url: String,
    pub auth: RemoteAuth,
    /// 局域网：钉住了那台设备证书的客户端；WebDAV：普通客户端。
    pub client: reqwest::Client,
}

/// 访问远端视频用的凭据。
#[derive(Clone)]
pub enum RemoteAuth {
    /// 局域网直连播放的口令。
    Bearer(String),
    /// WebDAV 账号密码。
    Basic { user: String, password: String },
    /// 直接带上的请求头（夸克网盘的下载链接要带 Cookie、Referer、User-Agent）。
    Headers(Vec<(String, String)>),
}

impl RemoteSource {
    pub fn authorize(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.auth {
            RemoteAuth::Bearer(token) => request.bearer_auth(token),
            RemoteAuth::Basic { user, password } => request.basic_auth(user, Some(password)),
            RemoteAuth::Headers(headers) => {
                headers.iter().fold(request, |request, (name, value)| request.header(name.as_str(), value.as_str()))
            }
        }
    }
}

type Registry = Arc<Mutex<HashMap<String, Source>>>;

#[derive(Clone)]
pub struct MediaServer {
    pub port: u16,
    registry: Registry,
}

impl MediaServer {
    pub fn register(&self, id: &str, path: PathBuf) {
        self.registry.lock().unwrap().insert(id.to_string(), Source::File(path));
    }

    pub fn register_remote(&self, id: &str, source: RemoteSource) {
        self.registry.lock().unwrap().insert(id.to_string(), Source::Remote(source));
    }

    pub fn url(&self, id: &str) -> String {
        format!("http://127.0.0.1:{}/m/{}", self.port, id)
    }
}

/// Host 头是不是本机地址（带不带端口都行）。没有 Host 头的 HTTP/1.0 请求也放行：
/// 浏览器总会带 Host，没带的只可能是本机程序直接连过来的。
fn host_is_loopback(host: Option<&str>) -> bool {
    let Some(host) = host else { return true };
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host.rsplit_once(':').map_or(host, |(name, _)| name)
    };
    matches!(name.to_ascii_lowercase().as_str(), "127.0.0.1" | "localhost" | "::1")
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
        while let Ok((stream, _)) = listener.accept().await {
            let reg = registry.clone();
            tokio::spawn(async move {
                let _ = handle(stream, reg).await;
            });
        }
    });
    Ok(server)
}

/// 一个请求的头部里我们关心的部分。
pub(crate) struct RequestHead {
    pub method: String,
    pub target: String,
    pub range: Option<String>,
    pub host: Option<String>,
    pub authorization: Option<String>,
}

/// 读请求头（到 \r\n\r\n 为止；头部很小，超过 16 KB 就不读了）。连接没发东西就关了返回 None。
pub(crate) async fn read_head<S: AsyncRead + Unpin>(stream: &mut S) -> std::io::Result<Option<RequestHead>> {
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 1024];
    loop {
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 16384 {
            break;
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let mut lines = head.lines();
    let mut parts = lines.next().unwrap_or("").split_whitespace();
    let mut request = RequestHead {
        method: parts.next().unwrap_or("").to_string(),
        target: parts.next().unwrap_or("").to_string(),
        range: None,
        host: None,
        authorization: None,
    };
    for line in lines {
        if let Some(value) = strip_prefix_ci(line, "range:") {
            request.range = Some(value.trim().to_string());
        } else if let Some(value) = strip_prefix_ci(line, "host:") {
            request.host = Some(value.trim().to_string());
        } else if let Some(value) = strip_prefix_ci(line, "authorization:") {
            request.authorization = Some(value.trim().to_string());
        }
    }
    Ok(Some(request))
}

pub(crate) async fn respond_empty<S: AsyncWrite + Unpin>(stream: &mut S, status: &str) {
    let _ = stream
        .write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes())
        .await;
}

async fn handle<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, registry: Registry) -> std::io::Result<()> {
    let Some(request) = read_head(&mut stream).await? else { return Ok(()) };

    // 只认发往本机地址的请求。挡的是 DNS 重绑定：别的网页把自己的域名解析到 127.0.0.1，
    // 浏览器会把这个服务当成「同源」，就能用 fetch 读走视频。那时请求的 Host 头是对方的域名。
    if !host_is_loopback(request.host.as_deref()) {
        respond_empty(&mut stream, "403 Forbidden").await;
        return Ok(());
    }

    // URL 上可能带 ?v=…（文件换了要换 URL 才会重新加载），查询串不参与 id 匹配。
    let target = request.target.split('?').next().unwrap_or(&request.target);
    let id = target.strip_prefix("/m/").unwrap_or("");
    let source = registry.lock().unwrap().get(id).cloned();
    match source {
        Some(Source::File(path)) => serve_file(&mut stream, &path, &request.method, request.range.as_deref()).await,
        Some(Source::Remote(remote)) => proxy(&mut stream, &remote, &request.method, request.range.as_deref()).await,
        None => {
            respond_empty(&mut stream, "404 Not Found").await;
            Ok(())
        }
    }
}

/// 回一个文件（支持 Range、HEAD）。本机媒体服务和局域网共享都用它。
pub(crate) async fn serve_file<S: AsyncWrite + Unpin>(
    stream: &mut S,
    path: &Path,
    method: &str,
    range_header: Option<&str>,
) -> std::io::Result<()> {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(_) => {
            respond_empty(stream, "404 Not Found").await;
            return Ok(());
        }
    };
    let total = file.metadata().await?.len();
    let (start, end) = parse_range(range_header, total);
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
         Access-Control-Allow-Origin: *\r\n\
         Connection: close\r\n",
        ct = content_type(path),
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

/// 把 `<video>` 的请求转给局域网里的那台设备，回应原样（状态、长度、Range）转回来。
async fn proxy<S: AsyncWrite + Unpin>(
    stream: &mut S,
    remote: &RemoteSource,
    method: &str,
    range_header: Option<&str>,
) -> std::io::Result<()> {
    let head = method.eq_ignore_ascii_case("HEAD");
    let method = if head { reqwest::Method::HEAD } else { reqwest::Method::GET };
    let mut request = remote.authorize(remote.client.request(method, &remote.url));
    if let Some(range) = range_header {
        request = request.header(reqwest::header::RANGE, range);
    }
    let mut response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(%error, "局域网里的设备连不上了");
            respond_empty(stream, "502 Bad Gateway").await;
            return Ok(());
        }
    };
    let status = response.status();
    let mut header = format!(
        "HTTP/1.1 {} {}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or(""),
    );
    for name in [reqwest::header::CONTENT_TYPE, reqwest::header::CONTENT_LENGTH, reqwest::header::CONTENT_RANGE] {
        if let Some(value) = response.headers().get(&name).and_then(|value| value.to_str().ok()) {
            header.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    header.push_str("\r\n");
    stream.write_all(header.as_bytes()).await?;
    if head {
        let _ = stream.flush().await;
        return Ok(());
    }
    while let Ok(Some(chunk)) = response.chunk().await {
        if stream.write_all(&chunk).await.is_err() {
            break; // 播放器换了位置、断开了这条：正常。
        }
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

pub(crate) fn content_type(path: &Path) -> &'static str {
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
        Some("aac") => "audio/aac",
        Some("wav") => "audio/wav",
        Some("flac") => "audio/flac",
        Some("ogg" | "opus") => "audio/ogg",
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
        assert_eq!(content_type(Path::new("ep.MP3")), "audio/mpeg");
        assert_eq!(content_type(Path::new("ep.opus")), "audio/ogg");
    }

    // 前端「自动裁黑边」用一个离屏 <video crossOrigin="anonymous"> 加载本服务的
    // 同一 URL，再把帧画进 canvas 读像素检测黑边。视频走 http://127.0.0.1（与
    // WKWebView 应用同源不同），属跨源；canvas 读像素要求响应带 CORS 头，否则
    // crossOrigin 模式加载会被 CORS 拦截（loadedmetadata 不触发）、或 canvas 被
    // 污染、getImageData 抛错。故响应必须带 Access-Control-Allow-Origin。
    #[tokio::test]
    async fn response_includes_cors_header_for_canvas_pixel_access() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpStream;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mp4");
        std::fs::write(&path, b"fake-mp4-bytes").unwrap();

        let server = start().await.unwrap();
        server.register("vid1", path);

        let mut stream = TcpStream::connect(("127.0.0.1", server.port))
            .await
            .unwrap();
        stream
            .write_all(b"GET /m/vid1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();

        let mut resp = Vec::new();
        let mut tmp = [0_u8; 1024];
        loop {
            let n = stream.read(&mut tmp).await.unwrap();
            if n == 0 {
                break;
            }
            resp.extend_from_slice(&tmp[..n]);
            if resp.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        let head = String::from_utf8_lossy(&resp).to_lowercase();
        assert!(
            head.contains("access-control-allow-origin: *"),
            "media response must send a CORS header so the off-screen \
             <video crossOrigin=anonymous> can read canvas pixels for \
             black-bar detection; got headers:\n{head}"
        );
    }

    #[test]
    fn only_loopback_hosts_are_served() {
        for ok in [Some("127.0.0.1"), Some("127.0.0.1:51234"), Some("localhost:80"), Some("LOCALHOST"), Some("[::1]:9000"), None] {
            assert!(host_is_loopback(ok), "{ok:?}");
        }
        for bad in [Some("evil.example:51234"), Some("127.0.0.1.evil.example"), Some("localhost.evil.example:1"), Some("")] {
            assert!(!host_is_loopback(bad), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn requests_for_another_host_are_refused() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mp4");
        std::fs::write(&path, b"fake-mp4-bytes").unwrap();
        let server = start().await.unwrap();
        server.register("vid1", path);
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", server.port)).await.unwrap();
        stream
            .write_all(b"GET /m/vid1 HTTP/1.1\r\nHost: rebound.example:8080\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        let text = String::from_utf8_lossy(&response);
        assert!(text.starts_with("HTTP/1.1 403"), "{text}");
        assert!(!text.contains("fake-mp4-bytes"));
    }
}
