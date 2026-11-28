//! 超星 / 学习通课程导入：登录、列出我的课程、列出一门课里的视频、下载视频文件。
//!
//! 走的是网页版自己用的那几个接口：
//! - 登录：`passport2.chaoxing.com/fanyalogin`，账号和密码用网页里写死的那把 AES 密钥加密后提交；
//!   学校统一认证登录的账号可以改为粘贴浏览器里的 Cookie。只存登录后的 Cookie，不存密码。
//! - 课程列表：`mooc2-ans` 的 `visit/courselistdata`（HTML）。
//! - 章节与视频：先试 `mooc1-api` 的 `gas/clazz`（JSON，章节和视频附件一次拿全）；拿不到再按
//!   章节页（HTML）列出小节，逐个读小节卡片页里的 `mArg` 找视频。
//! - 视频文件：`ananas/status/<objectId>` 给出 mp4 地址，带 Referer 直接下。
//!
//! 下载队列里一集超星视频的地址就是它的 `ananas/status` 地址，真正的 mp4 地址每次下载前现取
//! （带时效）。所有请求都过 `request_pacing`，不连发。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::pipeline::download::DownloadEvent;
use crate::pipeline::request_pacing::{pace, Platform};

/// 登录后的 Cookie 存在密钥存储里的名字。
pub const SECRET_COOKIES: &str = "chaoxing_cookies";

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
/// 网页登录页用来加密账号密码的密钥（同时用作 IV），写在超星自己的前端脚本里。
const LOGIN_AES_KEY: &[u8; 16] = b"u2oh6Vu^HWe4_AES";
const STATUS_HOST: &str = "mooc1.chaoxing.com";
const STATUS_PATH: &str = "/ananas/status/";
const PLAYER_REFERER: &str =
    "https://mooc1.chaoxing.com/ananas/modules/video/index.html?v=2023-1110-1610";
/// 一个小节最多翻几张卡片页（「视频 / 课件 / 测验」这类标签页）。
const MAX_CARD_TABS: usize = 4;

pub const LOGIN_EXPIRED: &str = "超星登录已失效，请重新登录（设置里或导入对话框里都能登）";

// ---------------------------------------------------------------------------
// 加密与 Cookie

/// AES-128-CBC + PKCS#7 + Base64，与网页登录页 `encryptByAES` 一致。
fn encrypt_login_field(plain: &str) -> String {
    use aes::cipher::{generic_array::GenericArray, BlockEncrypt, KeyInit};
    use base64::Engine as _;
    let cipher = aes::Aes128::new(GenericArray::from_slice(LOGIN_AES_KEY));
    let mut data = plain.as_bytes().to_vec();
    let pad = 16 - data.len() % 16;
    data.extend(std::iter::repeat_n(pad as u8, pad));
    let mut previous = *LOGIN_AES_KEY;
    for block in data.chunks_mut(16) {
        for (byte, prev) in block.iter_mut().zip(previous.iter()) {
            *byte ^= prev;
        }
        let block = GenericArray::from_mut_slice(block);
        cipher.encrypt_block(block);
        previous.copy_from_slice(block);
    }
    base64::engine::general_purpose::STANDARD.encode(data)
}

/// 把用户粘贴的 Cookie 整理成请求头的值：去掉「Cookie:」前缀、换行，空的键值对丢掉。
pub fn normalize_cookie_header(raw: &str) -> String {
    let raw = raw.trim();
    let raw = raw
        .strip_prefix("Cookie:")
        .or_else(|| raw.strip_prefix("cookie:"))
        .unwrap_or(raw);
    raw.split([';', '\n', '\r'])
        .map(str::trim)
        .filter(|pair| {
            pair.split_once('=')
                .is_some_and(|(k, _)| !k.trim().is_empty())
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// 把响应里的 `Set-Cookie` 合进已有的 Cookie（同名的以新的为准）。
fn merge_set_cookies<'a>(existing: &str, set_cookies: impl Iterator<Item = &'a str>) -> String {
    let mut pairs: Vec<(String, String)> = existing
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    for header in set_cookies {
        let Some((name, value)) = header.split(';').next().and_then(|kv| kv.split_once('=')) else {
            continue;
        };
        let (name, value) = (name.trim(), value.trim());
        if name.is_empty() {
            continue;
        }
        pairs.retain(|(k, _)| k != name);
        // 服务端用空值 / deleted 表示删掉这个 Cookie。
        if !value.is_empty() && value != "deleted" {
            pairs.push((name.to_string(), value.to_string()));
        }
    }
    pairs
        .into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn cookie_value<'a>(cookies: &'a str, name: &str) -> Option<&'a str> {
    cookies
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| k.trim() == name)
        .map(|(_, v)| v.trim())
}

// ---------------------------------------------------------------------------
// 请求

fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| AppError::Pipeline(format!("构造 HTTP 客户端失败：{error}")))
}

