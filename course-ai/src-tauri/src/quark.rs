//! 夸克网盘的最小客户端：列文件夹、取下载链接。
//!
//! 夸克没有面向一般开发者的开放平台，这里用的是网页版自己调的接口，凭用户从网页版复制的
//! Cookie 访问（和 OpenList 的夸克驱动一样）。所以：
//! - 接口随时可能变，变了这里就得跟着改；
//! - Cookie 过一阵子会失效，要重新复制。接口回 `__puus` 时顺手把 Cookie 续上，能撑久一点；
//! - 非会员的下载速度由夸克限制。
//!
//! 只读：列目录、取下载链接，不改用户网盘里的任何东西。

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

const API: &str = "https://drive.quark.cn/1/clouddrive";
pub const REFERER: &str = "https://pan.quark.cn";
pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch";
const PAGE_SIZE: usize = 100;
/// 根目录的 id。
pub const ROOT: &str = "0";

fn api_base() -> String {
    test_api().lock().unwrap().clone().unwrap_or_else(|| API.to_string())
}

fn test_api() -> &'static Mutex<Option<String>> {
    static API_OVERRIDE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    API_OVERRIDE.get_or_init(|| Mutex::new(None))
}

/// 测试里把接口指到本地的假服务器。
#[cfg(test)]
pub fn set_api_base_for_tests(base: &str) {
    *test_api().lock().unwrap() = Some(base.to_string());
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuarkFile {
    pub fid: String,
    pub name: String,
    pub size: Option<u64>,
    pub is_dir: bool,
    /// 夸克自己的分类：1 = 视频。
    pub is_video: bool,
}

pub struct Client {
    http: reqwest::Client,
    cookie: Mutex<String>,
}

/// 网页版接口会把名字里的 `&` 之类转义成 HTML 实体。
fn unescape_html(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&amp;", "&")
}

/// 用响应里新发的 `__puus` 换掉 Cookie 里旧的那段（续命）。
fn refreshed_cookie(cookie: &str, set_cookies: &[String]) -> Option<String> {
    let fresh = set_cookies.iter().find_map(|header| {
        let pair = header.split(';').next()?.trim();
        pair.strip_prefix("__puus=").map(|value| value.to_string())
    })?;
    let mut replaced = false;
    let mut parts: Vec<String> = cookie
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| {
            if part.starts_with("__puus=") {
                replaced = true;
                format!("__puus={fresh}")
            } else {
                part.to_string()
            }
        })
        .collect();
    if !replaced {
        parts.push(format!("__puus={fresh}"));
    }
    let next = parts.join("; ");
    (next != cookie).then_some(next)
}

