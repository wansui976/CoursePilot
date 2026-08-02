use crate::error::{AppError, AppResult};
use crate::llm::{take_sse_line, ChatRequest, ChatResponse, SseEvent, StreamOutcome, StreamPiece};
use futures_util::StreamExt;
use reqwest::header::CONTENT_TYPE;
use serde_json::{json, Value};
use std::error::Error as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const STREAM_CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(100);

fn body_snippet(body: &str) -> String {
    const MAX: usize = 500;
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(MAX).collect()
}

fn request_error(error: reqwest::Error) -> AppError {
    // 连接阶段的超时要单独认出来。它和「等生成等了十分钟」是两码事：
    // 连接超时只等了 20 秒，压根没连上服务端，也就谈不上「服务端可能仍在生成」——
    // 照那句话提示，用户会白等，而正确的做法恰恰是立刻重试或去查网络。
    // reqwest 对连接超时同时置位 is_timeout 和 is_connect，所以先判 is_connect。
    if error.is_connect() {
        return AppError::Other(format!(
            "连不上大模型服务（{} 秒内没能建立连接）。检查网络、代理和 Base URL 是否正确。",
            crate::llm::factory::LLM_CONNECT_TIMEOUT.as_secs()
        ));
    }
    if error.is_timeout() {
        return AppError::Other(format!(
            "大模型请求超时（已等待 {} 分钟）。服务端可能仍在生成，请稍后检查，避免立即重复提交。",
            crate::llm::factory::LLM_REQUEST_TIMEOUT.as_secs() / 60
        ));
    }

    let mut message = format!("OpenAI 请求失败: {error}");
    let mut source = error.source();
    while let Some(cause) = source {
        let detail = cause.to_string();
        if !message.ends_with(&detail) {
            message.push_str(": ");
            message.push_str(&detail);
        }
        source = cause.source();
    }
    AppError::Other(message)
}

pub fn normalize_openai_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    match reqwest::Url::parse(trimmed) {
        Ok(url) if url.path() == "/" => format!("{trimmed}/v1"),
        _ => trimmed.to_string(),
    }
}

fn parse_json_response(body: &str, content_type: &str) -> AppResult<Value> {
    serde_json::from_str(body).map_err(|error| {
        AppError::Other(format!(
            "OpenAI response is not JSON ({content_type}): {error}. Body: {}",
            body_snippet(body)
        ))
    })
}

/// 把 ChatRequest 转成 OpenAI /chat/completions body。
/// cacheable_context 与 system 合并进首条 system 消息。
/// 注意：cacheable_context（整篇字幕）放在最前面，按任务变化的 system 指令放在其后。
/// DeepSeek/OpenAI 按消息前缀自动缓存，同一视频的多个 AI 任务字幕逐字节相同，
/// 把它当共享前缀，后续任务即可命中缓存（约便宜 4 倍），不再每个任务重算整篇字幕。
pub fn build_openai_body(req: &ChatRequest) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    let system = match (&req.system, &req.cacheable_context) {
        (Some(s), Some(c)) => Some(format!("{c}\n\n{s}")),
        (Some(s), None) => Some(s.clone()),
        (None, Some(c)) => Some(c.clone()),
        (None, None) => None,
    };
    if let Some(s) = system {
        messages.push(json!({"role": "system", "content": s}));
    }
    for m in &req.messages {
        messages.push(message_body(m));
    }
    // 不发 max_tokens：OpenAI 规范里它可选，省略后模型用自身的最大输出预算，
    // 免得我们写死的上限把长输出（出题/纠错的 JSON）截断。
    // ChatRequest 上原本有这个字段，但没有任何通道读它，已删——别再加回来。
    let mut body = json!({
        "model": req.model,
        "messages": messages,
        "temperature": crate::llm::round_temperature(req.temperature),
    });
    // 不带工具时连字段都不出现：现有那些任务的请求体保持逐字节不变，
    // 既不影响前缀缓存，也不会让某些兼容端点因为多了个空数组而报错。
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(req.tools.iter().map(tool_body).collect());
    }
    body
}

fn tool_body(tool: &crate::llm::ToolSpec) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        }
    })
}