/// 被踢回登录页、或者接口直接说「请登录」：Cookie 失效了。
fn looks_logged_out(final_url: &str, body: &str) -> bool {
    let host = reqwest::Url::parse(final_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_default();
    if host.starts_with("passport2.") {
        return true;
    }
    let head: String = body.chars().take(2000).collect();
    head.contains("passport2.chaoxing.com/login")
        || head.contains("\"msg\":\"请重新登录")
        || head.contains("用户登录</title>")
}

async fn get_text(cookies: &str, url: &str, referer: Option<&str>) -> AppResult<String> {
    pace(Platform::Chaoxing).await;
    let mut request = client()?.get(url).header(reqwest::header::COOKIE, cookies);
    if let Some(referer) = referer {
        request = request.header(reqwest::header::REFERER, referer);
    }
    let response = request
        .send()
        .await
        .map_err(|error| AppError::Pipeline(format!("连不上超星：{error}")))?;
    read_text(response).await
}

async fn post_form_text(
    cookies: &str,
    url: &str,
    referer: &str,
    form: &[(&str, &str)],
) -> AppResult<String> {
    pace(Platform::Chaoxing).await;
    let response = client()?
        .post(url)
        .header(reqwest::header::COOKIE, cookies)
        .header(reqwest::header::REFERER, referer)
        .form(form)
        .send()
        .await
        .map_err(|error| AppError::Pipeline(format!("连不上超星：{error}")))?;
    read_text(response).await
}

async fn read_text(response: reqwest::Response) -> AppResult<String> {
    let status = response.status();
    let final_url = response.url().to_string();
    let body = response
        .text()
        .await
        .map_err(|error| AppError::Pipeline(format!("读取超星的返回失败：{error}")))?;
    if status == reqwest::StatusCode::UNAUTHORIZED || looks_logged_out(&final_url, &body) {
        return Err(AppError::Config(LOGIN_EXPIRED.into()));
    }
    if !status.is_success() {
        return Err(AppError::Pipeline(format!("超星返回 HTTP {status}")));
    }
    Ok(body)
}

// ---------------------------------------------------------------------------
// 登录

#[derive(Debug, Deserialize)]
struct LoginReply {
    #[serde(default)]
    status: bool,
    #[serde(default)]
    msg2: Option<String>,
    #[serde(default)]
    mes: Option<String>,
}

/// 用账号（手机号 / 学号）和密码登录，返回 Cookie 请求头的值。密码不落盘。
pub async fn login(username: &str, password: &str) -> AppResult<String> {
    let (username, password) = (username.trim(), password);
    if username.is_empty() || password.is_empty() {
        return Err(AppError::Config("请填写账号和密码".into()));
    }
    pace(Platform::Chaoxing).await;
    let uname = encrypt_login_field(username);
    let pass = encrypt_login_field(password);
    let response = client()?
        .post("https://passport2.chaoxing.com/fanyalogin")
        .header(
            reqwest::header::REFERER,
            "https://passport2.chaoxing.com/login",
        )
        .header("X-Requested-With", "XMLHttpRequest")
        .form(&[
            ("fid", "-1"),
            ("uname", uname.as_str()),
            ("password", pass.as_str()),
            ("refer", "https%3A%2F%2Fi.chaoxing.com"),
            ("t", "true"),
            ("forbidotherlogin", "0"),
            ("validate", ""),
            ("doubleFactorLogin", "0"),
            ("independentId", "0"),
        ])
        .send()
        .await
        .map_err(|error| AppError::Pipeline(format!("连不上超星登录服务：{error}")))?;
    let cookies = merge_set_cookies(
        "",
        response
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok()),
    );
    let body = response
        .text()
        .await
        .map_err(|error| AppError::Pipeline(format!("读取登录结果失败：{error}")))?;
    let reply: LoginReply = serde_json::from_str(&body).map_err(|_| {
        AppError::Pipeline("超星登录接口的返回看不懂，可能改版了；可以改用粘贴 Cookie 登录".into())
    })?;
    if !reply.status {
        let reason = reply
            .msg2
            .or(reply.mes)
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| "账号或密码不对".into());
        return Err(AppError::Config(format!("超星登录失败：{reason}")));
    }
    if cookies.is_empty() {
        return Err(AppError::Pipeline(
            "超星说登录成功了，却没有给登录凭证".into(),
        ));
    }
    Ok(cookies)
}

// ---------------------------------------------------------------------------
// 一点点 HTML

/// HTML 实体里常见的几个。
fn decode_entities(text: &str) -> String {
    let mut out = text
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'");
    out = out.replace("&amp;", "&");
    out
}

/// 页面里的一个开始标签。
struct Tag<'a> {
    /// 小写标签名。
    name: String,
    /// `<` 之后、`>` 之前的全部内容。
    inner: &'a str,
    /// 这个标签在原文里的起止位置（`>` 之后）。
    start: usize,
    end: usize,
}

impl Tag<'_> {
    fn attr(&self, name: &str) -> Option<String> {
        let bytes = self.inner.as_bytes();
        let mut search = 0;
        while let Some(found) = self.inner[search..].find(name) {
            let at = search + found;
            search = at + name.len();
            // 必须是完整的属性名：前面是空白，后面是 `=`。
            let before_ok = at == 0 || bytes[at - 1].is_ascii_whitespace();
            let rest = self.inner[at + name.len()..].trim_start();
            if !before_ok || !rest.starts_with('=') {
                continue;
            }
            let value = rest[1..].trim_start();
            let quote = value.chars().next()?;
            if quote == '"' || quote == '\'' {
                let body = &value[1..];
                let close = body.find(quote)?;
                return Some(decode_entities(&body[..close]));
            }
            let end = value
                .find(|c: char| c.is_ascii_whitespace() || c == '>')
                .unwrap_or(value.len());
            return Some(decode_entities(&value[..end]));
        }
        None
    }

    fn has_class(&self, class: &str) -> bool {
        self.attr("class")
            .is_some_and(|value| value.split_ascii_whitespace().any(|c| c == class))
    }
}