impl Client {
    pub fn new(cookie: &str) -> AppResult<Self> {
        let cookie = cookie.trim().trim_start_matches("Cookie:").trim().to_string();
        if cookie.is_empty() {
            return Err(AppError::Config("要先填夸克网盘的 Cookie".into()));
        }
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|error| AppError::Other(error.to_string()))?;
        Ok(Self { http, cookie: Mutex::new(cookie) })
    }

    /// 现在的 Cookie（可能已经被接口续过）。
    pub fn cookie(&self) -> String {
        self.cookie.lock().unwrap().clone()
    }

    /// 下载 / 播放时要带的请求头。
    pub fn download_headers(&self) -> Vec<(String, String)> {
        vec![
            ("Cookie".into(), self.cookie()),
            ("Referer".into(), format!("{REFERER}/")),
            ("User-Agent".into(), USER_AGENT.into()),
        ]
    }

    async fn call(&self, method: reqwest::Method, path: &str, query: &[(&str, String)], body: Option<Value>) -> AppResult<Value> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", api_base()))
            .query(&[("pr", "ucpro"), ("fr", "pc")])
            .query(query)
            .header("Cookie", self.cookie())
            .header("Referer", format!("{REFERER}/"))
            .header("Accept", "application/json, text/plain, */*")
            .header("User-Agent", USER_AGENT);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|error| AppError::Other(format!("连不上夸克网盘：{error}")))?;
        let set_cookies: Vec<String> = response
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok().map(str::to_string))
            .collect();
        if let Some(next) = refreshed_cookie(&self.cookie(), &set_cookies) {
            *self.cookie.lock().unwrap() = next;
        }
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        let code = body.get("code").and_then(Value::as_i64).unwrap_or(if status.is_success() { 0 } else { -1 });
        if status == reqwest::StatusCode::UNAUTHORIZED || code == 31001 {
            return Err(AppError::Config("夸克网盘的登录已失效：在浏览器里重新登录 pan.quark.cn，再复制一份 Cookie".into()));
        }
        if !status.is_success() || code != 0 {
            let message = body.get("message").and_then(Value::as_str).unwrap_or("未知错误");
            return Err(AppError::Other(format!("夸克网盘：{message}（HTTP {status}，code {code}）")));
        }
        Ok(body)
    }

    /// 列一个文件夹（`fid` 为 ROOT 是根目录），翻完所有页。
    pub async fn list(&self, fid: &str) -> AppResult<Vec<QuarkFile>> {
        let mut files = Vec::new();
        for page in 1.. {
            let body = self
                .call(
                    reqwest::Method::GET,
                    "/file/sort",
                    &[
                        ("pdir_fid", fid.to_string()),
                        ("_page", page.to_string()),
                        ("_size", PAGE_SIZE.to_string()),
                        ("_fetch_total", "1".into()),
                        ("fetch_all_file", "1".into()),
                        ("_sort", "file_type:asc,file_name:asc".into()),
                    ],
                    None,
                )
                .await?;
            let list = body.pointer("/data/list").and_then(Value::as_array).cloned().unwrap_or_default();
            let count = list.len();
            files.extend(list.iter().filter_map(|item| {
                let fid = item.get("fid")?.as_str()?.to_string();
                let is_file = item.get("file").and_then(Value::as_bool).unwrap_or(true);
                Some(QuarkFile {
                    fid,
                    name: unescape_html(item.get("file_name").and_then(Value::as_str).unwrap_or_default()),
                    size: item.get("size").and_then(Value::as_u64).filter(|_| is_file),
                    is_dir: !is_file,
                    is_video: is_file && item.get("category").and_then(Value::as_i64) == Some(1),
                })
            }));
            let total = body.pointer("/metadata/_total").and_then(Value::as_u64).unwrap_or(0) as usize;
            if count == 0 || page * PAGE_SIZE >= total {
                break;
            }
        }
        Ok(files)
    }

    /// 一个文件的下载链接（有时效，播放 / 下载前现取）。
    pub async fn download_url(&self, fid: &str) -> AppResult<String> {
        let body = self.call(reqwest::Method::POST, "/file/download", &[], Some(json!({ "fids": [fid] }))).await?;
        body.pointer("/data/0/download_url")
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty())
            .map(str::to_string)
            .ok_or_else(|| AppError::Other("夸克网盘没给下载链接（文件可能被删了，或者违规被屏蔽）".into()))
    }
}

#[cfg(test)]
pub(crate) mod fake {
    //! 假的夸克接口：/file/sort、/file/download，以及要带 Cookie / Referer 才给的文件下载地址。
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    pub struct Drive {
        /// fid → (父 fid, 名字, 是不是文件夹, 内容)
        pub files: BTreeMap<String, (String, String, bool, Vec<u8>)>,
        /// 接口认的 __puus（每次请求后换一个新的发回去）。
        pub puus: String,
        pub downloads: usize,
        /// 接下来这么多次下载只发一半就断开（模拟夸克的下载连接半路被掐）。
        pub drop_next: usize,
        /// 收到的下载请求带的 Range（None = 没带）。
        pub ranges: Vec<Option<String>>,
    }