/// 把一条消息转成请求体里的一项。三种形态：普通文本、模型要求调工具、工具执行结果。
fn message_body(m: &crate::llm::ChatMessage) -> Value {
    if let Some(call_id) = &m.tool_call_id {
        return json!({"role": "tool", "tool_call_id": call_id, "content": m.content});
    }
    if !m.tool_calls.is_empty() {
        // 它顺带说了话就把话发回去；真没说才发 null。
        // 不能发空串——一些端点会当成「助手说了句空话」，下一轮推理跟着跑偏。
        let content = if m.content.is_empty() {
            Value::Null
        } else {
            Value::String(m.content.clone())
        };
        return json!({
            "role": "assistant",
            "content": content,
            "tool_calls": m.tool_calls.iter().map(|c| json!({
                "id": c.id,
                "type": "function",
                "function": {"name": c.name, "arguments": c.arguments},
            })).collect::<Vec<_>>(),
        });
    }
    json!({"role": m.role, "content": m.content})
}

pub fn parse_openai_response(v: &Value) -> AppResult<ChatResponse> {
    let message = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .ok_or_else(|| AppError::Other(format!("unexpected OpenAI response: {v}")))?;
    let tool_calls = parse_tool_calls(message);
    // 模型决定调工具时 content 是 null——这是**正常**响应，不是格式错误。
    // 原来这里强求 content 必须是字符串，一旦带上工具，第一次调用就会被判成
    // 「unexpected OpenAI response」，而真相是模型正常地要求调工具。
    let content = message.get("content").and_then(|t| t.as_str());
    if content.is_none() && tool_calls.is_empty() {
        return Err(AppError::Other(format!("unexpected OpenAI response: {v}")));
    }
    Ok(ChatResponse {
        content: content.unwrap_or_default().to_string(),
        tool_calls,
    })
}

/// 从一条 assistant 消息里取出工具调用。缺字段的项直接跳过而不是整体报错：
/// 少一次调用最多是这一轮没干成，能让模型重试；整体报错则是把整段对话打断。
fn parse_tool_calls(message: &Value) -> Vec<crate::llm::ToolCall> {
    let Some(items) = message.get("tool_calls").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let function = item.get("function")?;
            Some(crate::llm::ToolCall {
                id: item.get("id").and_then(Value::as_str)?.to_string(),
                name: function.get("name").and_then(Value::as_str)?.to_string(),
                // 缺 arguments 视为空对象：模型对无参工具经常什么都不给。
                arguments: function
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("{}")
                    .to_string(),
            })
        })
        .collect()
}

pub async fn complete(
    base_url: &str,
    api_key: &str,
    client: &reqwest::Client,
    req: &ChatRequest,
) -> AppResult<ChatResponse> {
    let url = format!("{}/chat/completions", normalize_openai_base_url(base_url));
    let resp = client
        .post(url)
        .bearer_auth(api_key)
        .json(&build_openai_body(req))
        .send()
        .await
        .map_err(request_error)?;
    let content_type = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown")
        .to_string();
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "OpenAI {status}: {}",
            body_snippet(&body)
        )));
    }
    let body = resp.text().await.map_err(request_error)?;
    let v = parse_json_response(&body, &content_type)?;
    parse_openai_response(&v)
}

pub fn build_embeddings_body(model: &str, inputs: &[String]) -> Value {
    json!({ "model": model, "input": inputs })
}

pub fn parse_embeddings_response(v: &Value) -> AppResult<Vec<Vec<f32>>> {
    let data = v
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| AppError::Other(format!("unexpected embeddings response: {v}")))?;
    let mut out = Vec::with_capacity(data.len());
    for item in data {
        let vec = item
            .get("embedding")
            .and_then(|e| e.as_array())
            .ok_or_else(|| AppError::Other("embedding item missing 'embedding'".into()))?
            .iter()
            .map(|n| n.as_f64().unwrap_or(0.0) as f32)
            .collect();
        out.push(vec);
    }
    Ok(out)
}

pub async fn embed(
    base_url: &str,
    api_key: &str,
    client: &reqwest::Client,
    model: &str,
    inputs: &[String],
) -> AppResult<Vec<Vec<f32>>> {
    let url = format!("{}/embeddings", normalize_openai_base_url(base_url));
    let resp = client
        .post(url)
        .bearer_auth(api_key)
        .json(&build_embeddings_body(model, inputs))
        .send()
        .await
        .map_err(request_error)?;
    let content_type = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown")
        .to_string();
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "OpenAI embeddings {status}: {}",
            body_snippet(&body)
        )));
    }
    let body = resp.text().await.map_err(request_error)?;
    let v = parse_json_response(&body, &content_type)?;
    parse_embeddings_response(&v)
}