fn tags(html: &str) -> Vec<Tag<'_>> {
    let mut out = Vec::new();
    let mut cursor = 0;
    while let Some(found) = html[cursor..].find('<') {
        let at = cursor + found;
        let Some(close) = html[at..].find('>') else {
            break;
        };
        let inner = &html[at + 1..at + close];
        cursor = at + close + 1;
        let name: String = inner
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        if name.is_empty() {
            continue; // 结束标签、注释、<!DOCTYPE>
        }
        out.push(Tag {
            name,
            inner,
            start: at,
            end: cursor,
        });
    }
    out
}

/// 从 `from` 开始到下一个 `<` 之前的纯文本。
fn text_after(html: &str, from: usize) -> String {
    let rest = &html[from.min(html.len())..];
    let end = rest.find('<').unwrap_or(rest.len());
    decode_entities(rest[..end].trim())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// 课程

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChaoxingCourse {
    pub course_id: String,
    pub clazz_id: String,
    pub cpi: String,
    pub title: String,
    pub teacher: String,
}

/// 解析课程列表页。一门课一个 `div.course`，里面有隐藏的 courseId / clazzId 输入框、
/// 进课程的链接（带 cpi）、课程名和老师。还没开课、已结课不能看的（`not-open-tip`）跳过。
pub fn parse_course_list(html: &str) -> Vec<ChaoxingCourse> {
    let all = tags(html);
    let starts: Vec<usize> = all
        .iter()
        .enumerate()
        .filter(|(_, tag)| tag.name == "div" || tag.name == "li")
        .filter(|(_, tag)| tag.has_class("course"))
        .map(|(index, _)| index)
        .collect();
    let mut courses = Vec::new();
    for (n, &first) in starts.iter().enumerate() {
        let last = starts.get(n + 1).copied().unwrap_or(all.len());
        let block = &all[first..last];
        let block_text = &html[block[0].start..block.last().map_or(html.len(), |t| t.end)];
        if block_text.contains("not-open-tip") {
            continue;
        }
        let input = |class: &str| {
            block
                .iter()
                .find(|tag| tag.name == "input" && tag.has_class(class))
                .and_then(|tag| tag.attr("value"))
        };
        let course_id = input("courseId").or_else(|| block[0].attr("courseid"));
        let clazz_id = input("clazzId").or_else(|| block[0].attr("clazzid"));
        let cpi = block
            .iter()
            .filter(|tag| tag.name == "a")
            .filter_map(|tag| tag.attr("href"))
            .find_map(|href| query_value(&href, "cpi"))
            .or_else(|| block[0].attr("personid"));
        let title = block
            .iter()
            .find(|tag| tag.has_class("course-name"))
            .and_then(|tag| {
                tag.attr("title")
                    .or_else(|| Some(text_after(html, tag.end)))
            })
            .unwrap_or_default();
        let teacher = block
            .iter()
            .find(|tag| tag.name == "p" && tag.has_class("color3"))
            .and_then(|tag| {
                tag.attr("title")
                    .or_else(|| Some(text_after(html, tag.end)))
            })
            .unwrap_or_default();
        let (Some(course_id), Some(clazz_id)) = (course_id, clazz_id) else {
            continue;
        };
        if title.trim().is_empty() {
            continue;
        }
        courses.push(ChaoxingCourse {
            course_id,
            clazz_id,
            cpi: cpi.unwrap_or_default(),
            title: title.trim().to_string(),
            teacher: teacher.trim().to_string(),
        });
    }
    courses
}

fn query_value(href: &str, key: &str) -> Option<String> {
    let query = href.split_once('?')?.1;
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v.to_string())
        .filter(|v| !v.is_empty())
}

/// 列出登录账号的课程（学生身份的）。
pub async fn list_courses(cookies: &str) -> AppResult<Vec<ChaoxingCourse>> {
    let referer = "https://mooc2-ans.chaoxing.com/mooc2-ans/visit/interaction?moocDomain=https://mooc1-1.chaoxing.com/mooc-ans";
    // 先打开一次课程页：部分账号要靠它补上 mooc2-ans 域下的会话。
    let _ = get_text(cookies, referer, None).await;
    let html = post_form_text(
        cookies,
        "https://mooc2-ans.chaoxing.com/mooc2-ans/visit/courselistdata",
        referer,
        &[
            ("courseType", "1"),
            ("courseFolderId", "0"),
            ("query", ""),
            ("superstarClass", "0"),
        ],
    )
    .await?;
    Ok(parse_course_list(&html))
}

// ---------------------------------------------------------------------------
// 章节与视频

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChaoxingVideo {
    /// 下载队列里用的地址（`ananas/status/<objectId>`）。
    pub url: String,
    pub object_id: String,
    /// 「1.2 小节名」；一个小节里有几个视频时后面带「（2）」。
    pub title: String,
    /// 所在章（第一层）的名字；拿不到时为空。
    pub chapter: String,
}

pub fn video_url(object_id: &str) -> String {
    format!("https://{STATUS_HOST}{STATUS_PATH}{object_id}")
}

/// 下载队列里的地址是不是超星视频。
pub fn object_id_of(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url.trim()).ok()?;
    if parsed.host_str()? != STATUS_HOST {
        return None;
    }
    let id = parsed.path().strip_prefix(STATUS_PATH)?;
    (!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric())).then(|| id.to_string())
}

