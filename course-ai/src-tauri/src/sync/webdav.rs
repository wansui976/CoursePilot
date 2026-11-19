//! 最小的 WebDAV 客户端：列目录（PROPFIND Depth 1）、建目录（MKCOL）、上传（PUT）、下载（GET）。
//!
//! 只做同步需要的这几件事，兼容坚果云、Nextcloud、群晖、Alist 这类常见实现。
//! 同步用的文件名都是我们自己起的（只含 ASCII）；从网盘导入课程时要浏览用户自己的文件夹，
//! 名字里有中文、空格，所以列出来的名字一律做百分号解码，拼路径时用 `encode_path` 编码。

use crate::error::{AppError, AppResult};
use reqwest::{Method, StatusCode};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// 视频分块的单次上传 / 下载上限：64 MB 在 1 Mbps 的上行上也只要九分钟。
const LARGE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Clone)]
pub struct WebDav {
    http: reqwest::Client,
    /// 以 `/` 结尾的根地址（含用户选的文件夹）。
    root: String,
    user: String,
    password: String,
}

/// 目录里的一项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    /// 文件大小（服务器给了才有）。
    pub size: Option<u64>,
}

impl WebDav {
    /// `base`：服务地址（如 https://dav.jianguoyun.com/dav/）；`folder`：放同步数据的文件夹。
    pub fn new(base: &str, folder: &str, user: &str, password: &str) -> AppResult<Self> {
        let base = base.trim();
        let parsed = reqwest::Url::parse(base)
            .map_err(|_| AppError::Config(format!("WebDAV 地址不是合法的网址：{base}")))?;
        if !matches!(parsed.scheme(), "https" | "http") {
            return Err(AppError::Config("WebDAV 地址要以 https:// 或 http:// 开头".into()));
        }
        let folder = folder.trim().trim_matches('/');
        let mut root = base.trim_end_matches('/').to_string();
        for part in folder.split('/').filter(|part| !part.is_empty()) {
            root.push('/');
            root.push_str(&encode_segment(part));
        }
        root.push('/');
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| AppError::Other(error.to_string()))?;
        Ok(Self { http, root, user: user.to_string(), password: password.to_string() })
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.root, path.trim_start_matches('/'))
    }

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, self.url(path))
            .basic_auth(&self.user, Some(&self.password))
    }

    /// 列一个目录（不递归）。目录不存在返回 None。
    pub async fn list(&self, dir: &str) -> AppResult<Option<Vec<Entry>>> {
        let dir = ensure_trailing_slash(dir);
        let response = self
            .request(Method::from_bytes(b"PROPFIND").expect("valid method"), &dir)
            .header("Depth", "1")
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>"#)
            .send()
            .await
            .map_err(network_error)?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        check(status, "列目录")?;
        let body = response.text().await.map_err(network_error)?;
        let own = reqwest::Url::parse(&self.url(&dir)).map(|url| url.path().to_string()).unwrap_or_default();
        Ok(Some(parse_propfind(&body, &own)))
    }

    /// 逐级建目录（已存在的跳过）。
    pub async fn ensure_dir(&self, dir: &str) -> AppResult<()> {
        let mut path = String::new();
        for part in dir.split('/').filter(|part| !part.is_empty()) {
            path.push_str(part);
            path.push('/');
            self.mkcol(&path).await?;
        }
        Ok(())
    }

    /// 建根目录（用户选的文件夹本身，可能是多级）。
    pub async fn ensure_root(&self) -> AppResult<()> {
        let response = self
            .http
            .request(Method::from_bytes(b"MKCOL").expect("valid method"), &self.root)
            .basic_auth(&self.user, Some(&self.password))
            .send()
            .await
            .map_err(network_error)?;
        match response.status() {
            status if status.is_success() => Ok(()),
            // 405 = 已存在；409 = 上级不存在（多级文件夹），交给逐级创建。
            StatusCode::METHOD_NOT_ALLOWED => Ok(()),
            StatusCode::CONFLICT => self.ensure_root_levels().await,
            status => check(status, "建文件夹"),
        }
    }

    async fn ensure_root_levels(&self) -> AppResult<()> {
        let url = reqwest::Url::parse(&self.root).map_err(|error| AppError::Other(error.to_string()))?;
        let segments: Vec<String> = url
            .path_segments()
            .map(|parts| parts.filter(|part| !part.is_empty()).map(str::to_string).collect())
            .unwrap_or_default();
        let mut current = url.clone();
        current.set_path("/");
        for segment in segments {
            let mut path = current.path().to_string();
            path.push_str(&segment);
            path.push('/');
            current.set_path(&path);
            let response = self
                .http
                .request(Method::from_bytes(b"MKCOL").expect("valid method"), current.as_str())
                .basic_auth(&self.user, Some(&self.password))
                .send()
                .await
                .map_err(network_error)?;
            let status = response.status();
            if !(status.is_success() || status == StatusCode::METHOD_NOT_ALLOWED) {
                // 服务地址本身那几级（如 /dav/）不让建是正常的，只要最后能用就行。
                if status != StatusCode::FORBIDDEN && status != StatusCode::CONFLICT {
                    check(status, "建文件夹")?;
                }
            }
        }
        Ok(())
    }

    async fn mkcol(&self, path: &str) -> AppResult<()> {
        let response = self
            .request(Method::from_bytes(b"MKCOL").expect("valid method"), &ensure_trailing_slash(path))
            .send()
            .await
            .map_err(network_error)?;
        match response.status() {
            status if status.is_success() => Ok(()),
            StatusCode::METHOD_NOT_ALLOWED => Ok(()),
            status => check(status, "建文件夹"),
        }
    }

    pub async fn put(&self, path: &str, bytes: Vec<u8>) -> AppResult<()> {
        let response = self
            .request(Method::PUT, path)
            .header("Content-Type", "application/json")
            .body(bytes)
            .send()
            .await
            .map_err(network_error)?;
        check(response.status(), "上传")
    }

    /// 把一个文件改名（先传成临时名、传完再改成正式名：别的设备永远读不到半截文件）。
    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        let response = self
            .request(Method::from_bytes(b"MOVE").expect("valid method"), from)
            .header("Destination", self.url(to))
            .header("Overwrite", "T")
            .send()
            .await
            .map_err(network_error)?;
        check(response.status(), "改名")
    }

    /// 删一个文件或整个文件夹（WebDAV 删文件夹是连里面一起删）。本来就没有也算成功：
    /// 两台设备同时清理同一样东西时，后到的那个不该报错。
    pub async fn delete(&self, path: &str) -> AppResult<()> {
        let response = self.request(Method::DELETE, path).send().await.map_err(network_error)?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        check(response.status(), "删除")
    }

    /// 文件在不在（GET 不下载内容太重时用；这里只给小文件用 GET 判断）。
    pub async fn get_optional(&self, path: &str) -> AppResult<Option<Vec<u8>>> {
        let response = self.request(Method::GET, path).send().await.map_err(network_error)?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        check(response.status(), "下载")?;
        Ok(Some(response.bytes().await.map_err(network_error)?.to_vec()))
    }

    /// 大块上传（视频分块）：慢网络上一块要传好几分钟，单独放宽超时。
    pub async fn put_large(&self, path: &str, bytes: Vec<u8>) -> AppResult<()> {
        let response = self
            .request(Method::PUT, path)
            .header("Content-Type", "application/octet-stream")
            .timeout(LARGE_TIMEOUT)
            .body(bytes)
            .send()
            .await
            .map_err(network_error)?;
        check(response.status(), "上传视频")
    }

    /// 大块下载（视频分块）。
    pub async fn get_large(&self, path: &str) -> AppResult<Vec<u8>> {
        let response = self.request(Method::GET, path).timeout(LARGE_TIMEOUT).send().await.map_err(network_error)?;
        check(response.status(), "下载视频")?;
        Ok(response.bytes().await.map_err(network_error)?.to_vec())
    }

    pub async fn get(&self, path: &str) -> AppResult<Vec<u8>> {
        let response = self.request(Method::GET, path).send().await.map_err(network_error)?;
        check(response.status(), "下载")?;
        Ok(response.bytes().await.map_err(network_error)?.to_vec())
    }

    /// 服务器时钟与本机时钟之差（毫秒，服务器 − 本机）。拿不到 Date 头时返回 None。
    pub async fn clock_offset_ms(&self) -> AppResult<Option<i64>> {
        let before = chrono::Utc::now().timestamp_millis();
        let response = self
            .request(Method::from_bytes(b"PROPFIND").expect("valid method"), "")
            .header("Depth", "0")
            .send()
            .await
            .map_err(network_error)?;
        let after = chrono::Utc::now().timestamp_millis();
        // 只要服务器的 Date 头。第一次用时同步文件夹还不存在（404）是正常的，
        // 账号密码不对才算失败。
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            check(status, "连接")?;
        }
        let Some(date) = response.headers().get("date").and_then(|value| value.to_str().ok()) else {
            return Ok(None);
        };
        let Ok(server) = chrono::DateTime::parse_from_rfc2822(date) else { return Ok(None) };
        Ok(Some(server.timestamp_millis() - (before + after) / 2))
    }
}

