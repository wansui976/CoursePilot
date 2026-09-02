//! B 站弹幕与评论区的抓取与解析。
//!
//! 弹幕：`comment.bilibili.com/{cid}.xml` 返回结构化 XML，这里把每条 `<d p="...">`
//! 解析成结构化行存库，供离线播放时按时间窗口查询。评论区走 B 站 reply 接口。
//! 两者都只对 `bilibili` 视频有效；本地视频与 URL 视频没有这些数据。
//! 抓取是「尽力而为」：失败只记日志、返回空，不让播放器报错。

use crate::error::{AppError, AppResult};
use crate::db::Db;
use serde::Serialize;
use std::io::Read;

const BILIBILI_REFERER: &str = "https://www.bilibili.com/";
const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
/// 评论接口对完全无 cookie 的请求返回 -352 风控拦截。网页端首次访问也会被种一个
/// buvid3，用户没配 cookies 时带一个兜底值即可正常拿到评论（实测值本身不校验）。
const FALLBACK_COOKIE: &str = "buvid3=5D7EE8C8-5A1F-4F1F-B0A1-2E3D4C5B6A7Dinfoc";

/// 解析 Netscape 格式 cookies 文件内容（yt-dlp 导出），拼成 `name=value; ...`
/// 的 Cookie 头。跳过注释行与残缺行；`#HttpOnly_` 前缀的行是合法 cookie，不算注释。
fn parse_netscape_cookies(content: &str) -> Option<String> {
    let mut pairs = Vec::new();
    for line in content.lines() {
        let line = line.strip_prefix("#HttpOnly_").unwrap_or(line);
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 7 {
            continue;
        }
        let (name, value) = (cols[5].trim(), cols[6].trim());
        if !name.is_empty() && !value.is_empty() {
            pairs.push(format!("{name}={value}"));
        }
    }
    (!pairs.is_empty()).then(|| pairs.join("; "))
}

/// 「bilibili_cookies」设置里存的是 cookies **文件路径**（拷给 yt-dlp 用），
/// 不是 cookie 本身——直接把它塞进 `Cookie` 头会以无凭证身份被风控拦下。
/// 这里统一转成可用的 Cookie 头：路径 → 解析 Netscape 文件；值本身就是
/// cookie 字符串时（兼容）原样使用；读不到时返回 None，请求层会退回兜底 buvid3。
pub fn cookie_header_from_setting(raw: Option<&str>) -> Option<String> {
    let value = raw?.trim();
    if value.is_empty() {
        return None;
    }
    if value.contains('=') && !value.contains('/') {
        return Some(value.to_string());
    }
    let content = std::fs::read_to_string(value).ok()?;
    parse_netscape_cookies(&content)
}

/// 一条弹幕。前端按 `start_ms` 排期、`mode` 决定滚动/顶部/底部。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DanmakuEntry {
    pub mode: String,
    pub start_ms: i64,
    pub text: String,
    pub color: Option<String>,
    pub font_size: Option<i64>,
}

/// 一条评论：根评论（parent_rpid 为 None）或楼中楼回复。reply_count 是根评论的
/// 回复总数。direct_parent_rpid 是「回复另一条回复」时的直接父回复（楼中楼中楼），
/// 与 parent_rpid（归属的根评论）分开。B 站 rpid 超出 JS 安全整数范围，统一按
/// 字符串存取。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CommentEntry {
    pub rpid: Option<String>,
    pub author: String,
    pub text: String,
    pub like_count: i64,
    pub ctime: i64,
    pub parent_rpid: Option<String>,
    pub reply_count: i64,
    pub direct_parent_rpid: Option<String>,
    pub avatar: Option<String>,
}

/// 一个 B 站表情：评论文本里的 `[doge]` 标记 → 图片 URL。size 1 小表情（内联）、
/// 2 大表情。前端按标记替换成图片；没收录的标记原样显示文本。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct VideoEmote {
    pub text: String,
    pub url: String,
    pub size: i64,
}

/// 从源 URI 里取出 BV 号（形如 `BV1xx411c7mD`）。
pub fn bvid_from_url(url: &str) -> Option<String> {
    let token = url
        .split(['/', '?', '&', '#'])
        .find(|part| part.starts_with("BV"))?;
    let bv: String = token
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect();
    (bv.starts_with("BV") && bv.len() >= 10).then_some(bv)
}