pub fn is_video_url(url: &str) -> bool {
    object_id_of(url).is_some()
}

/// 一个小节（知识点）。
#[derive(Debug, Clone, PartialEq)]
struct Point {
    id: String,
    /// 「1.2」这样的编号；拿不到时为空。
    label: String,
    name: String,
    /// 第一层的那一章叫什么。
    chapter: String,
    /// JSON 接口直接给了视频附件时在这里；None 表示要去卡片页找。
    videos: Option<Vec<String>>,
}

impl Point {
    fn title(&self) -> String {
        if self.label.is_empty() || self.name.starts_with(&self.label) {
            self.name.clone()
        } else {
            format!("{} {}", self.label, self.name)
        }
    }
}

/// 「1.10」排在「1.9」后面。
fn label_key(label: &str) -> Vec<u64> {
    label
        .split(['.', '-', ' '])
        .map(|part| part.trim().parse::<u64>().unwrap_or(u64::MAX))
        .collect()
}

/// 解析 `gas/clazz` 的 JSON：课程下所有知识点，带层级、编号和视频附件。
fn parse_clazz_json(value: &serde_json::Value) -> Vec<Point> {
    let knowledge = value["data"][0]["course"]["data"][0]["knowledge"]["data"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let as_text = |v: &serde_json::Value| match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        _ => String::new(),
    };
    let names: std::collections::HashMap<String, (String, String, String)> = knowledge
        .iter()
        .map(|k| {
            (
                as_text(&k["id"]),
                (
                    as_text(&k["name"]),
                    as_text(&k["parentnodeid"]),
                    as_text(&k["label"]),
                ),
            )
        })
        .collect();
    let chapter_of = |mut id: String| -> String {
        // 一路往上找到第一层。
        for _ in 0..8 {
            let Some((name, parent, label)) = names.get(&id) else {
                return String::new();
            };
            if parent.is_empty() || parent == "0" || !names.contains_key(parent) {
                return if label.is_empty() || name.starts_with(label.as_str()) {
                    name.clone()
                } else {
                    format!("{label} {name}")
                };
            }
            id = parent.clone();
        }
        String::new()
    };
    let mut points: Vec<(Vec<u64>, i64, Point)> = knowledge
        .iter()
        .map(|k| {
            let id = as_text(&k["id"]);
            let videos = k["attachment"]["data"].as_array().map(|items| {
                items
                    .iter()
                    .filter(|a| a["type"].as_str().is_none_or(|t| t == "video"))
                    .map(|a| as_text(&a["objectid"]))
                    .filter(|id| !id.is_empty())
                    .collect::<Vec<_>>()
            });
            let label = as_text(&k["label"]);
            let order = k["indexorder"]
                .as_i64()
                .or_else(|| k["indexOrder"].as_i64())
                .unwrap_or(i64::MAX);
            (
                label_key(&label),
                order,
                Point {
                    chapter: chapter_of(id.clone()),
                    id,
                    label,
                    name: as_text(&k["name"]).trim().to_string(),
                    videos,
                },
            )
        })
        .filter(|(_, _, point)| !point.id.is_empty())
        .collect();
    points.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    points.into_iter().map(|(_, _, point)| point).collect()
}

/// 解析课程的章节页（HTML）：每个小节是一个 `id="cur<知识点 id>"` 的元素，名字在它后面的
/// `clicktitle` / `catalog_name` 里；所在的章是 `chapter_unit` 开头那个名字。
fn parse_chapter_page(html: &str) -> Vec<Point> {
    let all = tags(html);
    let mut points = Vec::new();
    let mut chapter = String::new();
    let mut index = 0;
    while index < all.len() {
        let tag = &all[index];
        if tag.has_class("chapter_unit") {
            // 这一章的名字：章里第一个带 title 的、或第一个 catalog_name 的文字。
            chapter = all[index + 1..]
                .iter()
                .take(12)
                .take_while(|t| t.attr("id").is_none_or(|id| !id.starts_with("cur")))
                .find_map(|t| {
                    t.attr("title")
                        .filter(|v| !v.trim().is_empty())
                        .or_else(|| {
                            t.has_class("catalog_name")
                                .then(|| text_after(html, t.end))
                                .filter(|v| !v.is_empty())
                        })
                })
                .unwrap_or_default();
        }
        let id = tag
            .attr("id")
            .and_then(|id| id.strip_prefix("cur").map(str::to_string))
            .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()));
        if let Some(id) = id {
            let mut label = String::new();
            let mut name = String::new();
            for t in all[index + 1..].iter().take(16) {
                if t.attr("id").is_some_and(|other| other.starts_with("cur")) {
                    break;
                }
                if label.is_empty() && (t.has_class("catalog_sbar") || t.has_class("chapter_num")) {
                    label = text_after(html, t.end);
                }
                if name.is_empty() && (t.has_class("clicktitle") || t.has_class("catalog_name")) {
                    name = t.attr("title").unwrap_or_else(|| text_after(html, t.end));
                }
            }
            if name.is_empty() {
                name = tag.attr("title").unwrap_or_default();
            }
            if !name.trim().is_empty() {
                points.push(Point {
                    id,
                    label,
                    name: name.trim().to_string(),
                    chapter: chapter.clone(),
                    videos: None,
                });
            }
        }
        index += 1;
    }
    points
}