    pub async fn start(files: &[(&str, &str, &str, bool, &[u8])]) -> (String, Arc<Mutex<Drive>>) {
        let drive = Arc::new(Mutex::new(Drive {
            files: files
                .iter()
                .map(|(fid, parent, name, dir, bytes)| (fid.to_string(), (parent.to_string(), name.to_string(), *dir, bytes.to_vec())))
                .collect(),
            puus: "p1".into(),
            downloads: 0,
            drop_next: 0,
            ranges: Vec::new(),
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let shared = drive.clone();
        let own = base.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let drive = shared.clone();
                let own = own.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 8192];
                    let (head, body) = loop {
                        let n = socket.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        let Some(split) = buf.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                        let head = String::from_utf8_lossy(&buf[..split]).to_string();
                        let length = head
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        if buf.len() >= split + 4 + length {
                            break (head, buf[split + 4..split + 4 + length].to_vec());
                        }
                    };
                    let header = |name: &str| {
                        head.lines()
                            .find_map(|l| l.to_ascii_lowercase().starts_with(name).then(|| l[name.len()..].trim().to_string()))
                    };
                    let target = head.split_whitespace().nth(1).unwrap_or("").to_string();
                    let url = reqwest::Url::parse(&format!("http://x{target}")).unwrap();
                    let query: BTreeMap<String, String> = url.query_pairs().into_owned().collect();
                    let cookie = header("cookie:").unwrap_or_default();
                    let mut truncate = false;
                    let (status, extra, payload) = {
                        let mut drive = drive.lock().unwrap();
                        let logged_in = cookie.contains(&format!("__puus={}", drive.puus));
                        let referer_ok = header("referer:").is_some_and(|r| r.starts_with("https://pan.quark.cn"));
                        if !logged_in || !referer_ok {
                            ("401 Unauthorized", String::new(), br#"{"code":31001,"message":"require login"}"#.to_vec())
                        } else if url.path() == "/1/clouddrive/file/sort" {
                            assert_eq!(query.get("pr").map(String::as_str), Some("ucpro"));
                            let parent = query.get("pdir_fid").cloned().unwrap_or_default();
                            let size: usize = query.get("_size").and_then(|v| v.parse().ok()).unwrap_or(100);
                            let page: usize = query.get("_page").and_then(|v| v.parse().ok()).unwrap_or(1);
                            let all: Vec<serde_json::Value> = drive
                                .files
                                .iter()
                                .filter(|(_, (p, ..))| *p == parent)
                                .map(|(fid, (_, name, dir, bytes))| {
                                    serde_json::json!({"fid": fid, "file_name": name.replace('&', "&amp;"), "file": !dir,
                                        "size": if *dir { 0 } else { bytes.len() }, "category": if name.ends_with(".mp4") { 1 } else { 4 }})
                                })
                                .collect();
                            let page_items: Vec<_> = all.iter().skip((page - 1) * size).take(size).cloned().collect();
                            drive.puus = format!("p{}", drive.puus[1..].parse::<u32>().unwrap() + 1);
                            let set = format!("Set-Cookie: __puus={}; Path=/; HttpOnly\r\n", drive.puus);
                            ("200 OK", set, serde_json::to_vec(&serde_json::json!({"code":0,"data":{"list":page_items},"metadata":{"_total":all.len()}})).unwrap())
                        } else if url.path() == "/1/clouddrive/file/download" {
                            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                            let fid = body["fids"][0].as_str().unwrap().to_string();
                            if drive.files.contains_key(&fid) {
                                ("200 OK", String::new(), serde_json::to_vec(&serde_json::json!({"code":0,"data":[{"download_url": format!("{own}/dl/{fid}")}]})).unwrap())
                            } else {
                                ("200 OK", String::new(), br#"{"code":41004,"message":"file not found"}"#.to_vec())
                            }
                        } else if let Some(fid) = url.path().strip_prefix("/dl/") {
                            drive.downloads += 1;
                            drive.ranges.push(header("range:"));
                            if drive.drop_next > 0 {
                                drive.drop_next -= 1;
                                truncate = true;
                            }
                            let bytes = drive.files.get(fid).map(|f| f.3.clone()).unwrap_or_default();
                            match header("range:").and_then(|r| r.strip_prefix("bytes=").map(str::to_string)) {
                                Some(range) => {
                                    let (a, b) = range.split_once('-').unwrap();
                                    let start: usize = a.parse().unwrap();
                                    let end: usize = b.parse().ok().unwrap_or(bytes.len() - 1).min(bytes.len() - 1);
                                    let set = format!("Content-Range: bytes {start}-{end}/{}\r\n", bytes.len());
                                    ("206 Partial Content", set, bytes[start..=end].to_vec())
                                }
                                None => ("200 OK", String::new(), bytes),
                            }
                        } else {
                            ("404 Not Found", String::new(), Vec::new())
                        }
                    };
                    let response = format!("HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n", payload.len());
                    let _ = socket.write_all(response.as_bytes()).await;
                    // 断开：说好的长度只发一半就关连接，客户端读到的就是「error decoding response body」。
                    let sent = if truncate { payload.len() / 2 } else { payload.len() };
                    let _ = socket.write_all(&payload[..sent]).await;
                });
            }
        });
        (format!("{base}/1/clouddrive"), drive)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_puus_replaces_the_old_one_and_nothing_else() {
        let cookie = "b-user-id=abc; __puus=old; __pus=keep";
        assert_eq!(
            refreshed_cookie(cookie, &["__puus=new; Path=/; HttpOnly".into()]).as_deref(),
            Some("b-user-id=abc; __puus=new; __pus=keep")
        );
        assert_eq!(refreshed_cookie(cookie, &["other=1".into()]), None);
        assert_eq!(refreshed_cookie("__puus=same", &["__puus=same".into()]), None);
        assert_eq!(unescape_html("A&amp;B &lt;1&gt;"), "A&B <1>");
        assert!(Client::new("  ").is_err());
    }
}