/// 弹幕类型的数字代号 → 字符串。1~3 滚动、4 底部、5 顶部；6/7 罕见（反转/高级）按滚动处理。
fn danmaku_mode(mode: i64) -> &'static str {
    match mode {
        4 => "bottom",
        5 => "top",
        _ => "scroll",
    }
}

/// 解码 XML 实体：`&amp; &lt; &gt; &quot; &apos;` 及 `&#nnn;`。
fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + 1..];
        let Some(semi) = after.find(';') else {
            out.push('&');
            rest = after;
            continue;
        };
        let code = &after[..semi];
        let decoded: Option<char> = match code {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => code
                .strip_prefix('#')
                .and_then(|n| n.parse::<u32>().ok())
                .and_then(char::from_u32),
        };
        match decoded {
            Some(ch) => {
                out.push(ch);
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// 把 `p` 属性 CSV 与弹幕文本解析成一条记录。文本为空则丢弃。
fn parse_danmaku_attrs(attrs: &str, raw_text: &str) -> Option<DanmakuEntry> {
    let mut fields = attrs.split(',');
    let secs: f64 = fields.next()?.trim().parse().ok()?;
    let mode_raw: i64 = fields
        .next()
        .unwrap_or("1")
        .trim()
        .parse()
        .unwrap_or(1);
    let font_size: i64 = fields
        .next()
        .unwrap_or("25")
        .trim()
        .parse()
        .unwrap_or(25);
    let color: i64 = fields
        .next()
        .unwrap_or("16777215")
        .trim()
        .parse()
        .unwrap_or(16777215);
    let text = decode_entities(raw_text.trim());
    if text.is_empty() {
        return None;
    }
    Some(DanmakuEntry {
        mode: danmaku_mode(mode_raw).to_string(),
        start_ms: (secs * 1000.0).round() as i64,
        text,
        color: Some(format!("#{:06x}", color as u32)),
        font_size: Some(font_size),
    })
}

/// 解析 B 站弹幕 XML（`<i><d p="...">text</d>...</i>`），纯函数，可单测。
pub fn parse_danmaku_xml(xml: &str) -> Vec<DanmakuEntry> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while let Some(gap) = xml[pos..].find("<d ") {
        let i = pos + gap;
        let tag = &xml[i..];
        let Some(start_rel) = tag.find("p=\"") else {
            pos = i + 3;
            continue;
        };
        let p_start = i + start_rel + 3;
        let rest_p = &xml[p_start..];
        let Some(len) = rest_p.find('"') else {
            pos = i + 3;
            continue;
        };
        let attrs = &rest_p[..len];
        let body_start = p_start + len + 1;
        let body = &xml[body_start..];
        let Some(gt) = body.find('>') else {
            pos = i + 3;
            continue;
        };
        let text_start = body_start + gt + 1;
        let tail = &xml[text_start..];
        let Some(d_end) = tail.find("</d>") else {
            break;
        };
        if let Some(entry) = parse_danmaku_attrs(attrs, &tail[..d_end]) {
            out.push(entry);
        }
        pos = text_start + d_end + 4;
    }
    out
}

/// 请求 B 站开放接口；尽量带浏览器 UA / Referer，转发用户已保存的 cookies。
async fn http_get(url: &str, cookies: Option<&str>) -> AppResult<(reqwest::StatusCode, String)> {
    let (status, body) = http_get_bytes(url, cookies).await?;
    Ok((status, String::from_utf8_lossy(&body).into_owned()))
}

/// 通过 `view` 接口拿到视频的 aid 与 cid。
async fn bilibili_view(bvid: &str, cookies: Option<&str>) -> AppResult<(String, String)> {
    let url = format!("https://api.bilibili.com/x/web-interface/view?bvid={bvid}");
    let (status, body) = http_get(&url, cookies).await?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        AppError::Pipeline(format!("bilibili view decode: {e}；响应：{}", truncate(&body, 300)))
    })?;
    let code = v["code"].as_i64().unwrap_or(-1);
    let message = v["message"].as_str().unwrap_or("");
    if !status.is_success() || code != 0 {
        return Err(AppError::Pipeline(format!(
            "bilibili view 失败：{code} {message}（请检查视频是否为公开可见）"
        )));
    }
    let cid = v["data"]["cid"].as_i64().unwrap_or(0);
    let aid = v["data"]["aid"].as_i64().unwrap_or(0);
    if cid == 0 {
        return Err(AppError::Pipeline("bilibili view 响应缺少 cid".into()));
    }
    Ok((aid.to_string(), cid.to_string()))
}