fn ensure_trailing_slash(path: &str) -> String {
    let path = path.trim_start_matches('/');
    if path.is_empty() || path.ends_with('/') {
        path.to_string()
    } else {
        format!("{path}/")
    }
}

/// 把「a/b 课/c.mp4」这样的路径按段编码成可以放进网址的样子。
pub fn encode_path(path: &str) -> String {
    let trailing = path.ends_with('/');
    let mut out: Vec<String> = path.split('/').filter(|part| !part.is_empty()).map(encode_segment).collect();
    if trailing && !out.is_empty() {
        out.push(String::new());
    }
    out.join("/")
}

/// 百分号解码（解出来不是合法 UTF-8 时原样返回）。
pub fn percent_decode(text: &str) -> String {
    fn hex(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                out.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}

/// 用户填的文件夹名可能含中文或空格：按路径段做百分号编码。
fn encode_segment(segment: &str) -> String {
    let mut out = String::new();
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn network_error(error: reqwest::Error) -> AppError {
    AppError::Other(format!("连不上同步服务器：{error}"))
}

fn check(status: StatusCode, action: &str) -> AppResult<()> {
    if status.is_success() || status == StatusCode::MULTI_STATUS {
        return Ok(());
    }
    let reason = match status {
        StatusCode::UNAUTHORIZED => "账号或密码不对（坚果云要用「第三方应用密码」，不是登录密码）".to_string(),
        StatusCode::FORBIDDEN => "服务器拒绝了（没有这个文件夹的权限）".to_string(),
        StatusCode::NOT_FOUND => "地址不对（找不到这个 WebDAV 路径）".to_string(),
        StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE => "服务器限流了，稍后会自动重试".to_string(),
        StatusCode::INSUFFICIENT_STORAGE => "网盘空间不够了".to_string(),
        other => format!("HTTP {other}"),
    };
    Err(AppError::Other(format!("同步{action}失败：{reason}")))
}

/// 从 PROPFIND 的多状态响应里取出各项的名字与是否目录。`own_path` 是被列目录自身的路径，跳过它。
///
/// 不同服务器的命名空间前缀不一样（d: / D: / 无前缀），所以按「本地名」认标签。
pub(crate) fn parse_propfind(xml: &str, own_path: &str) -> Vec<Entry> {
    let mut entries = Vec::new();
    for response in split_elements(xml, "response") {
        let Some(href) = first_text(response, "href") else { continue };
        let href = href.trim();
        // href 可能是完整网址，也可能只是路径。
        let path = reqwest::Url::parse(href)
            .map(|url| url.path().to_string())
            .unwrap_or_else(|_| href.to_string());
        if path.trim_end_matches('/') == own_path.trim_end_matches('/') {
            continue;
        }
        let is_dir = path.ends_with('/') || contains_element(response, "collection");
        let Some(name) = path.trim_end_matches('/').rsplit('/').next().filter(|name| !name.is_empty()) else {
            continue;
        };
        let name = percent_decode(name);
        let size = first_text(response, "getcontentlength").and_then(|value| value.trim().parse().ok());
        entries.push(Entry { name, is_dir, size });
    }
    entries
}

/// 按本地名切出所有 `<x:name ...>…</x:name>` 元素的内部文本。
fn split_elements<'a>(xml: &'a str, local: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some((_, body_start)) = find_open_tag(rest, local) {
        let Some(close) = find_close_tag(&rest[body_start..], local) else { break };
        out.push(&rest[body_start..body_start + close.0]);
        rest = &rest[body_start + close.1..];
    }
    out
}

fn first_text<'a>(xml: &'a str, local: &str) -> Option<&'a str> {
    let (_, open_end) = find_open_tag(xml, local)?;
    let (close_start, _) = find_close_tag(&xml[open_end..], local)?;
    Some(&xml[open_end..open_end + close_start])
}