/// 解析一行 OpenAI SSE。content 优先；推理模型（DeepSeek-R1 等）的思考在
/// `delta.reasoning_content`（部分实现叫 `reasoning`），标记为 Reasoning 不计入答案。
pub fn parse_openai_sse_line(line: &str) -> SseEvent {
    let Some(data) = line.strip_prefix("data:").map(str::trim) else {
        return SseEvent::Ignore;
    };
    if data.is_empty() {
        return SseEvent::Ignore;
    }
    if data == "[DONE]" {
        return SseEvent::Finished;
    }
    let Ok(v) = serde_json::from_str::<Value>(data) else {
        return SseEvent::Ignore;
    };
    if let Some(error) = v.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return SseEvent::Failed(message.to_string());
    }
    let Some(choice) = v.get("choices").and_then(|c| c.get(0)) else {
        return SseEvent::Ignore;
    };
    if let Some(delta) = choice.get("delta") {
        if let Some(content) = delta.get("content").and_then(Value::as_str) {
            if !content.is_empty() {
                return SseEvent::Content(content.to_string());
            }
        }
        for field in ["reasoning_content", "reasoning"] {
            if let Some(r) = delta.get(field).and_then(Value::as_str) {
                if !r.is_empty() {
                    return SseEvent::Reasoning(r.to_string());
                }
            }
        }
        // 工具调用碎片。放在 content/reasoning 之后判断：同一片 delta 里这三者
        // 实际上互斥，但真出现混合时正文优先，免得答案被吞掉。
        if let Some(items) = delta.get("tool_calls").and_then(Value::as_array) {
            // 遍历全部而不是只取第 0 个：一条 delta 里塞多个 index 是允许的，
            // 只读第一个会把其余的静默丢掉——丢掉的那次调用不会报错，只是永远不执行。
            let deltas: Vec<crate::llm::ToolCallDelta> = items
                .iter()
                .map(|item| {
                    let function = item.get("function");
                    crate::llm::ToolCallDelta {
                        // index 缺席时按 0 处理：只有一个调用的服务端有时省略它。
                        index: item.get("index").and_then(Value::as_u64).unwrap_or(0) as usize,
                        id: item
                            .get("id")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string),
                        name: function
                            .and_then(|f| f.get("name"))
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string),
                        arguments: function
                            .and_then(|f| f.get("arguments"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    }
                })
                .collect();
            if !deltas.is_empty() {
                return SseEvent::ToolCallDeltas(deltas);
            }
        }
    }
    // 有些 OpenAI 兼容服务不发 [DONE]，但都会在最后一块给出非空 finish_reason。
    // 两者认其一，既能识破「断在半截」，又不会把这些服务全判成失败。
    if choice
        .get("finish_reason")
        .is_some_and(|reason| !reason.is_null())
    {
        return SseEvent::Finished;
    }
    SseEvent::Ignore
}

pub async fn complete_stream(
    base_url: &str,
    api_key: &str,
    client: &reqwest::Client,
    req: &ChatRequest,
    cancel: &AtomicBool,
    on_piece: &mut (dyn FnMut(StreamPiece) + Send),
) -> AppResult<StreamOutcome> {
    let url = format!("{}/chat/completions", normalize_openai_base_url(base_url));
    let mut body = build_openai_body(req);
    body["stream"] = json!(true);
    let resp = client
        .post(url)
        .bearer_auth(api_key)
        .header(CONTENT_TYPE, "application/json")
        // 显式声明接收 SSE：部分 OpenAI 兼容服务/反向代理只有在收到该头时才真正流式，
        // 否则会把整个响应缓冲后一次返回（表现为「答案一次性蹦出、不逐字」）。
        .header(reqwest::header::ACCEPT, "text/event-stream")
        // 阻止中间代理对 SSE 流启用压缩：压缩会让代理缓冲完整响应后再发送，
        // 导致 bytes_stream 一次性收到全文，token 逐字推送失效。
        .header("Accept-Encoding", "identity")
        .json(&body)
        .send()
        .await
        .map_err(request_error)?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "OpenAI {status}: {}",
            body_snippet(&text)
        )));
    }
    let mut state = StreamState::default();
    let mut stream = resp.bytes_stream();
    loop {
        match next_stream_item_or_cancel(&mut stream, cancel).await {
            StreamWait::Item(chunk) => {
                // 取消可能与网络结果同时到达；沿用原来的优先级，停止优先于解析 chunk/错误。
                if cancel.load(Ordering::SeqCst) {
                    state.canceled = true;
                    break;
                }
                let bytes = chunk.map_err(request_error)?;
                if state.feed(&bytes, cancel, on_piece)? {
                    break;
                }
                // 每个 chunk 处理完后主动 yield，让 Tokio 把累积的 channel.send 投递到前端。
                tokio::task::yield_now().await;
            }
            StreamWait::End => break,
            StreamWait::Canceled => {
                state.canceled = true;
                break;
            }
        }
    }
    state.finish()
}