fn truncate(s: &str, max_chars: usize) -> String {
    let t: String = s.chars().take(max_chars).collect();
    if s.chars().count() > max_chars {
        format!("{t}…")
    } else {
        t
    }
}

/// 解码弹幕接口的响应体。该接口无条件返回压缩数据（无视 `Accept-Encoding`），
/// 且 `content-encoding: deflate` 里装的是 **raw deflate**——不按 RFC 7230 用
/// zlib 包装，reqwest（未开解压特性）拿到的就是压缩字节。依次尝试
/// 明文 → raw deflate → zlib 包装，哪层成功用哪层；都不行时按有损 UTF-8 收尾，
/// 让上层解析自然得到 0 条，而不是报错。
fn decode_danmaku_body(raw: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(raw) {
        return text.to_string();
    }
    let mut decoders: Vec<Box<dyn Read>> = vec![
        Box::new(flate2::read::DeflateDecoder::new(raw)),
        Box::new(flate2::read::ZlibDecoder::new(raw)),
    ];
    for decoder in decoders.iter_mut() {
        let mut out = Vec::new();
        if decoder.read_to_end(&mut out).is_ok() {
            return String::from_utf8_lossy(&out).into_owned();
        }
    }
    String::from_utf8_lossy(raw).into_owned()
}

/// 抓取某视频的弹幕 XML（按 cid）。响应体是压缩字节，解压后才是 XML 文本。
pub async fn fetch_danmaku_xml(cid: &str, cookies: Option<&str>) -> AppResult<String> {
    let url = format!("https://comment.bilibili.com/{cid}.xml");
    let (status, body) = http_get_bytes(&url, cookies).await?;
    if !status.is_success() {
        return Err(AppError::Pipeline(format!(
            "弹幕抓取失败：{}",
            status.as_u16()
        )));
    }
    Ok(decode_danmaku_body(&body))
}

/// 底层请求：带浏览器 UA / Referer；cookies 为空时兜底一个 buvid3，
/// 否则评论接口会被 -352 风控拦下（其余接口忽略该 cookie，无副作用）。
/// 返回原始字节——弹幕响应是压缩数据，`text()` 会损坏。
async fn http_get_bytes(
    url: &str,
    cookies: Option<&str>,
) -> AppResult<(reqwest::StatusCode, Vec<u8>)> {
    let client = reqwest::Client::new();
    let mut req = client
        .get(url)
        .header("User-Agent", BROWSER_USER_AGENT)
        .header("Referer", BILIBILI_REFERER)
        .timeout(std::time::Duration::from_secs(20));
    match cookies {
        Some(c) if !c.trim().is_empty() => req = req.header("Cookie", c),
        _ => req = req.header("Cookie", FALLBACK_COOKIE),
    }
    let resp = req
        .send()
        .await
        .map_err(|e| AppError::Pipeline(format!("bilibili request: {e}")))?;
    let status = resp.status();
    let body = resp
        .bytes()
        .await
        .map_err(|e| AppError::Pipeline(format!("bilibili read body: {e}")))?;
    Ok((status, body.to_vec()))
}

/// 全量评论的翻页上限：根评论 ≤ 100 页 × 20 条，楼中楼每个根评论 ≤ 10 页、
/// 全程 ≤ 400 次请求。「所有评论都能看到」和「热门视频抓上一小时/触发风控」
/// 之间取的界；普通视频（几百条评论）远够不到。
const MAX_ROOT_PAGES: usize = 100;
const MAX_REPLY_PAGES_PER_ROOT: usize = 10;
const MAX_REPLY_REQUESTS: usize = 400;
/// 翻页间的小停顿：一次抓几十上百页，不加延迟容易撞 -412 风控。
const FETCH_DELAY_MS: u64 = 100;

