pub mod factory;
pub mod keychain;
pub mod openai;
pub mod profiles;
pub mod prompts;

use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub system: Option<String>,
    /// 大段字幕上下文：拼进 system 的最前面，让同一视频的多个任务共用同一段前缀。
    ///
    /// 原来这里是「Anthropic 显式标 cache 块、OpenAI 靠前缀自动缓存」两套。去掉 Anthropic
    /// 之后只剩后者——**缓存从显式变成了隐式**：命不命中由端点自己决定，我们既不声明也
    /// 收不到反馈。换到不做自动前缀缓存的兼容端点时，那几个共用讲稿的任务会悄悄贵好几倍，
    /// 而且没有任何信号。字段保留，因为「把稳定的大块放最前面」这件事仍然是对的。
    pub cacheable_context: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub temperature: f32,
    /// 目前**不会被发出去**：OpenAI 规范里它是可选的，我们特意省略，免得写死的上限
    /// 把长输出截断（见 openai 侧 body 构造）。删掉 Anthropic 后就没有任何通道读它了。
    /// 留着是给将来真需要封顶时用；改这个数字现在不会有任何效果。
    pub max_tokens: u32,
}

/// 把 temperature 量化到 2 位小数再发给服务端。
/// f32 字面量(如 0.1)加宽到 f64 序列化会出现 0.10000000149011612 这类长小数,
/// 智谱 GLM 等严格服务端会报「temperature 参数非法：限制小数点 2 位」。四舍五入到
/// 2 位对所有 provider 都安全(0.1→0.1、0.3→0.3)。
pub fn round_temperature(temperature: f32) -> f64 {
    (temperature as f64 * 100.0).round() / 100.0
}

/// 一行 SSE 的含义（OpenAI 与 Anthropic 共用）。
///
/// 区分「正常结束」和「流断在半截」是关键：只看到 EOF 就返回成功，会把被截断的
/// 半截回答当成完整答案交出去——用户看不出区别，它还会被存进笔记、摘要、题库。
#[derive(Debug, PartialEq)]
pub enum SseEvent {
    Content(String),
    Reasoning(String),
    /// 服务端明确宣布这次生成结束。
    Finished,
    /// 流内错误事件：HTTP 已经 200 了，错误改从流里来（限流、内容策略等）。
    Failed(String),
    Ignore,
}

/// 从字节缓冲里切出一行（含换行符）；没有完整行时返回 None，剩余字节留到下一个 chunk。
///
/// 必须按**字节**找 `\n` 再整行解码：一个中文字符占三字节，很容易被切在两个网络
/// chunk 中间；对每个 chunk 单独做 from_utf8_lossy 就会把它变成 `�`，而且是随机复现。
/// 行边界是安全的——`\n` 是 ASCII，不可能出现在多字节字符内部，所以整行一定是
/// 完整的 UTF-8。
pub fn take_sse_line(buf: &mut Vec<u8>) -> Option<String> {
    let pos = buf.iter().position(|byte| *byte == b'\n')?;
    let line: Vec<u8> = buf.drain(..=pos).collect();
    Some(String::from_utf8_lossy(&line).into_owned())
}

#[cfg(test)]
mod sse_tests {
    use super::take_sse_line;

    #[test]
    fn a_chinese_character_split_across_chunks_survives() {
        // 「好」是 E5 A5 BD 三个字节。网络按 chunk 切，切点落在字符中间是常态；
        // 对每个 chunk 单独 from_utf8_lossy，这里就会变成 `你��`——随机出现的乱码。
        let mut buf: Vec<u8> = Vec::new();
        let full = "data: 你好\n".as_bytes();
        let split = full.len() - 3; // 切在「好」的第一个字节之后
        buf.extend_from_slice(&full[..split]);
        assert_eq!(take_sse_line(&mut buf), None, "半行不该被交出去");
        buf.extend_from_slice(&full[split..]);
        assert_eq!(take_sse_line(&mut buf), Some("data: 你好\n".to_string()));
        assert!(buf.is_empty());
    }

    #[test]
    fn leftovers_stay_in_the_buffer_for_the_next_chunk() {
        let mut buf: Vec<u8> = b"a\nb\nhalf".to_vec();
        assert_eq!(take_sse_line(&mut buf), Some("a\n".to_string()));
        assert_eq!(take_sse_line(&mut buf), Some("b\n".to_string()));
        assert_eq!(take_sse_line(&mut buf), None);
        assert_eq!(buf, b"half");
    }
}

/// 等模型返回，但每隔一小会儿看一眼取消标志；被取消时返回 None。
///
/// 非流式调用只在开始前查一次标志是不够的：`complete` 最长要等到请求超时（180 秒）
/// 才回得来，用户点了「停止」，界面却还得转上几分钟，而且这期间跑出来的结果照样
/// 会被写库。future 一被丢弃，底层 HTTP 请求随之断开，取消才真正落到网络这一层。
pub async fn complete_or_cancel(
    provider: &Provider,
    req: &ChatRequest,
    cancel: &AtomicBool,
) -> AppResult<Option<String>> {
    if cancel.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let call = provider.complete(req);
    tokio::pin!(call);
    loop {
        tokio::select! {
            finished = &mut call => return finished.map(|response| Some(response.content)),
            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {
                if cancel.load(Ordering::SeqCst) {
                    return Ok(None);
                }
            }
        }
    }
}

