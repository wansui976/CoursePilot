pub mod agent;
pub mod factory;
pub mod keychain;
pub mod openai;
pub mod profiles;
pub mod prompts;

use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};

/// 一个可以交给模型调用的工具。`parameters` 是它的入参 JSON Schema。
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// 模型要求调用某个工具。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    /// 服务端给的调用 id。回结果时必须原样带回去，否则模型对不上是哪一次调用。
    pub id: String,
    pub name: String,
    /// 模型给的入参，**原样保留字符串、不在这里解析**。
    ///
    /// 模型完全可能吐出不合法的 JSON，或者参数不符合 schema。那是执行方要处理的错误
    /// （可以把错误当工具结果喂回去让它改），不该让整个响应解析失败——一旦在这里
    /// 报错，用户看到的是「请求失败」，而真相是「模型少写了一个引号」。
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    /// "user" | "assistant" | "tool"
    pub role: String,
    pub content: String,
    /// 仅 assistant 轮次：这一轮模型没有作答，而是要求调用这些工具。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// 仅 tool 轮次：这条结果回应的是哪一次调用。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self::text("user", content)
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self::text("assistant", content)
    }

    pub fn text(role: &str, content: impl Into<String>) -> Self {
        Self {
            role: role.to_string(),
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }

    /// 模型这一轮要求调工具。必须原样放回对话里再发下一次请求，
    /// 否则后面那条 tool 结果就成了没有出处的孤儿，服务端会直接拒。
    ///
    /// `content` 是它这一轮**顺带说的话**（「我先查一下」之类），可能为空。
    /// 原来这里一律置空，等于把模型自己说过的话从它的上下文里抹掉——
    /// 它下一轮看不到自己刚才的交代，容易把同一件事再解释一遍。
    pub fn tool_calls(content: impl Into<String>, calls: Vec<ToolCall>) -> Self {
        Self {
            role: "assistant".into(),
            content: content.into(),
            tool_calls: calls,
            tool_call_id: None,
        }
    }

    /// 一次工具执行的结果。执行失败时也走这里——把错误文本喂回去，
    /// 让模型有机会换参数重试，比直接把整轮对话打断有用。
    pub fn tool_result(call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: "tool".into(),
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: Some(call_id.into()),
        }
    }
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
    /// 这一轮允许模型调用的工具。空表示不带——请求体里连字段都不出现，
    /// 所以现有那些任务的请求形状一个字节都没变。
    pub tools: Vec<ToolSpec>,
}

impl ChatRequest {
    /// 纯文本请求（不带工具）。现有任务都走这里。
    pub fn text(model: &str, system: Option<String>, messages: Vec<ChatMessage>) -> Self {
        Self {
            model: model.to_string(),
            system,
            cacheable_context: None,
            messages,
            temperature: 0.2,
            tools: Vec::new(),
        }
    }
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
    /// 工具调用的**碎片**。流式下它不是一次给全的：函数名通常在第一片，
    /// 入参 JSON 一个字符一个字符地来，跨十几片；多个调用靠 `index` 区分、可能交错。
    ///
    /// 是复数：同一条 delta 里塞多个 index 是允许的。原来只取第 0 个，
    /// 剩下的会被静默丢掉——丢掉的那次调用不会报错，只是永远不执行。
    ToolCallDeltas(Vec<ToolCallDelta>),
    /// 服务端明确宣布这次生成结束。
    Finished,
    /// 流内错误事件：HTTP 已经 200 了，错误改从流里来（限流、内容策略等）。
    Failed(String),
    Ignore,
}

/// 工具调用的一片增量。除 `index` 外都可能缺席——这正是流式的形状。
#[derive(Debug, PartialEq, Default)]
pub struct ToolCallDelta {
    pub index: usize,
    pub id: Option<String>,
    pub name: Option<String>,
    /// 入参 JSON 的一段，要按 index 拼起来才是完整的。
    pub arguments: String,
}

/// 把流式碎片拼回完整的工具调用。
///
/// 不能等到最后一片再解析：服务端只保证碎片按 `index` 归属，不保证顺序、
/// 也不保证 id 和 name 一定在第一片。所以这里按槽位累积，谁先到谁先填。
#[derive(Debug, Default)]
pub struct ToolCallAccumulator {
    slots: Vec<ToolCallDelta>,
}

