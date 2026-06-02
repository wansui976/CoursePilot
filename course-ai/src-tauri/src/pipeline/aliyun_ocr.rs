//! 阿里云 OCR「统一识别」(RecognizeAllText) 后端。
//!
//! 参考 https://help.aliyun.com/zh/ocr/developer-reference/api-ocr-api-2021-07-07-recognizealltext 。
//! 走阿里云 OpenAPI 网关，鉴权用 V3 签名（ACS3-HMAC-SHA256）：
//!   - 图片二进制作为 HTTP body；识别类型等参数放查询串（Type=...）；
//!   - 用 AccessKey ID / Secret 计算 Authorization 头。
//! 这里不引第三方 SDK，HMAC-SHA256 用已有的 sha2 手写实现，零新增依赖。

use crate::error::{AppError, AppResult};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const HOST: &str = "ocr-api.cn-hangzhou.aliyuncs.com";
const ACTION: &str = "RecognizeAllText";
const VERSION: &str = "2021-07-07";
const ALGORITHM: &str = "ACS3-HMAC-SHA256";
/// 默认识别类型：Advanced = 通用文字识别高精版。
pub const DEFAULT_TYPE: &str = "Advanced";

/// 对一张图片做阿里云「统一识别」，返回整段文本。
pub async fn run_aliyun_ocr(
    image: &[u8],
    access_key_id: &str,
    access_key_secret: &str,
    ocr_type: &str,
) -> AppResult<String> {
    let access_key_id = access_key_id.trim();
    let access_key_secret = access_key_secret.trim();
    if access_key_id.is_empty() || access_key_secret.is_empty() {
        return Err(AppError::Config(
            "missing Aliyun OCR credentials：请在设置里填写阿里云 AccessKey ID 与 Secret".into(),
        ));
    }
    let ocr_type = if ocr_type.trim().is_empty() {
        DEFAULT_TYPE
    } else {
        ocr_type.trim()
    };

    let query = vec![("Type".to_string(), ocr_type.to_string())];
    let body_hash = hex_lower(&sha256(image));
    let date = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let nonce = Uuid::new_v4().to_string();

    // 参与签名的头：host + 所有 x-acs-* + content-type。
    let headers = vec![
        ("content-type".to_string(), "application/octet-stream".to_string()),
        ("host".to_string(), HOST.to_string()),
        ("x-acs-action".to_string(), ACTION.to_string()),
        ("x-acs-content-sha256".to_string(), body_hash.clone()),
        ("x-acs-date".to_string(), date.clone()),
        ("x-acs-signature-nonce".to_string(), nonce.clone()),
        ("x-acs-version".to_string(), VERSION.to_string()),
    ];

    let authorization =
        build_authorization(access_key_id, access_key_secret, &query, &headers, &body_hash);

    let url = format!("https://{HOST}/?{}", canonical_query_string(&query));
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", &authorization)
        .header("content-type", "application/octet-stream")
        // host 头由 reqwest 按 URL 自动添加，且与签名里的 host 取值一致，
        // 这里不手动设置，避免出现重复 Host 头导致签名校验失败。
        .header("x-acs-action", ACTION)
        .header("x-acs-content-sha256", &body_hash)
        .header("x-acs-date", &date)
        .header("x-acs-signature-nonce", &nonce)
        .header("x-acs-version", VERSION)
        .body(image.to_vec())
        .send()
        .await
        .map_err(|e| AppError::Pipeline(format!("aliyun ocr request: {e}")))?;

    let status = resp.status();
    let raw = resp
        .text()
        .await
        .map_err(|e| AppError::Pipeline(format!("aliyun ocr read body: {e}")))?;
    let payload: Value = serde_json::from_str(&raw)
        .map_err(|e| AppError::Pipeline(format!("aliyun ocr decode: {e}；原始响应：{}", truncate(&raw, 300))))?;
    // 网关一般用 HTTP 状态码报错，但也兜底识别 body 里的 Code/Message。
    let code = payload["Code"].as_str().unwrap_or("");
    let message = payload["Message"].as_str().unwrap_or("");
    if !status.is_success() || (!code.is_empty() && payload.get("Data").is_none()) {
        let hint = if status.as_u16() == 403 || code.contains("Forbidden") || code.contains("NoPermission") {
            "（鉴权/权限失败：请核对 AccessKey、并确认已开通「文字识别 OCR」服务且 RAM 已授权）"
        } else {
            ""
        };
        return Err(AppError::Pipeline(format!(
            "aliyun OCR 失败：{} {code} {message}{hint}",
            status.as_u16()
        )));
    }
    let text = extract_content(&payload)?;
    if text.is_empty() {
        // 成功但没取到文字：把原始响应抛出来，便于定位（字段结构/空白帧）。
        return Err(AppError::Pipeline(format!(
            "aliyun OCR 未提取到文字。原始响应：{}",
            truncate(&raw, 600)
        )));
    }
    Ok(text)
}