/// 卡片页里 `mArg = {...};` 那段 JSON 里的视频。没有 `mArg`（这一页不存在 / 没开放）返回 None。
fn parse_card_videos(html: &str) -> Option<Vec<String>> {
    let at = html.find("mArg")?;
    let rest = &html[at..];
    let open = rest.find('{')?;
    // mArg 前面也可能是 `var mArg = "";`（这一页什么都没有）。
    if rest[..open].contains(';') {
        return None;
    }
    let mut stream =
        serde_json::Deserializer::from_str(&rest[open..]).into_iter::<serde_json::Value>();
    let value = stream.next()?.ok()?;
    let videos = value["attachments"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|a| {
                    a["type"].as_str() == Some("video")
                        || a["property"]["module"].as_str() == Some("insertvideo")
                })
                .filter_map(|a| {
                    a["objectId"]
                        .as_str()
                        .or_else(|| a["property"]["objectid"].as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    Some(videos)
}

async fn points_from_api(cookies: &str, course: &ChaoxingCourse) -> AppResult<Vec<Point>> {
    let url = format!(
        "https://mooc1-api.chaoxing.com/gas/clazz?id={}&personid={}&fields=id,name,course.fields(id,name,knowledge.fields(id,name,indexOrder,parentnodeid,status,layer,label,attachment.fields(id,type,objectid,extension).type(video)))&view=json",
        course.clazz_id, course.cpi
    );
    let body = get_text(cookies, &url, None).await?;
    let value: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| AppError::Pipeline("章节接口的返回不是 JSON".into()))?;
    Ok(parse_clazz_json(&value))
}

async fn points_from_page(cookies: &str, course: &ChaoxingCourse) -> AppResult<Vec<Point>> {
    let url = format!(
        "https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid={}&clazzid={}&cpi={}&ut=s",
        course.course_id, course.clazz_id, course.cpi
    );
    let html = get_text(cookies, &url, None).await?;
    Ok(parse_chapter_page(&html))
}

async fn card_videos(
    cookies: &str,
    course: &ChaoxingCourse,
    point: &Point,
) -> AppResult<Vec<String>> {
    let mut found = Vec::new();
    for num in 0..MAX_CARD_TABS {
        let url = format!(
            "https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid={}&courseid={}&knowledgeid={}&num={num}&ut=s&cpi={}&v=20160407-3&mooc2=1",
            course.clazz_id, course.course_id, point.id, course.cpi
        );
        let html = get_text(cookies, &url, None).await?;
        match parse_card_videos(&html) {
            Some(videos) => found.extend(videos),
            None => break,
        }
    }
    Ok(found)
}

/// 把小节和它们的视频摊平成导入清单：同一个视频（objectId）只出现一次。
fn videos_of(points: &[(Point, Vec<String>)]) -> Vec<ChaoxingVideo> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (point, objects) in points {
        let objects: Vec<&String> = objects
            .iter()
            .filter(|id| seen.insert((*id).clone()))
            .collect();
        let many = objects.len() > 1;
        for (n, object_id) in objects.into_iter().enumerate() {
            let title = if many {
                format!("{}（{}）", point.title(), n + 1)
            } else {
                point.title()
            };
            out.push(ChaoxingVideo {
                url: video_url(object_id),
                object_id: object_id.clone(),
                title,
                chapter: point.chapter.clone(),
            });
        }
    }
    out
}

/// 列出一门课里的全部视频（按章节顺序）。`on_progress(已看小节, 小节总数)`。
pub async fn list_videos(
    cookies: &str,
    course: &ChaoxingCourse,
    on_progress: &(dyn Fn(usize, usize) + Send + Sync),
) -> AppResult<Vec<ChaoxingVideo>> {
    let mut points = match points_from_api(cookies, course).await {
        Ok(points) if !points.is_empty() => points,
        Err(AppError::Config(message)) => return Err(AppError::Config(message)),
        Ok(_) | Err(_) => Vec::new(),
    };
    if points.is_empty() {
        points = points_from_page(cookies, course).await?;
    }
    if points.is_empty() {
        return Err(AppError::Pipeline(
            "没读到这门课的章节（可能还没开课，或者超星改版了）".into(),
        ));
    }
    let total = points.len();
    let mut resolved = Vec::with_capacity(total);
    for (done, point) in points.into_iter().enumerate() {
        on_progress(done, total);
        let videos = match &point.videos {
            Some(videos) => videos.clone(),
            None => card_videos(cookies, course, &point).await?,
        };
        resolved.push((point, videos));
    }
    on_progress(total, total);
    Ok(videos_of(&resolved))
}

// ---------------------------------------------------------------------------
// 下载

#[derive(Debug, Clone, PartialEq)]
pub struct Media {
    pub url: String,
    pub filename: String,
}

/// 解析 `ananas/status` 的返回。高清优先：课件上的字要看得清。
fn parse_status(value: &serde_json::Value) -> AppResult<Media> {
    if value["status"].as_str().is_some_and(|s| s != "success") {
        return Err(AppError::Pipeline(format!(
            "超星说这个视频暂时不能下载（{}）",
            value["status"].as_str().unwrap_or_default()
        )));
    }
    let url = ["httphd", "http", "httpshd"]
        .iter()
        .filter_map(|key| value[*key].as_str())
        .find(|url| url.starts_with("http"))
        .ok_or_else(|| AppError::Pipeline("超星没有给这个视频的下载地址".into()))?;
    let filename = value["filename"]
        .as_str()
        .map(sanitize_filename)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "超星视频.mp4".into());
    Ok(Media {
        url: url.to_string(),
        filename,
    })
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| {
            if "/\\:*?\"<>|".contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('.').trim().to_string();
    if cleaned.is_empty() {
        return cleaned;
    }
    if cleaned.contains('.') {
        cleaned
    } else {
        format!("{cleaned}.mp4")
    }
}

/// 现取一次 mp4 地址（地址带时效，每次下载前取）。
pub async fn resolve_media(cookies: &str, object_id: &str) -> AppResult<Media> {
    let fid = cookie_value(cookies, "fid").unwrap_or("0");
    let url = format!(
        "{}?k={fid}&flag=normal&_dc={}",
        video_url(object_id),
        chrono::Utc::now().timestamp_millis()
    );
    let body = get_text(cookies, &url, Some(PLAYER_REFERER)).await?;
    let value: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| AppError::Pipeline("超星视频信息的返回不是 JSON".into()))?;
    parse_status(&value)
}