/// 解析 reply 系列接口里的一条评论（根评论与楼中楼同构）。
/// 楼中楼的 `root` 字段指向所属根评论；根评论该字段为 0 → parent 为 None。
fn parse_comment(r: &serde_json::Value) -> Option<(String, CommentEntry)> {
    let rpid = r["rpid"].as_u64().filter(|v| *v != 0)?.to_string();
    let text = r["content"]["message"].as_str().unwrap_or("").trim();
    if text.is_empty() {
        return None;
    }
    let entry = CommentEntry {
        rpid: Some(rpid.clone()),
        author: r["member"]["uname"].as_str().unwrap_or("").to_string(),
        text: text.to_string(),
        like_count: r["like"].as_i64().unwrap_or(0),
        ctime: r["ctime"].as_i64().unwrap_or(0),
        parent_rpid: r["root"]
            .as_u64()
            .filter(|v| *v != 0)
            .map(|v| v.to_string()),
        reply_count: r["rcount"].as_i64().unwrap_or(0),
        direct_parent_rpid: r["parent"]
            .as_u64()
            .filter(|v| *v != 0 && v.to_string() != rpid)
            .map(|v| v.to_string()),
        avatar: r["member"]["avatar"]
            .as_str()
            .filter(|url| !url.trim().is_empty())
            .map(str::to_string),
    };
    Some((rpid, entry))
}