enum StreamWait<T> {
    Item(T),
    End,
    Canceled,
}

/// 等下一块网络数据时也定期看取消标志。
///
/// 只在拿到 chunk 后检查会漏掉最需要取消的情况：连接已经建立，但服务端一直不再发送数据。
async fn next_stream_item_or_cancel<S>(stream: &mut S, cancel: &AtomicBool) -> StreamWait<S::Item>
where
    S: futures_util::Stream + Unpin,
{
    loop {
        if cancel.load(Ordering::SeqCst) {
            return StreamWait::Canceled;
        }
        tokio::select! {
            item = stream.next() => {
                return match item {
                    Some(item) => StreamWait::Item(item),
                    None => StreamWait::End,
                };
            }
            _ = tokio::time::sleep(STREAM_CANCEL_POLL_INTERVAL) => {}
        }
    }
}

/// SSE 流的状态机，从网络里拆出来单独放。
///
/// 拆出来是为了能测：带工具的流式路径此前**从没跑过**——单元测试只覆盖了单行解析和
/// 碎片累加器，而「一段段字节喂进来、切行、分派、拼装」这层接线是靠真实请求才走得到的。
/// 现在可以直接喂字节。
#[derive(Default)]
struct StreamState {
    acc: String,
    tools: crate::llm::ToolCallAccumulator,
    /// 字节缓冲，不是字符串缓冲：中文字符会被切在 chunk 中间，见 [`take_sse_line`]。
    buf: Vec<u8>,
    finished: bool,
    canceled: bool,
}

impl StreamState {
    /// 吃进一段字节。返回 true 表示该停下了（被取消）。
    fn feed(
        &mut self,
        bytes: &[u8],
        cancel: &AtomicBool,
        on_piece: &mut (dyn FnMut(StreamPiece) + Send),
    ) -> AppResult<bool> {
        self.buf.extend_from_slice(bytes);
        // 按行处理，保留最后一段不完整行到下次。
        while let Some(line) = take_sse_line(&mut self.buf) {
            if cancel.load(Ordering::SeqCst) {
                self.canceled = true;
                return Ok(true);
            }
            match parse_openai_sse_line(line.trim_end()) {
                // 推理模型的「思考」内容：流式给前端展示，但不计入最终答案。
                SseEvent::Reasoning(delta) => on_piece(StreamPiece::Reasoning(&delta)),
                SseEvent::Content(delta) => {
                    on_piece(StreamPiece::Content(&delta));
                    self.acc.push_str(&delta);
                }
                SseEvent::ToolCallDeltas(deltas) => {
                    for delta in deltas {
                        self.tools.push(delta);
                    }
                }
                SseEvent::Finished => self.finished = true,
                SseEvent::Failed(message) => {
                    return Err(AppError::Other(format!("OpenAI 流内错误: {message}")))
                }
                SseEvent::Ignore => {}
            }
        }
        Ok(false)
    }