fn truncate(s: &str, max_chars: usize) -> String {
    let t: String = s.chars().take(max_chars).collect();
    if s.chars().count() > max_chars {
        format!("{t}…")
    } else {
        t
    }
}

/// 从 RecognizeAllText 响应里取出整段识别文本。
/// Data 通常是一段 JSON 字符串，内含 content 字段。
pub fn extract_content(payload: &Value) -> AppResult<String> {
    let data = &payload["Data"];
    let inner: Value = match data {
        Value::String(s) => serde_json::from_str(s)
            .map_err(|e| AppError::Pipeline(format!("aliyun ocr Data parse: {e}")))?,
        Value::Object(_) => data.clone(),
        _ => return Err(AppError::Pipeline("aliyun ocr: 响应缺少 Data".into())),
    };
    // 首选整段 content（部分识别类型直接给）。
    let content = inner["content"].as_str().unwrap_or("").trim();
    if !content.is_empty() {
        return Ok(content.to_string());
    }
    // 统一识别（RecognizeAllText）的实际结构：
    // Data.SubImages[].BlockInfo.BlockDetails[].BlockContent，逐块按行拼接。
    if let Some(subs) = inner["SubImages"].as_array() {
        let mut parts = Vec::new();
        for sub in subs {
            if let Some(blocks) = sub["BlockInfo"]["BlockDetails"].as_array() {
                for block in blocks {
                    if let Some(t) = block["BlockContent"].as_str() {
                        if !t.trim().is_empty() {
                            parts.push(t.trim().to_string());
                        }
                    }
                }
            }
        }
        if !parts.is_empty() {
            return Ok(parts.join("\n"));
        }
    }
    // 兜底：逐词结果（prism_wordsInfo[].word）。
    if let Some(words) = inner["prism_wordsInfo"].as_array() {
        let joined: String = words
            .iter()
            .filter_map(|w| w["word"].as_str())
            .collect::<Vec<_>>()
            .join("");
        if !joined.trim().is_empty() {
            return Ok(joined.trim().to_string());
        }
    }
    Ok(String::new())
}

// ---------- V3 签名（纯函数，便于单测） ----------

fn build_authorization(
    access_key_id: &str,
    access_key_secret: &str,
    query: &[(String, String)],
    headers: &[(String, String)],
    body_hash: &str,
) -> String {
    let signed_headers = signed_header_names(headers);
    let canonical_request = format!(
        "POST\n/\n{}\n{}\n{}\n{}",
        canonical_query_string(query),
        canonical_headers(headers),
        signed_headers,
        body_hash
    );
    let string_to_sign = format!("{ALGORITHM}\n{}", hex_lower(&sha256(canonical_request.as_bytes())));
    let signature = hex_lower(&hmac_sha256(access_key_secret.as_bytes(), string_to_sign.as_bytes()));
    format!(
        "{ALGORITHM} Credential={access_key_id},SignedHeaders={signed_headers},Signature={signature}"
    )
}