/// 从 reply 系列响应收集表情映射（`data.emote`：标记 → URL/尺寸）。
/// 每页响应会带上该页评论用到的全部表情，翻页收集的并集即覆盖整段评论区。
fn parse_emotes(v: &serde_json::Value) -> Vec<VideoEmote> {
    v["data"]["emote"]
        .as_object()
        .map(|map| {
            map.iter()
                .filter_map(|(text, e)| {
                    let url = e["url"]
                        .as_str()
                        .filter(|u| !u.trim().is_empty())
                        .or_else(|| e["gif_url"].as_str())?;
                    Some(VideoEmote {
                        text: text.to_string(),
                        url: url.to_string(),
                        size: e["size"].as_i64().unwrap_or(1),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 抓取某视频的**全部根评论**（reply/main 按热度 cursor 翻页），顺路收集表情映射。
/// 尽力而为：某页失败就停在那里，返回已拿到的部分。
async fn fetch_all_root_comments(
    aid: &str,
    cookies: Option<&str>,
) -> (Vec<(String, CommentEntry)>, Vec<VideoEmote>) {
    let mut out = Vec::new();
    let mut emotes = Vec::new();
    let mut next: i64 = 0;
    for _page in 0..MAX_ROOT_PAGES {
        let url = format!(
            "https://api.bilibili.com/x/v2/reply/main?oid={aid}&type=1&mode=3&next={next}"
        );
        let Ok((status, body)) = http_get(&url, cookies).await else {
            break;
        };
        if !status.is_success() {
            break;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) else {
            break;
        };
        if v["code"].as_i64() != Some(0) {
            tracing::warn!(
                code = v["code"].as_i64().unwrap_or(-1),
                message = v["message"].as_str().unwrap_or(""),
                "评论翻页被接口拒绝，停止"
            );
            break;
        }
        if let Some(replies) = v["data"]["replies"].as_array() {
            for r in replies {
                if let Some(entry) = parse_comment(r) {
                    out.push(entry);
                }
            }
        }
        emotes.extend(parse_emotes(&v));
        let cursor = &v["data"]["cursor"];
        if cursor["is_end"].as_bool().unwrap_or(true) {
            break;
        }
        next = cursor["next"].as_i64().unwrap_or(0);
        tokio::time::sleep(std::time::Duration::from_millis(FETCH_DELAY_MS)).await;
    }
    (out, emotes)
}

/// 抓取一条根评论的完整楼中楼（reply/reply 按时间翻页），顺路收集表情映射。
/// `budget` 是跨所有根评论共享的请求预算，超了就停——宁缺勿封号。
async fn fetch_comment_replies(
    aid: &str,
    root_rpid: &str,
    cookies: Option<&str>,
    budget: &mut usize,
) -> (Vec<CommentEntry>, Vec<VideoEmote>) {
    let mut out = Vec::new();
    let mut emotes = Vec::new();
    for pn in 1..=MAX_REPLY_PAGES_PER_ROOT {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        let url = format!(
            "https://api.bilibili.com/x/v2/reply/reply?oid={aid}&type=1&root={root_rpid}&pn={pn}&ps=20"
        );
        let Ok((status, body)) = http_get(&url, cookies).await else {
            break;
        };
        if !status.is_success() {
            break;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) else {
            break;
        };
        if v["code"].as_i64() != Some(0) {
            break;
        }
        let page_replies = v["data"]["replies"].as_array().cloned().unwrap_or_default();
        let fetched = page_replies.len();
        for r in &page_replies {
            if let Some((_, entry)) = parse_comment(r) {
                out.push(entry);
            }
        }
        emotes.extend(parse_emotes(&v));
        let total = v["data"]["page"]["count"].as_i64().unwrap_or(0);
        if out.len() as i64 >= total || fetched == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(FETCH_DELAY_MS)).await;
    }
    (out, emotes)
}

/// 确保某视频的弹幕已缓存：库里没有且是在线 B 站视频时，抓一次并写库。
/// 尽力而为——网络失败只记日志，不向播放器报错。
pub async fn ensure_danmaku(
    db: &Db,
    video_id: &str,
    source_type: &str,
    source_uri: Option<&str>,
    cid: Option<&str>,
    cookies: Option<&str>,
) -> AppResult<()> {
    if source_type != "bilibili" {
        return Ok(());
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM danmaku WHERE video_id=?")
        .bind(video_id)
        .fetch_one(&db.pool)
        .await?;
    if count > 0 {
        return Ok(());
    }
    let resolved_cid = match cid {
        Some(c) if !c.trim().is_empty() => c.to_string(),
        _ => {
            let uri = match source_uri {
                Some(uri) => uri,
                None => return Ok(()),
            };
            let mut bvid = None;
            for u in uri.split(',') {
                if let Some(b) = bvid_from_url(u) {
                    bvid = Some(b);
                    break;
                }
            }
            let Some(bvid) = bvid else { return Ok(()) };
            match bilibili_view(&bvid, cookies).await {
                Ok((_, cid)) => cid,
                Err(error) => {
                    tracing::warn!(%error, "反查弹幕 cid 失败，跳过");
                    return Ok(());
                }
            }
        }
    };
    let xml = match fetch_danmaku_xml(&resolved_cid, cookies).await {
        Ok(xml) => xml,
        Err(error) => {
            tracing::warn!(%error, "弹幕抓取失败，跳过");
            return Ok(());
        }
    };
    let entries = parse_danmaku_xml(&xml);
    if entries.is_empty() {
        return Ok(());
    }
    // 把拿到的 cid 落回视频行，省得下次再反查一遍。
    if cid.is_none() {
        sqlx::query("UPDATE videos SET bilibili_cid=? WHERE id=?")
            .bind(&resolved_cid)
            .bind(video_id)
            .execute(&db.pool)
            .await?;
    }
    let now = chrono::Utc::now().timestamp_millis();
    for e in &entries {
        sqlx::query(
            "INSERT INTO danmaku(video_id,mode,start_ms,text,color,font_size,created_at)
             VALUES (?,?,?,?,?,?,?)",
        )
        .bind(video_id)
        .bind(&e.mode)
        .bind(e.start_ms)
        .bind(&e.text)
        .bind(&e.color)
        .bind(e.font_size)
        .bind(now)
        .execute(&db.pool)
        .await?;
    }
    Ok(())
}

/// 确保某视频的评论区已缓存：全量抓取（根评论 + 楼中楼）一次写库。
/// 缓存判定看「有 rpid 的行」——旧版只存过热评 20 条（无 rpid）的也会重抓；
/// 抓取结果先删后插放进一个事务，失败不留半份，(video_id, rpid) 唯一索引
/// 让并发触发的两次抓取互不重复。
pub async fn ensure_comments(
    db: &Db,
    video_id: &str,
    source_type: &str,
    source_uri: Option<&str>,
    cid: Option<&str>,
    cookies: Option<&str>,
) -> AppResult<()> {
    if source_type != "bilibili" {
        return Ok(());
    }
    // 缓存判定看两处：评论行有头像（B 站回复必带，旧版本缓存会被识别重抓），
    // 且表情映射已采集过（video_emotes 里的哨兵行）。任一缺失都重抓自愈。
    let cached: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM video_comments WHERE video_id=? AND avatar IS NOT NULL",
    )
    .bind(video_id)
    .fetch_one(&db.pool)
    .await?;
    let emotes_captured: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM video_emotes WHERE video_id=?")
            .bind(video_id)
            .fetch_one(&db.pool)
            .await?;
    if cached > 0 && emotes_captured > 0 {
        return Ok(());
    }
    let uri = match source_uri {
        Some(uri) => uri,
        None => return Ok(()),
    };
    let mut bvid = None;
    for u in uri.split(',') {
        if let Some(b) = bvid_from_url(u) {
            bvid = Some(b);
            break;
        }
    }
    let Some(bvid) = bvid else { return Ok(()) };
    let (aid, _cid) = match bilibili_view(&bvid, cookies).await {
        Ok(view) => view,
        Err(error) => {
            tracing::warn!(%error, "反查评论 aid 失败，跳过");
            return Ok(());
        }
    };
    // 顺手把 cid 落回视频行，下次取弹幕就不用再反查。
    if cid.filter(|c| !c.trim().is_empty()).is_none() {
        let _ = sqlx::query("UPDATE videos SET bilibili_cid=? WHERE id=?")
            .bind(&_cid)
            .bind(video_id)
            .execute(&db.pool)
            .await;
    }
    let (roots, mut emotes) = fetch_all_root_comments(&aid, cookies).await;
    if roots.is_empty() {
        return Ok(());
    }
    // 先在内存里攒齐全部行（抓楼中楼期间不开事务，别让写锁横跨几十秒的网络请求），
    // 再用短事务先删后插：失败不留半份。
    let mut pending: Vec<(Option<String>, Option<String>, i64, CommentEntry)> = Vec::new();
    let mut reply_budget = MAX_REPLY_REQUESTS;
    for (root_sort, (root_rpid, entry)) in roots.iter().enumerate() {
        pending.push((Some(root_rpid.clone()), None, root_sort as i64, entry.clone()));
        if entry.reply_count > 0 && reply_budget > 0 {
            let (replies, reply_emotes) =
                fetch_comment_replies(&aid, root_rpid, cookies, &mut reply_budget).await;
            emotes.extend(reply_emotes);
            for (reply_sort, reply) in replies.into_iter().enumerate() {
                // 回复一律挂在根评论下平铺展示；rpid 保持自身 id，parent 指向根。
                pending.push((reply.rpid.clone(), Some(root_rpid.clone()), reply_sort as i64, reply));
            }
        }
    }
    let now = chrono::Utc::now().timestamp_millis();
    let mut tx = db.pool.begin().await?;
    sqlx::query("DELETE FROM video_comments WHERE video_id=?")
        .bind(video_id)
        .execute(&mut *tx)
        .await?;
    for (rpid, parent, sort, entry) in &pending {
        sqlx::query(
            "INSERT OR IGNORE INTO video_comments\
             (video_id,author,text,like_count,ctime,sort_index,created_at,rpid,parent_rpid,reply_count,direct_parent_rpid,avatar)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(video_id)
        .bind(&entry.author)
        .bind(&entry.text)
        .bind(entry.like_count)
        .bind(entry.ctime)
        .bind(sort)
        .bind(now)
        .bind(rpid)
        .bind(parent)
        .bind(entry.reply_count)
        .bind(&entry.direct_parent_rpid)
        .bind(&entry.avatar)
        .execute(&mut *tx)
        .await?;
    }
    // 表情映射先清后并（同标记以新页为准），最后放哨兵行标记「已采集」。
    sqlx::query("DELETE FROM video_emotes WHERE video_id=?")
        .bind(video_id)
        .execute(&mut *tx)
        .await?;
    emotes.sort_by(|a, b| a.text.cmp(&b.text));
    emotes.dedup_by(|a, b| a.text == b.text);
    for emote in &emotes {
        sqlx::query("INSERT OR REPLACE INTO video_emotes(video_id,emote_text,url,size) VALUES (?,?,?,?)")
            .bind(video_id)
            .bind(&emote.text)
            .bind(&emote.url)
            .bind(emote.size)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT OR REPLACE INTO video_emotes(video_id,emote_text,url,size) VALUES (?, '', '', 0)")
        .bind(video_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    tracing::info!(video_id, roots = roots.len(), emotes = emotes.len(), "评论区缓存完成");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_xml() -> String {
        r#"<?xml version="1.0" encoding="UTF-8"?>
<i>
  <chatserver>chat.bilibili.com</chatserver>
  <chatid>1</chatid>
  <d p="23.82,1,25,16777215,1511413801,0,abc,1">普通滚动弹幕</d>
  <d p="5.00,4,25,16711680,1511413802,0,def,2">我顶部弹幕</d>
  <d p="12.00,5,25,255,1511413803,0,ghi,3">我底部弹幕</d>
  <d p="99.90,1,25,16777215,1511413804,0,jkl,4">&lt;角标&gt;</d>
  <d p="1.00,1,25,16777215,1511413805,0,mno,5"></d>
</i>"#
        .to_string()
    }

    #[test]
    fn parses_modes_times_and_text() {
        let entries = parse_danmaku_xml(&sample_xml());
        assert_eq!(entries.len(), 4, "空文本那条应被丢弃");
        assert_eq!(entries[0].mode, "scroll");
        assert_eq!(entries[0].start_ms, 23820);
        assert_eq!(entries[0].text, "普通滚动弹幕");
        assert_eq!(entries[1].mode, "bottom");
        assert_eq!(entries[1].start_ms, 5000);
        assert_eq!(entries[1].color.as_deref(), Some("#ff0000"));
        assert_eq!(entries[2].mode, "top");
        assert_eq!(entries[2].color.as_deref(), Some("#0000ff"));
        // 实体解码：&amp;lt; → <，&amp;gt; → >
        assert_eq!(entries[3].text, "<角标>");
    }

    #[test]
    fn extracts_bvid_from_various_url_shapes() {
        assert_eq!(
            bvid_from_url("https://www.bilibili.com/video/BV1xx411c7mD").as_deref(),
            Some("BV1xx411c7mD")
        );
        assert_eq!(
            bvid_from_url("https://bilibili.com/video/BV1xx411c7mD?p=2").as_deref(),
            Some("BV1xx411c7mD")
        );
        assert_eq!(bvid_from_url("https://example.com"), None);
    }

    #[test]
    fn parses_root_comment_with_rpid_and_reply_count() {
        let root = serde_json::json!({
            "rpid": 3_600_000_000_000_000_000u64, // 超出 JS 安全整数的量级
            "member": {"uname": "甲"},
            "content": {"message": "根评论"},
            "like": 12,
            "ctime": 1_700_000_000,
            "rcount": 2
        });
        let (rpid, entry) = parse_comment(&root).unwrap();
        // rpid 超过 JS 2^53：必须以字符串形式存在，否则前端会丢精度。
        assert_eq!(rpid, "3600000000000000000");
        assert_eq!(entry.rpid.as_deref(), Some("3600000000000000000"));
        assert_eq!(entry.author, "甲");
        assert_eq!(entry.text, "根评论");
        assert_eq!(entry.like_count, 12);
        assert_eq!(entry.reply_count, 2);
        assert_eq!(entry.parent_rpid, None, "根评论没有 parent");
    }

    #[test]
    fn parses_nested_reply_pointing_at_its_root() {
        let reply = serde_json::json!({
            "rpid": 3_600_000_000_000_000_001u64,
            "root": 3_600_000_000_000_000_000u64,
            "parent": 3_600_000_000_000_000_000u64,
            "member": {"uname": "乙"},
            "content": {"message": "楼中楼回复"},
            "like": 3,
            "ctime": 1_700_000_100
        });
        let (rpid, entry) = parse_comment(&reply).unwrap();
        assert_eq!(rpid, "3600000000000000001");
        assert_eq!(
            entry.parent_rpid.as_deref(),
            Some("3600000000000000000"),
            "楼中楼的 parent 指向根评论"
        );
        assert_eq!(entry.reply_count, 0, "回复没有自己的回复数");
    }

    #[test]
    fn drops_comments_without_rpid_or_text() {
        let no_text = serde_json::json!({"rpid": 1, "content": {"message": "  "}});
        assert!(parse_comment(&no_text).is_none());
        let no_rpid = serde_json::json!({"content": {"message": "x"}});
        assert!(parse_comment(&no_rpid).is_none());
    }

    #[test]
    fn decode_entities_handles_common_and_numeric() {
        assert_eq!(decode_entities("a &amp; b &#60;c&#62; d"), "a & b <c> d");
        assert_eq!(decode_entities("no & entities"), "no & entities");
    }

    #[test]
    fn decodes_raw_deflate_zlib_and_plain_danmaku_bodies() {
        use flate2::{read::ZlibEncoder, write::DeflateEncoder, Compression};
        use std::io::Write;

        let xml = r#"<?xml version="1.0" encoding="UTF-8"?><i><d p="1.0,1,25,16777215,0,0,x,1">压</d></i>"#;

        // B 站实际形态：raw deflate（无 zlib 包装）。
        let mut raw = DeflateEncoder::new(Vec::new(), Compression::default());
        raw.write_all(xml.as_bytes()).unwrap();
        let raw_deflate = raw.finish().unwrap();
        assert_eq!(decode_danmaku_body(&raw_deflate), xml);

        // 兼容将来改回标准 zlib 包装的情况。
        let mut zlib = ZlibEncoder::new(xml.as_bytes(), Compression::default());
        let mut zlib_bytes = Vec::new();
        zlib.read_to_end(&mut zlib_bytes).unwrap();
        assert_eq!(decode_danmaku_body(&zlib_bytes), xml);

        // 明文（接口未来不再压缩时）原样通过。
        assert_eq!(decode_danmaku_body(xml.as_bytes()), xml);
    }

    #[test]
    fn parses_netscape_cookies_into_header() {
        let content = "# Netscape HTTP Cookie File\n\
                       # comment line\n\
                       .bilibili.com\tTRUE\t/\tFALSE\t1810282522\tbuvid3\tE4D5A45Dinfoc\n\
                       #HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t1800000000\tSESSDATA\taaa==\n\
                       .bilibili.com\tTRUE\t/\tFALSE\t1807258522\tb_nut\t1775722522\n\
                       broken-tab-less-line\n";

        let header = parse_netscape_cookies(content).unwrap();
        assert_eq!(header, "buvid3=E4D5A45Dinfoc; SESSDATA=aaa==; b_nut=1775722522");

        // 只有注释/空行 → 解析不出任何 cookie。
        assert_eq!(parse_netscape_cookies("# only comment\n\n"), None);
    }

    #[test]
    fn cookie_header_treats_setting_as_path_or_string() {
        use std::io::Write;

        // 直接就是 cookie 字符串（兼容）：原样使用。
        assert_eq!(
            cookie_header_from_setting(Some("SESSDATA=a; buvid3=b")).as_deref(),
            Some("SESSDATA=a; buvid3=b")
        );
        // 空值 → None（请求层退回兜底 buvid3）。
        assert_eq!(cookie_header_from_setting(Some("")), None);
        assert_eq!(cookie_header_from_setting(None), None);
        // 不存在的路径 → None。
        assert_eq!(cookie_header_from_setting(Some("/no/such/cookies.txt")), None);

        // 路径分支：读到真实文件时解析出 Cookie 头。
        let mut path = std::env::temp_dir();
        path.push(format!("courseai-cookies-{}.txt", std::process::id()));
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(
            file,
            "# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tFALSE\t0\tbuvid3\tTESTBUVID"
        )
        .unwrap();
        drop(file);
        assert_eq!(
            cookie_header_from_setting(Some(path.to_str().unwrap())).as_deref(),
            Some("buvid3=TESTBUVID")
        );
        let _ = std::fs::remove_file(&path);
    }
}