/// 流式片段：正式回答内容，或推理模型的「思考」内容（不计入最终答案）。
pub enum StreamPiece<'a> {
    Content(&'a str),
    Reasoning(&'a str),
}

#[derive(Debug, Clone)]
pub struct ChatResponse {
    pub content: String,
}

/// 统一的 LLM 通道。用 enum 而非 trait，避免引入 async-trait 依赖，
/// 同时让 dyn 派发问题消失（runner 直接持有 &Provider）。
pub enum Provider {
    OpenAi {
        base_url: String,
        api_key: String,
        client: reqwest::Client,
    },
    /// 测试 / 离线用：返回预置内容。
    Mock { canned: String },
}

impl Provider {
    pub async fn complete(&self, req: &ChatRequest) -> AppResult<ChatResponse> {
        match self {
            Provider::OpenAi {
                base_url,
                api_key,
                client,
            } => openai::complete(base_url, api_key, client, req).await,
            Provider::Mock { canned } => Ok(ChatResponse {
                content: canned.clone(),
            }),
        }
    }

    /// 流式补全：每收到一段先查 `cancel`（true 则停止并返回已累积内容），否则调
    /// `on_piece`（Content=正式内容并累积；Reasoning=推理思考，不累积）。返回累积内容全文。
    pub async fn complete_stream(
        &self,
        req: &ChatRequest,
        cancel: &AtomicBool,
        on_piece: &mut (dyn FnMut(StreamPiece) + Send),
    ) -> AppResult<String> {
        match self {
            Provider::OpenAi {
                base_url,
                api_key,
                client,
            } => openai::complete_stream(base_url, api_key, client, req, cancel, on_piece).await,
            Provider::Mock { canned } => {
                let mut acc = String::new();
                // 按空白切成词，逐词回调，模拟流式；每词前查取消。
                for (i, word) in canned.split_whitespace().enumerate() {
                    if cancel.load(Ordering::SeqCst) {
                        break;
                    }
                    let piece = if i == 0 {
                        word.to_string()
                    } else {
                        format!(" {word}")
                    };
                    on_piece(StreamPiece::Content(&piece));
                    acc.push_str(&piece);
                }
                Ok(acc)
            }
        }
    }

    pub fn supports_vision(&self) -> bool {
        false
    }

    /// 文本嵌入。OpenAI 兼容端点用 `/embeddings`；
    /// Mock 返回确定性向量（相似文本→相似向量），便于离线单测 RAG。
    pub async fn embed(&self, model: &str, inputs: &[String]) -> AppResult<Vec<Vec<f32>>> {
        match self {
            Provider::OpenAi {
                base_url,
                api_key,
                client,
            } => openai::embed(base_url, api_key, client, model, inputs).await,
            Provider::Mock { .. } => Ok(inputs.iter().map(|s| mock_embed(s)).collect()),
        }
    }
}

/// 确定性伪嵌入：把文本散列进固定维向量并归一化。仅用于离线测试。
pub fn mock_embed(text: &str) -> Vec<f32> {
    const DIM: usize = 16;
    let mut v = [0f32; DIM];
    for (i, b) in text.bytes().enumerate() {
        v[i % DIM] += b as f32;
    }
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
    v.iter().map(|x| x / norm).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_provider_returns_canned() {
        let provider = Provider::Mock {
            canned: "hello".into(),
        };
        let req = ChatRequest {
            model: "x".into(),
            system: None,
            cacheable_context: None,
            messages: vec![ChatMessage {
                role: "user".into(),
                content: "hi".into(),
            }],
            temperature: 0.2,
            max_tokens: 100,
        };
        assert_eq!(provider.complete(&req).await.unwrap().content, "hello");
    }

    fn stream_req() -> ChatRequest {
        ChatRequest {
            model: "m".into(),
            system: None,
            cacheable_context: None,
            messages: vec![],
            temperature: 0.2,
            max_tokens: 64,
        }
    }

    #[tokio::test]
    async fn mock_complete_stream_emits_chunks_and_accumulates() {
        use std::sync::atomic::AtomicBool;
        let p = Provider::Mock {
            canned: "结论 一 二 三".into(),
        };
        let cancel = AtomicBool::new(false);
        let mut chunks: Vec<String> = Vec::new();
        let full = p
            .complete_stream(&stream_req(), &cancel, &mut |piece| {
                if let StreamPiece::Content(d) = piece {
                    chunks.push(d.to_string());
                }
            })
            .await
            .unwrap();
        assert!(chunks.len() >= 2, "应分多段回调");
        assert_eq!(full, chunks.concat());
        assert_eq!(full, "结论 一 二 三");
    }

    #[tokio::test]
    async fn mock_complete_stream_stops_on_cancel() {
        use std::sync::atomic::AtomicBool;
        let p = Provider::Mock {
            canned: "a b c d e".into(),
        };
        let cancel = AtomicBool::new(true); // 一开始就取消
        let mut chunks = 0;
        let full = p
            .complete_stream(&stream_req(), &cancel, &mut |_| chunks += 1)
            .await
            .unwrap();
        assert_eq!(chunks, 0, "已取消则不产出");
        assert_eq!(full, "");
    }
}