/// 查询串：按 key 排序，键值都按 RFC3986 百分号编码，`k=v` 用 & 连接。
pub fn canonical_query_string(query: &[(String, String)]) -> String {
    let mut items: Vec<(String, String)> = query
        .iter()
        .map(|(k, v)| (percent_encode(k), percent_encode(v)))
        .collect();
    items.sort_by(|a, b| a.0.cmp(&b.0));
    items
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// 规范化头：名小写、按名排序，`name:value\n`。
fn canonical_headers(headers: &[(String, String)]) -> String {
    let mut sorted: Vec<(String, String)> = headers
        .iter()
        .map(|(k, v)| (k.to_lowercase(), v.trim().to_string()))
        .collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = String::new();
    for (k, v) in sorted {
        out.push_str(&k);
        out.push(':');
        out.push_str(&v);
        out.push('\n');
    }
    out
}

fn signed_header_names(headers: &[(String, String)]) -> String {
    let mut names: Vec<String> = headers.iter().map(|(k, _)| k.to_lowercase()).collect();
    names.sort();
    names.join(";")
}

/// RFC3986 百分号编码：unreserved = A-Za-z0-9-_.~，其余 %XX（大写）。
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

/// 手写 HMAC-SHA256（块大小 64），避免引入 hmac crate。
pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = if key.len() > BLOCK {
        sha256(key).to_vec()
    } else {
        key.to_vec()
    };
    k.resize(BLOCK, 0);
    let mut inner = k.iter().map(|b| b ^ 0x36).collect::<Vec<u8>>();
    inner.extend_from_slice(msg);
    let inner_hash = sha256(&inner);
    let mut outer = k.iter().map(|b| b ^ 0x5c).collect::<Vec<u8>>();
    outer.extend_from_slice(&inner_hash);
    sha256(&outer)
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sha256_known_vector() {
        assert_eq!(
            hex_lower(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn hmac_sha256_known_vector() {
        // RFC 标准测试向量。
        let mac = hmac_sha256(
            b"key",
            b"The quick brown fox jumps over the lazy dog",
        );
        assert_eq!(
            hex_lower(&mac),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }

    #[test]
    fn percent_encode_reserved_and_unreserved() {
        assert_eq!(percent_encode("a b/c"), "a%20b%2Fc");
        assert_eq!(percent_encode("Advanced-_.~"), "Advanced-_.~");
    }

    #[test]
    fn canonical_query_sorted_and_encoded() {
        let q = vec![
            ("Type".to_string(), "Advanced".to_string()),
            ("A b".to_string(), "x/y".to_string()),
        ];
        assert_eq!(canonical_query_string(&q), "A%20b=x%2Fy&Type=Advanced");
    }

    #[test]
    fn signed_headers_lowercased_sorted() {
        let h = vec![
            ("x-acs-date".to_string(), "d".to_string()),
            ("Host".to_string(), HOST.to_string()),
        ];
        assert_eq!(signed_header_names(&h), "host;x-acs-date");
    }

    #[test]
    fn authorization_is_stable_and_well_formed() {
        let query = vec![("Type".to_string(), "Advanced".to_string())];
        let headers = vec![
            ("host".to_string(), HOST.to_string()),
            ("x-acs-action".to_string(), ACTION.to_string()),
            ("x-acs-content-sha256".to_string(), "deadbeef".to_string()),
            ("x-acs-date".to_string(), "2021-07-07T08:00:00Z".to_string()),
            ("x-acs-signature-nonce".to_string(), "nonce".to_string()),
            ("x-acs-version".to_string(), VERSION.to_string()),
        ];
        let auth = build_authorization("AKID", "secret", &query, &headers, "deadbeef");
        assert!(auth.starts_with("ACS3-HMAC-SHA256 Credential=AKID,"));
        assert!(auth.contains("SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version"));
        // 同样输入两次签名一致（确定性）。
        let auth2 = build_authorization("AKID", "secret", &query, &headers, "deadbeef");
        assert_eq!(auth, auth2);
    }

    #[test]
    fn extract_content_from_data_string() {
        let payload = json!({
            "RequestId": "r",
            "Data": "{\"content\":\"你好 世界\",\"width\":100}"
        });
        assert_eq!(extract_content(&payload).unwrap(), "你好 世界");
    }

    #[test]
    fn extract_content_from_data_object() {
        let payload = json!({ "Data": { "content": "abc" } });
        assert_eq!(extract_content(&payload).unwrap(), "abc");
    }

    #[test]
    fn extract_content_from_recognizealltext_subimages_blocks() {
        // RecognizeAllText 统一识别的真实结构：SubImages → BlockInfo.BlockDetails → BlockContent。
        let payload = json!({
            "Data": {
                "SubImages": [{
                    "SubImageId": 0,
                    "BlockInfo": {
                        "BlockDetails": [
                            { "BlockId": 0, "BlockContent": "第一行文字", "BlockConfidence": 99 },
                            { "BlockId": 1, "BlockContent": "第二行文字", "BlockConfidence": 98 }
                        ]
                    }
                }]
            }
        });
        assert_eq!(
            extract_content(&payload).unwrap(),
            "第一行文字\n第二行文字"
        );
    }

    #[test]
    fn extract_content_falls_back_to_words_when_content_empty() {
        let payload = json!({
            "Data": {
                "content": "",
                "prism_wordsInfo": [{ "word": "你好" }, { "word": "世界" }]
            }
        });
        assert_eq!(extract_content(&payload).unwrap(), "你好世界");
    }

    #[test]
    fn extract_content_empty_when_nothing_found() {
        let payload = json!({ "Data": { "content": "" } });
        assert_eq!(extract_content(&payload).unwrap(), "");
    }
}