const MAX_FRUITLESS_ATTEMPTS: u32 = 6;
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

fn free_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, "mp4"));
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}).{ext}")))
        .find(|path| !path.exists())
        .expect("总能找到一个没用过的名字")
}

/// 下载一个超星视频到 `out_dir`，断了从断点接着下。`begin_import` 见 [`crate::pipeline::download::download`]。
pub async fn download(
    cookies: &str,
    url: &str,
    out_dir: &Path,
    staging: &Path,
    on_event: &(dyn Fn(DownloadEvent) + Send + Sync),
    begin_import: &(dyn Fn() -> bool + Send + Sync),
) -> AppResult<PathBuf> {
    let object_id =
        object_id_of(url).ok_or_else(|| AppError::Config(format!("不是超星视频地址：{url}")))?;
    std::fs::create_dir_all(staging)?;
    std::fs::create_dir_all(out_dir)?;
    let partial = staging.join(format!("{object_id}.part"));
    let mut downloaded = std::fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);
    let mut total: Option<u64> = None;
    let mut filename = String::new();
    let started = Instant::now();
    let started_at = downloaded;
    let mut last_report = Instant::now() - Duration::from_secs(1);
    let mut fruitless = 0u32;
    let http = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| AppError::Pipeline(error.to_string()))?;
    loop {
        if total.is_some_and(|total| downloaded >= total) {
            break;
        }
        // 每次连接前现取地址：mp4 地址带时效，断开以后旧地址可能不认了。
        let media = resolve_media(cookies, &object_id).await?;
        filename = media.filename.clone();
        let before = downloaded;
        let mut request = http
            .get(&media.url)
            .header(reqwest::header::REFERER, "https://mooc1.chaoxing.com/");
        if downloaded > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={downloaded}-"));
        }
        let outcome: Result<bool, String> = async {
            let mut response = request.send().await.map_err(|e| e.to_string())?;
            let status = response.status();
            if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && downloaded > 0 {
                return Ok(true);
            }
            if !status.is_success() {
                return Err(format!("HTTP {status}"));
            }
            let resumed = status == reqwest::StatusCode::PARTIAL_CONTENT && downloaded > 0;
            if !resumed {
                downloaded = 0;
            }
            let from_range = response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.rsplit('/').next())
                .and_then(|v| v.parse::<u64>().ok());
            if let Some(size) =
                from_range.or_else(|| response.content_length().map(|l| l + downloaded))
            {
                total = Some(size);
            }
            use std::io::Write as _;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .append(resumed)
                .truncate(!resumed)
                .open(&partial)
                .map_err(|e| e.to_string())?;
            loop {
                let chunk = tokio::time::timeout(STALL_TIMEOUT, response.chunk())
                    .await
                    .map_err(|_| "一分钟没收到数据".to_string())?
                    .map_err(|e| e.to_string())?;
                let Some(chunk) = chunk else {
                    return Ok(total.is_none_or(|total| downloaded >= total));
                };
                file.write_all(&chunk).map_err(|e| e.to_string())?;
                downloaded += chunk.len() as u64;
                if last_report.elapsed() >= Duration::from_millis(400) {
                    last_report = Instant::now();
                    let seconds = started.elapsed().as_secs_f64().max(0.001);
                    let speed = downloaded.saturating_sub(started_at) as f64 / seconds;
                    let eta = total
                        .filter(|_| speed > 0.0)
                        .map(|total| (total.saturating_sub(downloaded) as f64 / speed) as u64);
                    on_event(DownloadEvent::Progress {
                        downloaded,
                        total,
                        speed: Some(speed),
                        eta,
                    });
                }
            }
        }
        .await;
        let outcome = match outcome {
            Ok(false) => Err("连接提前断开了".to_string()),
            other => other,
        };
        match outcome {
            Ok(_) => break,
            Err(reason) => {
                fruitless = if downloaded > before {
                    0
                } else {
                    fruitless + 1
                };
                if fruitless >= MAX_FRUITLESS_ATTEMPTS {
                    return Err(AppError::Pipeline(format!(
                        "超星视频下载中断（重试了 {MAX_FRUITLESS_ATTEMPTS} 次都没接上）：{reason}。稍后在下载队列里点重试，会从断开的地方接着下"
                    )));
                }
                tracing::warn!(%reason, downloaded, "超星视频下载断了，接着下");
                tokio::time::sleep(Duration::from_secs(2) * fruitless.max(1)).await;
            }
        }
    }
    on_event(DownloadEvent::Progress {
        downloaded,
        total: Some(downloaded),
        speed: None,
        eta: Some(0),
    });
    if !begin_import() {
        let _ = std::fs::remove_dir_all(staging);
        return Err(AppError::Pipeline(
            crate::pipeline::download::DOWNLOAD_CANCELED_MESSAGE.into(),
        ));
    }
    let destination = free_path(out_dir, &filename);
    if std::fs::rename(&partial, &destination).is_err() {
        std::fs::copy(&partial, &destination)?;
        let _ = std::fs::remove_file(&partial);
    }
    let _ = std::fs::remove_dir_all(staging);
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_fields_are_encrypted_like_the_web_page() {
        // 与网页 `encryptByAES("13800000000", "u2oh6Vu^HWe4_AES")` 的结果一致：
        // 用同一把密钥做 IV 的 AES-128-CBC，PKCS#7 补齐，Base64 输出。
        use aes::cipher::{generic_array::GenericArray, BlockDecrypt, KeyInit};
        use base64::Engine as _;
        let encrypted = encrypt_login_field("13800000000");
        let mut bytes = base64::engine::general_purpose::STANDARD
            .decode(&encrypted)
            .unwrap();
        assert_eq!(bytes.len(), 16, "11 个字节补齐成一个块");
        let cipher = aes::Aes128::new(GenericArray::from_slice(LOGIN_AES_KEY));
        cipher.decrypt_block(GenericArray::from_mut_slice(&mut bytes[..16]));
        for (byte, iv) in bytes.iter_mut().zip(LOGIN_AES_KEY.iter()) {
            *byte ^= iv;
        }
        assert_eq!(&bytes[..11], b"13800000000");
        assert!(bytes[11..].iter().all(|b| *b == 5));
        // 正好 16 字节时要再补一整块。
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(encrypt_login_field("0123456789abcdef"))
                .unwrap()
                .len(),
            32
        );
    }

    #[test]
    fn pasted_cookies_are_tidied_into_a_header() {
        assert_eq!(
            normalize_cookie_header("Cookie: fid=123; _uid=9 ;\n UID=9; ;bad"),
            "fid=123; _uid=9; UID=9"
        );
    }

    #[test]
    fn set_cookie_headers_replace_and_delete_by_name() {
        let merged = merge_set_cookies(
            "fid=1; JSESSIONID=old",
            [
                "JSESSIONID=new; Path=/; HttpOnly",
                "_uid=42; Domain=.chaoxing.com",
                "fid=deleted; Max-Age=0",
            ]
            .into_iter(),
        );
        assert_eq!(merged, "JSESSIONID=new; _uid=42");
        assert_eq!(cookie_value("a=1; fid=77", "fid"), Some("77"));
    }

    #[test]
    fn being_bounced_to_the_login_page_means_the_cookie_expired() {
        assert!(looks_logged_out(
            "https://passport2.chaoxing.com/login?refer=x",
            ""
        ));
        assert!(looks_logged_out(
            "https://mooc2-ans.chaoxing.com/x",
            "<script>location.href='https://passport2.chaoxing.com/login'</script>"
        ));
        assert!(!looks_logged_out(
            "https://mooc2-ans.chaoxing.com/x",
            "<div class=\"course\">"
        ));
    }

    const COURSE_LIST: &str = r##"