    fn finish(self) -> AppResult<StreamOutcome> {
        // 用户主动停止时，已经吐出来的那部分就是他要的，照常返回。
        if !self.finished && !self.canceled {
            return Err(AppError::Other(
                "OpenAI 流在结束标记之前就断了，这次回答不完整".into(),
            ));
        }
        Ok(StreamOutcome {
            content: self.acc,
            tool_calls: self.tools.finish(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::ChatMessage;

    /// 把整段 SSE 按给定大小切块喂进状态机，模拟网络分包。
    fn drive(sse: &str, chunk_size: usize) -> AppResult<StreamOutcome> {
        let cancel = AtomicBool::new(false);
        let mut state = StreamState::default();
        let mut seen = String::new();
        for chunk in sse.as_bytes().chunks(chunk_size) {
            let stop = state.feed(chunk, &cancel, &mut |piece| {
                if let StreamPiece::Content(d) = piece {
                    seen.push_str(d);
                }
            })?;
            if stop {
                break;
            }
        }
        let outcome = state.finish()?;
        assert_eq!(seen, outcome.content, "回调吐出的和累积的必须一致");
        Ok(outcome)
    }

    /// 一段真实形状的流：先说一句话，再分片要求调两个工具，最后 [DONE]。
    const TOOL_STREAM: &str = concat!(
        r#"data: {"choices":[{"delta":{"content":"我先查一下"}}]}"#,
        "\n\n",
        r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"search_content","arguments":""}}]}}]}"#,
        "\n\n",
        r#"data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"open_video","arguments":""}}]}}]}"#,
        "\n\n",
        r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"query\":\"双曲"}}]}}]}"#,
        "\n\n",
        r#"data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\"video_id\":\"v9\"}"}}]}}]}"#,
        "\n\n",
        r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"线\"}"}}]}}]}"#,
        "\n\n",
        r#"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
        "\n\n",
        "data: [DONE]\n\n",
    );

    #[test]
    fn a_whole_tool_call_stream_reassembles_however_the_network_splits_it() {
        // 这条路线上从没跑过：此前只测了「单行解析」和「碎片累加器」，
        // 中间那层接线（字节切行 → 分派 → 拼装）是靠真实请求才走得到的。
        // 逐字节喂是最狠的切法：每个多字节汉字、每段 JSON 都会被切开。
        for chunk_size in [1, 3, 7, 64, 4096] {
            let out = drive(TOOL_STREAM, chunk_size).unwrap();
            assert_eq!(out.content, "我先查一下", "chunk={chunk_size} 正文被切坏了");
            assert_eq!(out.tool_calls.len(), 2, "chunk={chunk_size}");
            assert_eq!(out.tool_calls[0].name, "search_content");
            assert_eq!(
                out.tool_calls[0].arguments, r#"{"query":"双曲线"}"#,
                "chunk={chunk_size} 入参跨片没拼对"
            );
            assert_eq!(out.tool_calls[1].name, "open_video");
            assert_eq!(out.tool_calls[1].arguments, r#"{"video_id":"v9"}"#);
        }
    }

    #[test]
    fn a_stream_cut_before_the_end_marker_is_an_error_not_a_short_answer() {
        // 半截回答和完整回答在界面上看不出区别，而它还会被存进笔记和题库。
        let truncated = r#"data: {"choices":[{"delta":{"content":"讲到一半"}}]}"#;
        assert!(drive(truncated, 8).is_err());
    }

    #[test]
    fn canceling_midstream_keeps_what_already_arrived() {
        let cancel = AtomicBool::new(false);
        let mut state = StreamState::default();
        let first = concat!(
            r#"data: {"choices":[{"delta":{"content":"已经收到"}}]}"#,
            "\n\n"
        );
        let mut seen = String::new();
        assert!(!state
            .feed(first.as_bytes(), &cancel, &mut |piece| {
                if let StreamPiece::Content(delta) = piece {
                    seen.push_str(delta);
                }
            })
            .unwrap());

        cancel.store(true, Ordering::SeqCst);
        let stop = state
            .feed(TOOL_STREAM.as_bytes(), &cancel, &mut |_| {})
            .unwrap();
        assert!(stop, "取消要让上层停下");
        // 用户主动停止时，已经吐出来的那部分就是他要的，不该报错。
        let outcome = state.finish().unwrap();
        assert_eq!(seen, "已经收到");
        assert_eq!(outcome.content, "已经收到");
    }

    #[tokio::test]
    async fn cancel_interrupts_a_stream_that_never_produces_another_chunk() {
        let cancel = AtomicBool::new(false);
        let mut stream = futures_util::stream::pending::<()>();

        let result = tokio::time::timeout(Duration::from_secs(1), async {
            let wait = next_stream_item_or_cancel(&mut stream, &cancel);
            let cancel_later = async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                cancel.store(true, Ordering::SeqCst);
            };
            let (result, ()) = tokio::join!(wait, cancel_later);
            result
        })
        .await
        .expect("等待无数据的流也应在取消后很快返回");

        assert!(matches!(result, StreamWait::Canceled));
    }

    #[test]
    fn an_assistant_turn_keeps_what_the_model_said_alongside_its_tool_calls() {
        // 原来一律发 null，等于把模型自己说过的话从它的上下文里抹掉，
        // 下一轮它看不到自己刚才的交代，容易把同一件事再解释一遍。
        let mut req = sample_req();
        req.messages = vec![ChatMessage::tool_calls(
            "我先查一下",
            vec![crate::llm::ToolCall {
                id: "c1".into(),
                name: "probe".into(),
                arguments: "{}".into(),
            }],
        )];
        let body = build_openai_body(&req);
        let turn = &body["messages"][1];
        assert_eq!(turn["content"], "我先查一下");

        // 真没说话时仍然发 null——空串会被一些端点当成「助手说了句空话」。
        req.messages = vec![ChatMessage::tool_calls(
            "",
            vec![crate::llm::ToolCall {
                id: "c1".into(),
                name: "probe".into(),
                arguments: "{}".into(),
            }],
        )];
        assert!(build_openai_body(&req)["messages"][1]["content"].is_null());
    }

    #[test]
    fn parses_a_streamed_tool_call_fragment() {
        let first = parse_openai_sse_line(
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"open_video","arguments":""}}]}}]}"#,
        );
        match first {
            SseEvent::ToolCallDeltas(ds) => {
                let d = &ds[0];
                assert_eq!(d.index, 0);
                assert_eq!(d.id.as_deref(), Some("call_1"));
                assert_eq!(d.name.as_deref(), Some("open_video"));
                assert_eq!(d.arguments, "");
            }
            other => panic!("应是工具调用碎片，实际 {other:?}"),
        }

        // 后续碎片只有入参，没有 id / name。
        let more = parse_openai_sse_line(
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"a\":1}"}}]}}]}"#,
        );
        match more {
            SseEvent::ToolCallDeltas(ds) => {
                let d = &ds[0];
                assert!(d.id.is_none() && d.name.is_none());
                assert_eq!(d.arguments, r#"{"a":1}"#);
            }
            other => panic!("应是工具调用碎片，实际 {other:?}"),
        }
    }

    #[test]
    fn two_calls_in_one_delta_are_both_kept() {
        // 同一条 delta 里塞多个 index 是允许的。只读第 0 个的话，第二次调用
        // 不会报错，只是永远不执行——静默少干一件事，最难查。
        let event = parse_openai_sse_line(
            r#"data: {"choices":[{"delta":{"tool_calls":[
                {"index":0,"id":"a","function":{"name":"rename_video","arguments":""}},
                {"index":1,"id":"b","function":{"name":"delete_video","arguments":""}}
            ]}}]}"#,
        );
        match event {
            SseEvent::ToolCallDeltas(ds) => {
                assert_eq!(ds.len(), 2);
                assert_eq!(ds[0].name.as_deref(), Some("rename_video"));
                assert_eq!(ds[1].index, 1);
                assert_eq!(ds[1].id.as_deref(), Some("b"));
            }
            other => panic!("应是两片工具调用，实际 {other:?}"),
        }
    }

    #[test]
    fn a_tool_call_finish_reason_still_counts_as_finished() {
        // 带工具时服务端给的是 finish_reason: "tool_calls"。不认它的话，
        // 这一轮会被当成「流断在半截」而报错——而它其实正常结束了。
        assert_eq!(
            parse_openai_sse_line(
                r#"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#
            ),
            SseEvent::Finished
        );
    }

    #[test]
    fn parses_openai_delta_lines() {
        assert_eq!(
            parse_openai_sse_line(r#"data: {"choices":[{"delta":{"content":"你好"}}]}"#),
            SseEvent::Content("你好".into())
        );
        // 推理模型的思考走 reasoning_content，标记为 Reasoning。
        assert_eq!(
            parse_openai_sse_line(
                r#"data: {"choices":[{"delta":{"reasoning_content":"先想想"}}]}"#
            ),
            SseEvent::Reasoning("先想想".into())
        );
        // 别名 reasoning 也支持。
        assert_eq!(
            parse_openai_sse_line(r#"data: {"choices":[{"delta":{"reasoning":"嗯"}}]}"#),
            SseEvent::Reasoning("嗯".into())
        );
        assert_eq!(parse_openai_sse_line("data: [DONE]"), SseEvent::Finished);
        assert_eq!(parse_openai_sse_line(": comment"), SseEvent::Ignore);
        assert_eq!(parse_openai_sse_line(""), SseEvent::Ignore);
        // role-only delta（无 content）不产出。
        assert_eq!(
            parse_openai_sse_line(r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#),
            SseEvent::Ignore
        );
    }

    #[test]
    fn a_finish_reason_also_counts_as_a_proper_ending() {
        // 有些 OpenAI 兼容服务不发 [DONE]。只认 [DONE] 会把它们全判成「断在半截」。
        assert_eq!(
            parse_openai_sse_line(r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#),
            SseEvent::Finished
        );
        // 中途的块 finish_reason 是 null，不算结束。
        assert_eq!(
            parse_openai_sse_line(
                r#"data: {"choices":[{"delta":{"content":"半"},"finish_reason":null}]}"#
            ),
            SseEvent::Content("半".into())
        );
    }

    #[test]
    fn an_in_stream_error_is_not_silently_swallowed() {
        // HTTP 已经 200 了，限流之类的错误改从流里来；当成普通行忽略掉，
        // 用户会收到一个空答案却看不到任何原因。
        assert_eq!(
            parse_openai_sse_line(r#"data: {"error":{"message":"rate limited"}}"#),
            SseEvent::Failed("rate limited".into())
        );
    }

    fn sample_req() -> ChatRequest {
        ChatRequest {
            model: "gpt-4o".into(),
            system: Some("you are helpful".into()),
            cacheable_context: Some("TRANSCRIPT".into()),
            messages: vec![ChatMessage::user("summarize")],
            temperature: 0.3,
            tools: Vec::new(),
        }
    }

    fn weather_tool() -> crate::llm::ToolSpec {
        crate::llm::ToolSpec {
            name: "get_weather".into(),
            description: "查天气".into(),
            parameters: json!({"type":"object","properties":{"city":{"type":"string"}}}),
        }
    }

    #[test]
    fn no_tools_means_the_field_is_absent_entirely() {
        // 现有那些任务的请求体必须保持逐字节不变：多一个空数组既可能打乱前缀缓存，
        // 也可能让个别兼容端点直接报错。
        let body = build_openai_body(&sample_req());
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn tools_are_sent_in_the_function_wrapper_shape() {
        let mut req = sample_req();
        req.tools = vec![weather_tool()];
        let body = build_openai_body(&req);
        let tools = body["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["type"], "function");
        assert_eq!(tools[0]["function"]["name"], "get_weather");
        assert_eq!(tools[0]["function"]["parameters"]["type"], "object");
    }

    #[test]
    fn a_tool_round_trip_serializes_into_three_turns() {
        let mut req = sample_req();
        req.tools = vec![weather_tool()];
        req.messages = vec![
            ChatMessage::user("北京天气怎么样"),
            ChatMessage::tool_calls(
                "",
                vec![crate::llm::ToolCall {
                    id: "call_1".into(),
                    name: "get_weather".into(),
                    arguments: r#"{"city":"北京"}"#.into(),
                }],
            ),
            ChatMessage::tool_result("call_1", "晴，26 度"),
        ];
        let body = build_openai_body(&req);
        let msgs = body["messages"].as_array().unwrap();
        // system + 三轮
        assert_eq!(msgs.len(), 4);

        // 模型要求调工具的那一轮：content 必须是 null，不是空串——
        // 空串会被某些端点当成「助手说了句空话」，下一轮推理跟着跑偏。
        assert_eq!(msgs[2]["role"], "assistant");
        assert!(msgs[2]["content"].is_null());
        assert_eq!(msgs[2]["tool_calls"][0]["id"], "call_1");
        assert_eq!(
            msgs[2]["tool_calls"][0]["function"]["arguments"],
            r#"{"city":"北京"}"#
        );

        // 结果那一轮要带回同一个 id，否则模型对不上是哪次调用。
        assert_eq!(msgs[3]["role"], "tool");
        assert_eq!(msgs[3]["tool_call_id"], "call_1");
        assert_eq!(msgs[3]["content"], "晴，26 度");
    }

    #[test]
    fn a_tool_call_response_parses_even_though_content_is_null() {
        // 模型决定调工具时 content 就是 null。原来的解析强求它是字符串，
        // 于是带工具的第一次调用必然被判成「响应格式异常」。
        let v: Value = serde_json::from_str(
            r#"{
          "choices":[{"message":{"role":"assistant","content":null,"tool_calls":[
            {"id":"call_1","type":"function",
             "function":{"name":"get_weather","arguments":"{\"city\":\"北京\"}"}}
          ]}}]
        }"#,
        )
        .unwrap();
        let resp = parse_openai_response(&v).unwrap();
        assert_eq!(resp.content, "");
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].name, "get_weather");
        assert_eq!(resp.tool_calls[0].arguments, r#"{"city":"北京"}"#);
    }

    #[test]
    fn malformed_tool_arguments_survive_as_text() {
        // 模型给的参数不是合法 JSON 是常事。这里不能报错——报了错用户看到的是
        // 「请求失败」，而真相是模型少写了个引号。原样带出去交给执行方处理。
        let v: Value = serde_json::from_str(
            r#"{
          "choices":[{"message":{"content":null,"tool_calls":[
            {"id":"c1","function":{"name":"f","arguments":"{\"city\": "}}
          ]}}]
        }"#,
        )
        .unwrap();
        let resp = parse_openai_response(&v).unwrap();
        assert_eq!(resp.tool_calls[0].arguments, r#"{"city": "#);
    }

    #[test]
    fn a_plain_answer_still_parses_and_carries_no_tool_calls() {
        let v: Value = serde_json::from_str(
            r#"{"choices":[{"message":{"role":"assistant","content":"你好"}}]}"#,
        )
        .unwrap();
        let resp = parse_openai_response(&v).unwrap();
        assert_eq!(resp.content, "你好");
        assert!(resp.tool_calls.is_empty());
    }

    #[test]
    fn a_response_with_neither_content_nor_tool_calls_is_still_an_error() {
        // 放宽 content 的要求不等于什么都收：真正畸形的响应仍要报出来，
        // 否则会把服务端的异常静默成一个空回答。
        let v: Value =
            serde_json::from_str(r#"{"choices":[{"message":{"role":"assistant"}}]}"#).unwrap();
        assert!(parse_openai_response(&v).is_err());
    }

    #[test]
    fn body_merges_system_and_context() {
        let body = build_openai_body(&sample_req());
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        let system = msgs[0]["content"].as_str().unwrap();
        assert!(system.contains("TRANSCRIPT"));
        assert!(system.contains("you are helpful"));
        // 可缓存的字幕必须排在按任务变化的指令之前，作为共享前缀供缓存命中。
        assert!(
            system.find("TRANSCRIPT").unwrap() < system.find("you are helpful").unwrap(),
            "cacheable context must precede the task-specific system prompt"
        );
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(body["model"], "gpt-4o");
    }

    #[test]
    fn body_quantizes_temperature_to_two_decimals_for_strict_servers() {
        // f32 0.1 加宽到 f64 会变成 0.10000000149011612，GLM 等会拒收。
        let mut req = sample_req();
        req.temperature = 0.1;
        let body = build_openai_body(&req);
        let serialized = serde_json::to_string(&body["temperature"]).unwrap();
        assert_eq!(serialized, "0.1");
    }

    #[test]
    fn body_omits_max_tokens_so_model_uses_full_budget() {
        // OpenAI 规范 max_tokens 可选；不发送，避免人为截断长输出。
        let body = build_openai_body(&sample_req());
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn normalizes_bare_openai_compatible_host_to_v1() {
        assert_eq!(
            normalize_openai_base_url("https://codex.ciii.club"),
            "https://codex.ciii.club/v1"
        );
        assert_eq!(
            normalize_openai_base_url("https://api.openai.com/v1/"),
            "https://api.openai.com/v1"
        );
    }

    #[test]
    fn parse_json_response_reports_html_body() {
        let err = parse_json_response("<!doctype html><html></html>", "text/html").unwrap_err();
        assert!(err.to_string().contains("not JSON"));
        assert!(err.to_string().contains("<!doctype html>"));
    }

    #[test]
    fn parses_choice_content() {
        let v = serde_json::json!({
            "choices": [{"message": {"content": "result text"}}]
        });
        assert_eq!(parse_openai_response(&v).unwrap().content, "result text");
    }

    #[test]
    fn parse_errors_on_bad_shape() {
        assert!(parse_openai_response(&serde_json::json!({"x": 1})).is_err());
    }

    #[test]
    fn builds_and_parses_embeddings() {
        let body = build_embeddings_body("text-embedding-3-small", &["a".into(), "b".into()]);
        assert_eq!(body["input"].as_array().unwrap().len(), 2);
        let v = serde_json::json!({
            "data": [{"embedding": [0.1, 0.2]}, {"embedding": [0.3, 0.4]}]
        });
        let parsed = parse_embeddings_response(&v).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1], vec![0.3f32, 0.4f32]);
    }
}