fn contains_element(xml: &str, local: &str) -> bool {
    find_open_tag(xml, local).is_some()
}

/// 找 `<prefix:local` 或 `<local` 开头的开始标签，返回（标签起点，标签结束后的位置）。
fn find_open_tag(xml: &str, local: &str) -> Option<(usize, usize)> {
    let mut index = 0;
    while let Some(offset) = xml[index..].find('<') {
        let start = index + offset;
        let after = &xml[start + 1..];
        if after.starts_with('/') || after.starts_with('?') || after.starts_with('!') {
            index = start + 1;
            continue;
        }
        let name_end = after.find(|ch: char| ch.is_whitespace() || ch == '>' || ch == '/').unwrap_or(after.len());
        let name = &after[..name_end];
        let local_name = name.rsplit(':').next().unwrap_or(name);
        let tag_end = after.find('>')?;
        if local_name.eq_ignore_ascii_case(local) {
            return Some((start, start + 1 + tag_end + 1));
        }
        index = start + 1;
    }
    None
}

/// 找 `</prefix:local>`，返回（结束标签起点，结束标签后的位置），相对传入片段。
fn find_close_tag(xml: &str, local: &str) -> Option<(usize, usize)> {
    let mut index = 0;
    while let Some(offset) = xml[index..].find("</") {
        let start = index + offset;
        let after = &xml[start + 2..];
        let end = after.find('>')?;
        let name = after[..end].trim();
        let local_name = name.rsplit(':').next().unwrap_or(name);
        if local_name.eq_ignore_ascii_case(local) {
            return Some((start, start + 2 + end + 1));
        }
        index = start + 2;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_folder_names_round_trip_through_percent_encoding() {
        assert_eq!(encode_path("网课/申论 2027/01 概括.mp4"), "%E7%BD%91%E8%AF%BE/%E7%94%B3%E8%AE%BA%202027/01%20%E6%A6%82%E6%8B%AC.mp4");
        assert_eq!(encode_path("a/b/"), "a/b/");
        assert_eq!(percent_decode("01%20%E6%A6%82%E6%8B%AC.mp4"), "01 概括.mp4");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz%E6"), "%zz%E6", "不完整的编码原样保留");
        assert_eq!(percent_decode("已经是中文%"), "已经是中文%");
    }

    #[test]
    fn propfind_responses_from_common_servers_parse() {
        // 坚果云风格：d: 前缀、完整路径 href。
        let jianguoyun = r#"<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>/dav/CoursePilot/sync-v1/devices/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
 <d:response><d:href>/dav/CoursePilot/sync-v1/devices/dev-a/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
 <d:response><d:href>/dav/CoursePilot/sync-v1/devices/dev-b/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
</d:multistatus>"#;
        assert_eq!(
            parse_propfind(jianguoyun, "/dav/CoursePilot/sync-v1/devices/"),
            vec![Entry { name: "dev-a".into(), is_dir: true, size: None }, Entry { name: "dev-b".into(), is_dir: true, size: None }]
        );
        // Nextcloud 风格：D: 前缀；文件没有结尾斜杠，resourcetype 为空。
        let nextcloud = r#"<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:"><D:response><D:href>https://cloud.example/remote.php/dav/files/u/CP/b/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
<D:response><D:href>https://cloud.example/remote.php/dav/files/u/CP/b/000000000001.json</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>2048</D:getcontentlength></D:prop></D:propstat></D:response></D:multistatus>"#;
        assert_eq!(
            parse_propfind(nextcloud, "/remote.php/dav/files/u/CP/b/"),
            vec![Entry { name: "000000000001.json".into(), is_dir: false, size: Some(2048) }]
        );
    }

    #[test]
    fn folder_names_are_percent_encoded_into_the_root() {
        let dav = WebDav::new("https://dav.example/dav/", "学习 资料/CoursePilot", "u", "p").unwrap();
        assert_eq!(dav.url("x.json"), "https://dav.example/dav/%E5%AD%A6%E4%B9%A0%20%E8%B5%84%E6%96%99/CoursePilot/x.json");
        assert!(WebDav::new("ftp://x", "a", "u", "p").is_err());
    }
}