impl ToolCallAccumulator {
    pub fn push(&mut self, delta: ToolCallDelta) {
        // index 不保证连续，也不保证从 0 开始，所以按需补齐槽位而不是 push。
        if self.slots.len() <= delta.index {
            self.slots
                .resize_with(delta.index + 1, ToolCallDelta::default);
        }
        let slot = &mut self.slots[delta.index];
        slot.index = delta.index;
        if let Some(id) = delta.id {
            slot.id = Some(id);
        }
        if let Some(name) = delta.name {
            slot.name = Some(name);
        }
        slot.arguments.push_str(&delta.arguments);
    }

    /// 收尾。没有名字的槽位丢掉——那是补齐留下的空洞，或者服务端只发了半截；
    /// 没名字就没法执行，留着只会让上层拿到一个调不动的调用。
    pub fn finish(self) -> Vec<ToolCall> {
        self.slots
            .into_iter()
            .filter_map(|slot| {
                let name = slot.name?;
                Some(ToolCall {
                    // id 缺失时用序号兜一个：结果要靠它配对，空字符串会让服务端拒收整轮。
                    id: slot.id.unwrap_or_else(|| format!("call_{}", slot.index)),
                    name,
                    arguments: if slot.arguments.is_empty() {
                        "{}".into()
                    } else {
                        slot.arguments
                    },
                })
            })
            .collect()
    }
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
mod tool_stream_tests {
    use super::*;

    fn frag(index: usize, id: Option<&str>, name: Option<&str>, args: &str) -> ToolCallDelta {
        ToolCallDelta {
            index,
            id: id.map(str::to_string),
            name: name.map(str::to_string),
            arguments: args.to_string(),
        }
    }