<ul class="course-list">
  <li class="course clearfix" courseid="111" clazzid="222" personid="333" id="course_111_222">
    <input type="hidden" class="courseId" value="111" />
    <input type="hidden" class="clazzId" value="222" />
    <div class="course-cover"><a href="https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=111&amp;clazzid=222&amp;cpi=333&amp;ismooc2=1" target="_blank"><img src="x.png"></a></div>
    <div class="course-info">
      <h3 class="inlineBlock"><a href="#"><span class="course-name overHidden2" title="机器学习 &amp; 数据挖掘">机器学习 &amp; 数据挖掘</span></a></h3>
      <p class="margint10 line2 color2" title="2024 秋">2024 秋</p>
      <p class="line2 color3" title="张老师">张老师</p>
    </div>
  </li>
  <li class="course clearfix" courseid="444" clazzid="555">
    <input type="hidden" class="courseId" value="444" />
    <input type="hidden" class="clazzId" value="555" />
    <a class="not-open-tip" href="javascript:;">课程未开放</a>
    <span class="course-name" title="还没开的课">还没开的课</span>
  </li>
  <li class="course clearfix">
    <input type="hidden" class="courseId" value="666" />
    <input type="hidden" class="clazzId" value="777" />
    <a href="/visit?courseid=666&clazzid=777&cpi=888">进入</a>
    <span class="course-name">线性代数</span>
    <p class="color3">李老师</p>
  </li>