    #[test]
    fn arguments_split_across_many_fragments_are_reassembled() {
        // 真实形状：第一片带 id 和函数名、入参是空串，后面几片只有入参碎片。
        let mut acc = ToolCallAccumulator::default();
        acc.push(frag(0, Some("call_1"), Some("open_video"), ""));
        acc.push(frag(0, None, None, r#"{"vid"#));
        acc.push(frag(0, None, None, r#"eo_id":"#));
        acc.push(frag(0, None, None, r#""abc"}"#));
        let calls = acc.finish();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].name, "open_video");
        assert_eq!(calls[0].arguments, r#"{"video_id":"abc"}"#);
    }

    #[test]
    fn two_interleaved_calls_stay_separate() {
        // 模型一轮可以要求调多个工具，碎片按 index 归属、可以交错到达。
        // 不按 index 分开的话，两份入参会被拼成一坨谁也解析不了的东西。
        let mut acc = ToolCallAccumulator::default();
        acc.push(frag(0, Some("a"), Some("rename"), ""));
        acc.push(frag(1, Some("b"), Some("delete"), ""));
        acc.push(frag(0, None, None, r#"{"to":"#));
        acc.push(frag(1, None, None, r#"{"id":"#));
        acc.push(frag(0, None, None, r#""新名"}"#));
        acc.push(frag(1, None, None, r#""v2"}"#));
        let calls = acc.finish();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "rename");
        assert_eq!(calls[0].arguments, r#"{"to":"新名"}"#);
        assert_eq!(calls[1].name, "delete");
        assert_eq!(calls[1].arguments, r#"{"id":"v2"}"#);
    }

    #[test]
    fn a_name_arriving_after_the_arguments_still_lands() {
        // 服务端不保证 id/name 一定在第一片。按槽位累积、谁先到谁先填，就不怕顺序。
        let mut acc = ToolCallAccumulator::default();
        acc.push(frag(0, None, None, r#"{"q":"x"}"#));
        acc.push(frag(0, Some("late"), Some("search"), ""));
        let calls = acc.finish();
        assert_eq!(calls[0].name, "search");
        assert_eq!(calls[0].id, "late");
        assert_eq!(calls[0].arguments, r#"{"q":"x"}"#);
    }

    #[test]
    fn a_sparse_index_does_not_leave_a_phantom_call() {
        // 只收到 index=2 时要补两个空槽位。空槽位没有名字，不能当成三次调用交出去。
        let mut acc = ToolCallAccumulator::default();
        acc.push(frag(2, Some("c"), Some("only"), "{}"));
        let calls = acc.finish();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "only");
    }

    #[test]
    fn a_call_with_no_arguments_gets_an_empty_object() {
        // 无参工具的服务端经常一个 arguments 字节都不发。空串不是合法 JSON，
        // 执行方会解析失败；给个 {} 让它能正常走。
        let mut acc = ToolCallAccumulator::default();
        acc.push(frag(0, Some("x"), Some("list_courses"), ""));
        assert_eq!(acc.finish()[0].arguments, "{}");
    }

    #[test]
    fn a_missing_id_still_produces_something_pairable() {
        // 结果消息要靠 id 配对，空 id 会让服务端拒收整轮对话。
        let mut acc = ToolCallAccumulator::default();
        acc.push(frag(0, None, Some("f"), "{}"));
        assert!(!acc.finish()[0].id.is_empty());
    }
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
/// 非流式调用只在开始前查一次标志是不够的：`complete` 最长要等到请求超时（10 分钟）
/// 才回得来，用户点了「停止」，界面却还得转上几分钟，而且这期间跑出来的结果照样
/// 会被写库。future 一被丢弃，底层 HTTP 请求随之断开，取消才真正落到网络这一层。
pub async fn complete_or_cancel(
    provider: &Provider,
    req: &ChatRequest,
    cancel: &AtomicBool,
) -> AppResult<Option<String>> {
    Ok(complete_or_cancel_full(provider, req, cancel)
        .await?
        .map(|response| response.content))
}

/// 同上，但把整个响应交出来——带工具调用时正文可能是空的，真正的产出在 tool_calls 里。
pub async fn complete_or_cancel_full(
    provider: &Provider,
    req: &ChatRequest,
    cancel: &AtomicBool,
) -> AppResult<Option<ChatResponse>> {
    if cancel.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let call = provider.complete(req);
    tokio::pin!(call);
    loop {
        tokio::select! {
            finished = &mut call => return finished.map(Some),
            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {
                if cancel.load(Ordering::SeqCst) {
                    return Ok(None);
                }
            }
        }
    }
}

/// 一次流式调用的结果。
///
/// 原来只返回正文字符串。带工具之后不够了：模型这一轮可能一个字都没说，
/// 只是要求调几个工具——那时正文是空的，真正的产出全在 `tool_calls` 里。
#[derive(Debug, Clone, Default)]
pub struct StreamOutcome {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
}

/// 流式片段：正式回答内容，或推理模型的「思考」内容（不计入最终答案）。
pub enum StreamPiece<'a> {
    Content(&'a str),
    Reasoning(&'a str),
}

#[derive(Debug, Clone)]
pub struct ChatResponse {
    pub content: String,
    /// 模型这一轮要求调的工具。非空时 `content` 通常是空的——它没在说话，在派活。
    pub tool_calls: Vec<ToolCall>,
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
    /// 测试用：按剧本逐次返回，可以模拟「先要求调工具、再作答」。
    ///
    /// Mock 只会复读一句固定文本，没法驱动工具调用循环——而那个循环恰恰是最需要
    /// 被测的东西（不封顶就是死循环，孤儿消息会让服务端拒收整轮）。
    Scripted {
        steps: std::sync::Mutex<Vec<ChatResponse>>,
    },
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
                tool_calls: Vec::new(),
            }),
            Provider::Scripted { steps } => {
                let mut steps = steps.lock().unwrap_or_else(|e| e.into_inner());
                if steps.is_empty() {
                    Err(crate::error::AppError::Other("剧本已用尽".into()))
                } else {
                    Ok(steps.remove(0))
                }
            }
        }
    }

    /// 流式补全：每收到一段先查 `cancel`（true 则停止并返回已累积内容），否则调
    /// `on_piece`（Content=正式内容并累积；Reasoning=推理思考，不累积）。返回累积内容全文。
    pub async fn complete_stream(
        &self,
        req: &ChatRequest,
        cancel: &AtomicBool,
        on_piece: &mut (dyn FnMut(StreamPiece) + Send),
    ) -> AppResult<StreamOutcome> {
        match self {
            Provider::OpenAi {
                base_url,
                api_key,
                client,
            } => openai::complete_stream(base_url, api_key, client, req, cancel, on_piece).await,
            Provider::Scripted { .. } => {
                let response = self.complete(req).await?;
                on_piece(StreamPiece::Content(&response.content));
                Ok(StreamOutcome {
                    content: response.content,
                    tool_calls: response.tool_calls,
                })
            }
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
                Ok(StreamOutcome {
                    content: acc,
                    tool_calls: Vec::new(),
                })
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
            Provider::Mock { .. } | Provider::Scripted { .. } => {
                Ok(inputs.iter().map(|s| mock_embed(s)).collect())
            }
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
            messages: vec![ChatMessage::user("hi")],
            temperature: 0.2,
            tools: Vec::new(),
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
            tools: Vec::new(),
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
        assert_eq!(full.content, chunks.concat());
        assert_eq!(full.content, "结论 一 二 三");
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
        assert_eq!(full.content, "");
    }
}