</ul>"##;

    #[test]
    fn the_course_list_page_yields_open_courses_only() {
        let courses = parse_course_list(COURSE_LIST);
        assert_eq!(
            courses,
            vec![
                ChaoxingCourse {
                    course_id: "111".into(),
                    clazz_id: "222".into(),
                    cpi: "333".into(),
                    title: "机器学习 & 数据挖掘".into(),
                    teacher: "张老师".into(),
                },
                ChaoxingCourse {
                    course_id: "666".into(),
                    clazz_id: "777".into(),
                    cpi: "888".into(),
                    title: "线性代数".into(),
                    teacher: "李老师".into(),
                },
            ]
        );
    }

    #[test]
    fn the_clazz_api_gives_points_in_label_order_with_their_videos() {
        let value = serde_json::json!({"data":[{"course":{"data":[{"knowledge":{"data":[
            {"id":2,"name":"梯度下降","label":"1.10","parentnodeid":1,"layer":2,
             "attachment":{"data":[{"type":"video","objectid":"abc"},{"type":"video","objectid":"def"}]}},
            {"id":1,"name":"优化方法","label":"1","parentnodeid":0,"layer":1,"attachment":{"data":[]}},
            {"id":3,"name":"学习率","label":"1.9","parentnodeid":1,"layer":2,
             "attachment":{"data":[{"type":"video","objectid":"ghi"}]}}
        ]}}]}}]});
        let points = parse_clazz_json(&value);
        let titles: Vec<String> = points.iter().map(Point::title).collect();
        assert_eq!(titles, ["1 优化方法", "1.9 学习率", "1.10 梯度下降"]);
        assert_eq!(points[2].chapter, "1 优化方法");
        assert_eq!(
            points[2].videos.as_deref(),
            Some(&["abc".to_string(), "def".to_string()][..])
        );

        let resolved: Vec<(Point, Vec<String>)> = points
            .into_iter()
            .map(|p| {
                let v = p.videos.clone().unwrap_or_default();
                (p, v)
            })
            .collect();
        let videos = videos_of(&resolved);
        let titles: Vec<&str> = videos.iter().map(|v| v.title.as_str()).collect();
        assert_eq!(
            titles,
            ["1.9 学习率", "1.10 梯度下降（1）", "1.10 梯度下降（2）"]
        );
        assert_eq!(
            videos[0].url,
            "https://mooc1.chaoxing.com/ananas/status/ghi"
        );
    }

    #[test]
    fn without_attachment_data_points_fall_back_to_card_pages() {
        let value = serde_json::json!({"data":[{"course":{"data":[{"knowledge":{"data":[
            {"id":"9","name":"绪论","label":"1","parentnodeid":"0"}
        ]}}]}}]});
        assert_eq!(parse_clazz_json(&value)[0].videos, None);
    }

    #[test]
    fn the_chapter_page_lists_points_under_their_chapter() {
        let html = r#"
<div class="chapter_unit">
  <div class="catalog_name newCatalog_name"><span class="catalog_sbar">1</span><span title="第一章 绪论">第一章 绪论</span></div>
  <ul>
    <li><div class="chapter_item" id="cur1001" title="课程介绍">
      <span class="catalog_sbar">1.1</span>
      <div class="catalog_name"><a class="clicktitle">课程介绍</a></div></div></li>
    <li><div class="chapter_item" id="cur1002">
      <span class="catalog_sbar">1.2</span>
      <a class="clicktitle"> 什么是 机器学习 </a></div></li>
  </ul>
</div>
<div class="chapter_unit">
  <div class="catalog_name"><span title="第二章 回归">第二章 回归</span></div>
  <li><div id="cur2001"><span class="catalog_sbar">2.1</span><a class="clicktitle">线性回归</a></div></li>
</div>"#;
        let points = parse_chapter_page(html);
        let got: Vec<(String, String, String)> = points
            .iter()
            .map(|p| (p.id.clone(), p.title(), p.chapter.clone()))
            .collect();
        assert_eq!(
            got,
            [
                ("1001".into(), "1.1 课程介绍".into(), "第一章 绪论".into()),
                (
                    "1002".into(),
                    "1.2 什么是 机器学习".into(),
                    "第一章 绪论".into()
                ),
                ("2001".into(), "2.1 线性回归".into(), "第二章 回归".into()),
            ]
        );
    }

    #[test]
    fn card_pages_yield_their_videos_and_signal_when_there_are_no_more_tabs() {
        let html = r#"<script>
            try{ mArg = {"attachments":[
                {"type":"video","objectId":"obj1","property":{"name":"1.1.mp4"}},
                {"type":"document","objectId":"doc1"},
                {"property":{"module":"insertvideo","objectid":"obj2"}}
            ],"defaults":{"ktoken":"k"}};}catch(e){}
        </script>"#;
        assert_eq!(
            parse_card_videos(html),
            Some(vec!["obj1".into(), "obj2".into()])
        );
        assert_eq!(parse_card_videos("<html>章节未开放</html>"), None);
        assert_eq!(parse_card_videos(r#"var mArg = ""; mArg = 1;"#), None);
    }

    #[test]
    fn status_prefers_the_hd_link_and_reports_unavailable_videos() {
        let media = parse_status(&serde_json::json!({
            "status":"success","filename":"第1讲:绪论","http":"https://s1.ananas.chaoxing.com/sd.mp4",
            "httphd":"https://s1.ananas.chaoxing.com/hd.mp4"
        }))
        .unwrap();
        assert_eq!(media.url, "https://s1.ananas.chaoxing.com/hd.mp4");
        assert_eq!(media.filename, "第1讲_绪论.mp4");
        assert!(parse_status(&serde_json::json!({"status":"waiting"})).is_err());
    }

    #[test]
    fn only_status_urls_count_as_chaoxing_videos() {
        assert_eq!(
            object_id_of("https://mooc1.chaoxing.com/ananas/status/a1b2c3"),
            Some("a1b2c3".into())
        );
        assert!(!is_video_url(
            "https://mooc1.chaoxing.com/ananas/status/../x"
        ));
        assert!(!is_video_url("https://www.bilibili.com/video/BV1"));
    }
}
