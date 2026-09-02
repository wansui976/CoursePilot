//! 工具调用循环：让模型自己决定调哪个能力，直到它给出答复。
//!
//! 这一层**只管循环**，不管有哪些工具、更不管工具能干什么。工具的注册与执行由调用方
//! 通过 [`ToolBox`] 提供——助手要能改数据，而「改什么算安全、什么必须先问过用户」是
//! 产品决定，不该埋在这里。
//!
//! 三条硬约束，都是这个循环必须自带的：
//!
//! 1. **轮次有上限**。模型能自己跟自己调一晚上工具，每一轮的结果又都留在上下文里，
//!    成本是乘法涨的。撞到上限时会再发一次不带工具的总结请求，把已经拿到的资料整理出来。
//! 2. **随时可取消**。用户点停止之后，正在等的那次模型调用要断，已经排上的工具不再执行。
//! 3. **工具失败不等于整轮失败**。执行出错时把错误当成工具结果喂回去，模型有机会换个
//!    参数重试或者改口说做不到；直接抛错则是把整段对话打断，用户只看到一个红条。

use crate::error::{AppError, AppResult};
use crate::llm::{ChatMessage, ChatRequest, Provider, ToolCall, ToolSpec};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

/// 带工具的循环最多来回几次。
///
/// 总结请求不计入这个上限：第 6 轮工具结果回来后，最多再发一次不带工具的模型请求，
/// 避免模型已经查到资料却因为封顶只能把「我先查一下」交给用户。
pub const MAX_TURNS: usize = 6;
const MAX_TOOL_CALLS: usize = 24;
const MAX_TOOL_RESULT_CHARS: usize = 12_000;
const MAX_TOTAL_TOOL_RESULT_CHARS: usize = 32_000;
const TOOL_BUDGET_EXHAUSTED: &str =
    "工具预算已用完，本次调用未执行。请直接基于已有结果总结，不要继续调用工具。";
const TOOL_RESULT_TRUNCATED: &str = "\n（工具结果已按本轮上下文预算截断；请基于现有内容总结。）";

const FORCE_SUMMARY_INSTRUCTION: &str =
    "工具调用轮次或上下文预算已经达到上限。请基于上面已经获得的工具结果，\
直接给用户完整、准确、简洁的最终答复；不要再调用工具，也不要只说正在查询。\
如果现有资料不足，请明确说明不足之处以及已经能够确认的内容。";

/// 助手流式调用的抖动重试退避（秒），与批量管线的 `DIGEST_CHUNK_BACKOFF_SECS`
/// 同一模式：429/5xx/超时先别急着红条，等一会儿再发一次。测试时归零，不让
/// 断言等上真实的退避时长。
#[cfg(not(test))]
const AGENT_STREAM_RETRY_BACKOFF_SECS: &[u64] = &[2, 4];
#[cfg(test)]
const AGENT_STREAM_RETRY_BACKOFF_SECS: &[u64] = &[0, 0];

/// 一次工具执行的结果。
///
/// 失败也是一种结果，不是错误：`Err` 会打断整段对话，而把失败文本喂回去，
/// 模型能换个参数重试，或者老实告诉用户这件事没做成。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolExecutionStatus {
    Completed,
    Failed,
    Canceled,
}

impl ToolExecutionStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }
}

pub struct ToolOutcome {
    pub content: String,
    pub status: ToolExecutionStatus,
}

impl ToolOutcome {
    pub fn ok(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            status: ToolExecutionStatus::Completed,
        }
    }

    /// 执行失败。文本会原样进入模型的上下文，所以要写成模型看得懂、
    /// 能据此改正的话，而不是内部堆栈。
    pub fn failed(reason: impl std::fmt::Display) -> Self {
        Self {
            content: format!(
                "工具执行失败：{reason}。请据此调整参数重试，或告诉用户这件事没做成。"
            ),
            status: ToolExecutionStatus::Failed,
        }
    }
}

/// 工具进入领域执行前的通用检查。
///
/// 这里只验证所有工具都共有、且不需要理解 JSON Schema 的边界：名称必须在本次注册表里，
/// 参数必须是合法 JSON 对象。required 字段、枚举、资源 id 等业务约束仍交给具体工具解析，
/// 避免在通用层复制一套不完整的 schema validator。
fn preflight_tool_call(specs: &[ToolSpec], call: &ToolCall) -> Result<(), ToolOutcome> {
    if !specs.iter().any(|spec| spec.name == call.name) {
        return Err(ToolOutcome::failed(format!(
            "没有名为 {} 的工具。请只使用本次提供的工具，不要编造工具名",
            call.name
        )));
    }

    let arguments: serde_json::Value = serde_json::from_str(&call.arguments).map_err(|error| {
        ToolOutcome::failed(format!(
            "{} 的参数不是合法 JSON（{error}）。收到的是：{}",
            call.name, call.arguments
        ))
    })?;
    if !arguments.is_object() {
        return Err(ToolOutcome::failed(format!(
            "{} 的参数必须是 JSON 对象，不能是数组、字符串、数字或 null",
            call.name
        )));
    }
    Ok(())
}

/// 调用方要提供的工具集：报出有哪些工具，以及怎么执行一次已经通过 preflight 的调用。
#[allow(async_fn_in_trait)] // 只在本进程内实现与调用，不需要 Send 边界。
pub trait ToolBox {
    fn specs(&self) -> Vec<ToolSpec>;

    fn preflight(&self, call: &ToolCall) -> Result<(), ToolOutcome> {
        preflight_tool_call(&self.specs(), call)
    }

    /// 工具是否只读（不产生副作用，可与其他只读工具并发执行）。
    ///
    /// 默认 false 保守安全：只有声明了只读的调用才会进并发批次，
    /// 写操作永远串行，模型依赖上一笔副作用时行为不变。
    fn is_read_only(&self, _name: &str) -> bool {
        false
    }

    async fn run_unchecked(&self, call: &ToolCall) -> ToolOutcome;

    /// 业务调用方使用的标准入口。Agent 循环只在自己已经完成同一 preflight 后，
    /// 才会为取消轮询直接进入 `run_unchecked`。
    async fn run(&self, call: &ToolCall) -> ToolOutcome {
        match self.preflight(call) {
            Ok(()) => self.run_unchecked(call).await,
            Err(outcome) => outcome,
        }
    }
}

/// 循环过程中的进度，交给调用方决定怎么显示。
pub enum AgentEvent<'a> {
    /// 新的一轮开始了（1 起算）。
    ///
    /// 界面必须知道这条：循环里 `answer` 是**逐轮替换**而不是追加的，
    /// 第二轮的正文接在第一轮后面就会拼出一段谁也没说过的话。收到它就把已显示的
    /// 答案清空重来。
    TurnStarted(usize),
    /// 推理模型的思考增量。不计入答案，只用于显示。
    Reasoning(&'a str),
    /// 正文增量。
    Content(&'a str),
    /// 模型这一轮要求调某个工具，即将执行。
    ToolStarted(&'a ToolCall),
    /// 该工具执行完毕（成功与否都算完毕）。状态由工具结果或 future 中断直接确定，
    /// 不从结果文本或整轮取消标志事后推断。
    ToolFinished {
        call: &'a ToolCall,
        status: ToolExecutionStatus,
    },
    /// 带工具的循环撞到轮次或上下文预算上限，已经转入强制总结。
    HitTurnLimit,
}

/// Agent 循环为什么结束。
///
/// `canceled` 和 `hit_turn_limit` 两个兼容布尔值不足以区分“正常完成”和“封顶后总结成功”。
/// 显式终态既用于运行追踪，也为后续检查点恢复提供稳定协议。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStopReason {
    /// 模型未再请求工具，正常给出最终答复。
    Completed,
    /// 工具链达到轮次或上下文预算上限，但额外的无工具总结成功。
    SummarizedAfterLimit,
    /// 用户主动停止。
    Canceled,
    /// 工具链封顶后的总结为空或失败，未得到可靠最终答复。
    LimitReached,
}

impl AgentStopReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::SummarizedAfterLimit => "summarized_after_limit",
            Self::Canceled => "canceled",
            Self::LimitReached => "limit_reached",
        }
    }
}

/// 一次完整循环的结果。
pub struct AgentOutcome {
    /// 模型最终说的话。强制总结失败或中途取消时，这里可能仍是最后一轮过场话。
    pub answer: String,
    /// 整段对话（含工具往返），供调用方接着追问。
    pub messages: Vec<ChatMessage>,
    /// 实际来回了几轮。
    pub turns: usize,
    /// 是否由用户主动停止。撞工具轮次或上下文预算上限不算取消。
    pub canceled: bool,
    /// 是否转到工具轮次或上下文预算上限后仍未得到可用的最终答复。
    ///
    /// 调用方必须往下传给界面。强制总结成功时该字段为 false；总结失败时，界面应提示用户
    /// 这次查询没有得出结论，而不是把过场话（「我先查一下课程列表」）当成答案。
    pub hit_turn_limit: bool,
    /// 唯一终态。上面的兼容布尔值必须由它推导，不能形成互相矛盾的组合。
    pub stop_reason: AgentStopReason,
    /// 循环里全部模型请求的 token 用量合计（含工具轮与强制总结）。
    /// 端点不报则保持 None；只要报过就逐次累加，供界面把这一轮的实际成本展示给用户。
    pub usage: Option<crate::llm::Usage>,
}

impl AgentOutcome {
    fn finished(
        answer: String,
        messages: Vec<ChatMessage>,
        turns: usize,
        stop_reason: AgentStopReason,
        usage: Option<crate::llm::Usage>,
    ) -> Self {
        Self {
            answer,
            messages,
            turns,
            usage,
            canceled: stop_reason == AgentStopReason::Canceled,
            hit_turn_limit: stop_reason == AgentStopReason::LimitReached,
            stop_reason,
        }
    }
}

/// 执行一个工具，同时轮询用户取消标志。
///
/// 工具可能包含网络请求或全库检索，只在调用前后检查一次会让「停止」一直等到工具自己的
/// 超时。返回 `None` 时当前工具 future 已被丢弃；调用方仍要为这次 tool_call 补一条结果，
/// 保持后续会话结构完整。
async fn run_tool_or_cancel<T: ToolBox>(
    tools: &T,
    call: &ToolCall,
    cancel: &AtomicBool,
) -> Option<ToolOutcome> {
    if cancel.load(Ordering::SeqCst) {
        return None;
    }

    // 调用方已经在发出 ToolStarted 前完成 preflight；这里不能再走带 preflight 的
    // `ToolBox::run`，否则同一调用会重复解析参数。
    let pending = tools.run_unchecked(call);
    tokio::pin!(pending);
    loop {
        tokio::select! {
            outcome = &mut pending => return Some(outcome),
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                if cancel.load(Ordering::SeqCst) {
                    return None;
                }
            }
        }
    }
}

fn cap_tool_result(content: String, remaining_chars: usize) -> (String, usize, bool) {
    let limit = remaining_chars.min(MAX_TOOL_RESULT_CHARS);
    let original_chars = content.chars().count();
    if original_chars <= limit {
        return (content, original_chars, false);
    }

    let suffix_chars = TOOL_RESULT_TRUNCATED.chars().count();
    let kept_chars = limit.saturating_sub(suffix_chars);
    let mut capped: String = content.chars().take(kept_chars).collect();
    capped.extend(TOOL_RESULT_TRUNCATED.chars().take(limit - kept_chars));
    let used = capped.chars().count();
    (capped, used, true)
}

/// 工具循环跨批次累计的状态：调用数与结果字符预算。
///
/// 拆成批量执行后各批次必须共享同一份累计，预算检查才不会被每个批次开头「归零」。
#[derive(Default)]
struct ToolLoopState {
    tool_calls: usize,
    tool_result_chars: usize,
    budget_exhausted: bool,
}

/// 执行一批类型一致的调用（全部只读或全部非只读）。
///
/// 调用方保证：多调用批次只含只读工具，非只读调用永远是单元素批次（写操作必须串行）。
/// 因此这里对批内调用一律并发（`join_all`）；单元素批次并发与否在时序上没有差别。
///
/// 对外观察行为与原串行循环逐条一致，只是把执行段重叠起来：
/// - 取消后不再执行剩下的工具，但每条调用都补一条结果，保持消息结构完整；
/// - 预算封顶后剩余的调用补 `TOOL_BUDGET_EXHAUSTED`，并置位 `budget_exhausted`；
/// - 被 preflight 拒绝的调用不发 ToolStarted/ToolFinished（从未进入执行）；
/// - 事件按调用序号成对发出，tool result 按序号写回，前端看到的顺序不受并发影响。
async fn run_batch<'a, T: ToolBox>(
    tools: &T,
    batch: &'a [ToolCall],
    cancel: &AtomicBool,
    on_event: &mut (dyn FnMut(AgentEvent<'a>) + Send),
    messages: &mut Vec<ChatMessage>,
    state: &mut ToolLoopState,
) {
    enum Pending<'a> {
        Run { call: &'a ToolCall },
        Rejected { call: &'a ToolCall, outcome: ToolOutcome },
        Canceled { call: &'a ToolCall },
        Exhausted { call: &'a ToolCall },
    }

    // 第一遍只做决定、不落结果：占位与执行结果都留到最后统一按调用序号写回，
    // 否则并发批次里先处理的占位会跑到还没执行完的结果前面，消息顺序就乱了。
    let mut pending: Vec<Pending<'a>> = Vec::with_capacity(batch.len());
    let mut futures = Vec::with_capacity(batch.len());
    for call in batch {
        // 取消后不再执行剩下的工具，但已经执行过的结果要留在对话里——
        // 缺了任何一条结果，下一次请求同样是孤儿调用。
        if cancel.load(Ordering::SeqCst) {
            pending.push(Pending::Canceled { call });
            continue;
        }
        if state.tool_calls >= MAX_TOOL_CALLS
            || state.tool_result_chars >= MAX_TOTAL_TOOL_RESULT_CHARS
        {
            pending.push(Pending::Exhausted { call });
            state.budget_exhausted = true;
            continue;
        }
        state.tool_calls += 1;
        match tools.preflight(call) {
            Ok(()) => {
                on_event(AgentEvent::ToolStarted(call));
                pending.push(Pending::Run { call });
                futures.push(run_tool_or_cancel(tools, call, cancel));
            }
            // 被策略拒绝的调用从未进入领域 dispatch，不能对界面谎报成「工具已开始」。
            // 失败仍要作为 tool result 回给模型，保持消息结构完整并允许它修正。
            Err(outcome) => pending.push(Pending::Rejected { call, outcome }),
        }
    }

    // 只读批次在这里并发执行；join_all 保持输入顺序，结果按调用序号回收。
    let mut outcomes = futures_util::future::join_all(futures).await.into_iter();
    for entry in pending {
        let (call, outcome) = match entry {
            Pending::Run { call } => {
                let outcome = outcomes
                    .next()
                    .expect("每个 Run 槽都对应一个 future，join_all 保序返回");
                on_event(AgentEvent::ToolFinished {
                    call,
                    status: outcome
                        .as_ref()
                        .map(|outcome| outcome.status)
                        .unwrap_or(ToolExecutionStatus::Canceled),
                });
                (call, outcome)
            }
            Pending::Rejected { call, outcome } => (call, Some(outcome)),
            Pending::Canceled { call } => {
                messages.push(ChatMessage::tool_result(&call.id, "已取消，未执行。".to_string()));
                continue;
            }
            Pending::Exhausted { call } => {
                messages.push(ChatMessage::tool_result(&call.id, TOOL_BUDGET_EXHAUSTED.to_string()));
                continue;
            }
        };
        let raw_content = outcome
            .map(|outcome| outcome.content)
            .unwrap_or_else(|| "已取消，执行未完成。".to_string());
        let remaining_chars = MAX_TOTAL_TOOL_RESULT_CHARS - state.tool_result_chars;
        let (content, used_chars, truncated) = cap_tool_result(raw_content, remaining_chars);
        state.tool_result_chars += used_chars;
        state.budget_exhausted |=
            truncated || state.tool_result_chars >= MAX_TOTAL_TOOL_RESULT_CHARS;
        messages.push(ChatMessage::tool_result(&call.id, content));
    }
}

fn forced_summary_request(
    model: &str,
    system: Option<&str>,
    messages: Vec<ChatMessage>,
) -> ChatRequest {
    let summary_system = match system {
        Some(base) => format!("{base}\n\n{FORCE_SUMMARY_INSTRUCTION}"),
        None => FORCE_SUMMARY_INSTRUCTION.to_string(),
    };
    ChatRequest {
        model: model.to_string(),
        system: Some(summary_system),
        cacheable_context: None,
        messages,
        temperature: 0.2,
        // 空数组在 OpenAI 请求体里会被完全省略，兼容端点无法继续选择工具。
        tools: Vec::new(),
        label: "assistant",
    }
}

/// 流式调用的抖动重试。
///
/// 网络抖动对批量管线是可重试的（`digest_one_chunk` 有指数退避），同一场抖动
/// 落到助手头上就直接红条，等于把最常用的入口做成了最脆的。重试只在两个条件
/// **同时**成立时发生，其余一律维持现状上抛：
///
/// - 错误本身可重试：`is_permanent` 的（鉴权、余额、参数错）再发一遍还是同一句话，
///   重试只是让用户白等退避。
/// - 本轮尚未吐出任何正文或工具调用：流已经开了再断掉，重发会把前半截再输出一遍，
///   界面出现重复文字比红条更糟。
///
/// 每次重试前查取消标志——用户在失败与重试之间点了停止，就绝不再发请求。
async fn complete_stream_with_retry(
    provider: &Provider,
    req: &ChatRequest,
    cancel: &AtomicBool,
    on_event: &mut (dyn FnMut(AgentEvent) + Send),
) -> AppResult<crate::llm::StreamOutcome> {
    // 闭包要求 Send，用 AtomicBool 而非 Cell；跨不跨线程无所谓，重点是能过边界。
    let emitted = AtomicBool::new(false);
    let mut attempt = 0usize;
    loop {
        let mut on_piece = |piece: crate::llm::StreamPiece| {
            emitted.store(true, Ordering::SeqCst);
            match piece {
                crate::llm::StreamPiece::Content(delta) => on_event(AgentEvent::Content(delta)),
                crate::llm::StreamPiece::Reasoning(delta) => {
                    on_event(AgentEvent::Reasoning(delta))
                }
            }
        };
        match provider.complete_stream(req, cancel, &mut on_piece).await {
            Ok(outcome) => return Ok(outcome),
            Err(error) if error.is_permanent() => return Err(error),
            Err(_error)
                if attempt < AGENT_STREAM_RETRY_BACKOFF_SECS.len()
                    && !emitted.load(Ordering::SeqCst)
                    && !cancel.load(Ordering::SeqCst) =>
            {
                let backoff =
                    std::time::Duration::from_secs(AGENT_STREAM_RETRY_BACKOFF_SECS[attempt]);
                tokio::time::sleep(backoff).await;
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

/// 把一次请求报的用量累加进合计。端点不报（None）就当没发生，不把缺失当成零。
fn accumulate_usage(total: &mut Option<crate::llm::Usage>, incoming: Option<crate::llm::Usage>) {
    let Some(incoming) = incoming else {
        return;
    };
    match total {
        Some(total) => {
            total.prompt_tokens += incoming.prompt_tokens;
            total.cached_tokens += incoming.cached_tokens;
            total.completion_tokens += incoming.completion_tokens;
            total.reasoning_tokens += incoming.reasoning_tokens;
        }
        None => *total = Some(incoming),
    }
}

/// 跑工具调用循环，直到模型给出答复；达到工具轮次或上下文预算上限后再尝试一次无工具总结。
///
/// `messages` 是起始对话（通常是系统状态 + 用户这句话）；返回时会带上循环中产生的
/// 全部往返，调用方原样存下来就能继续追问。
pub async fn run<T: ToolBox>(
    provider: &Provider,
    model: &str,
    system: Option<String>,
    mut messages: Vec<ChatMessage>,
    tools: &T,
    cancel: &AtomicBool,
    on_event: &mut (dyn FnMut(AgentEvent) + Send),
) -> AppResult<AgentOutcome> {
    let specs = tools.specs();
    let mut answer = String::new();
    let mut turns = 0;
    let mut state = ToolLoopState::default();
    let mut usage: Option<crate::llm::Usage> = None;

    'agent: for turn in 0..MAX_TURNS {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        turns = turn + 1;

        let req = ChatRequest {
            model: model.to_string(),
            system: system.clone(),
            cacheable_context: None,
            messages: messages.clone(),
            temperature: 0.2,
            tools: specs.clone(),
            label: "assistant",
        };
        on_event(AgentEvent::TurnStarted(turns));

        // 走流式：思考与正文一边生成一边交给调用方显示。
        // 取消同样不必等到请求超时——complete_stream 在等待网络数据的间隙也查标志，
        // 而这个循环最需要被打断的时刻，恰恰就是某一次调用卡住的时候。
        // 网络抖动由 complete_stream_with_retry 消化：可重试且尚未吐字的失败会退避重发。
        let streamed = complete_stream_with_retry(provider, &req, cancel, on_event).await?;
        accumulate_usage(&mut usage, streamed.usage);
        // 取消时把已经吐出来的半截丢掉：它不是一个完整答复，也没有对应的工具结果。
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let response = crate::llm::ChatResponse {
            content: streamed.content,
            tool_calls: streamed.tool_calls,
            usage: streamed.usage,
        };

        if !response.content.trim().is_empty() {
            answer = response.content.clone();
        }

        // 没有要调的工具 = 它说完了。
        if response.tool_calls.is_empty() {
            messages.push(ChatMessage::assistant(response.content));
            return Ok(AgentOutcome::finished(
                answer,
                messages,
                turns,
                AgentStopReason::Completed,
                usage,
            ));
        }

        // 模型要求调工具的那一轮必须原样放回对话里，后面那些结果才有出处；
        // 少了它，服务端会因为「孤儿 tool 消息」直接拒掉下一次请求。

        messages.push(ChatMessage::tool_calls(
            response.content.clone(),
            response.tool_calls.clone(),
        ));

        // 一轮里的多个调用按「连续只读」并成批次：只读工具不产生动作、不改数据，
        // 天然可并发；写操作保持串行，模型依赖上一笔副作用时行为不变。
        // 事件仍按调用序号成对发出，前端看到的顺序不受并发影响。
        let mut index = 0;
        while index < response.tool_calls.len() {
            if !tools.is_read_only(&response.tool_calls[index].name) {
                // 非只读调用单独成批：绝不与其他调用并发，保持原串行语义。
                run_batch(
                    tools,
                    &response.tool_calls[index..index + 1],
                    cancel,
                    on_event,
                    &mut messages,
                    &mut state,
                )
                .await;
                index += 1;
                continue;
            }
            let batch_start = index;
            while index < response.tool_calls.len()
                && tools.is_read_only(&response.tool_calls[index].name)
            {
                index += 1;
            }
            run_batch(
                tools,
                &response.tool_calls[batch_start..index],
                cancel,
                on_event,
                &mut messages,
                &mut state,
            )
            .await;
        }
        if state.budget_exhausted {
            break 'agent;
        }
    }

    // 被取消不算撞上限。两者都会走到这里，但对用户是两件事：
    // 一个是「你叫停的」，一个是「它自己转不出来了」。
    let canceled = cancel.load(Ordering::SeqCst);
    if (turns >= MAX_TURNS || state.budget_exhausted) && !canceled {
        // 先发出边界事件，让调用方知道工具链已经封顶；随后这一次请求明确不带工具，
        // 只负责把已有检索结果整理成最终答复。总结请求失败时仍保留上限标记。
        on_event(AgentEvent::HitTurnLimit);
        let summary_turn = turns + 1;
        on_event(AgentEvent::TurnStarted(summary_turn));
        let summary_req = forced_summary_request(model, system.as_deref(), messages.clone());
        // 总结请求同样吃抖动重试：它是封顶后的最后一步，抖动把它打掉用户连兜底都没有。
        let summary = match complete_stream_with_retry(provider, &summary_req, cancel, on_event).await
        {
            Ok(summary) => summary,
            // 强制总结是封顶后的兜底。它自己失败时不能把前面已经取得的资料和动作
            // 一起变成命令错误；保留旧结果并让界面明确提示未得出最终结论。
            Err(_) => {
                let canceled = cancel.load(Ordering::SeqCst);
                return Ok(AgentOutcome::finished(
                    answer,
                    messages,
                    summary_turn,
                    if canceled {
                        AgentStopReason::Canceled
                    } else {
                        AgentStopReason::LimitReached
                    },
                    usage,
                ));
            }
        };
        accumulate_usage(&mut usage, summary.usage);
        // 和工具循环一样，取消时丢掉总结请求吐出的半截内容，不把它写进下一轮历史。
        if cancel.load(Ordering::SeqCst) {
            return Ok(AgentOutcome::finished(
                answer,
                messages,
                summary_turn,
                AgentStopReason::Canceled,
                usage,
            ));
        }
        // 兼容端点即使在请求体没有 tools 时仍返回 tool_calls，也绝不执行它们；有正文就
        // 把正文当作总结，否则回退到上限提示，避免再次进入没有边界的工具循环。
        if !summary.content.trim().is_empty() {
            answer = summary.content.clone();
            messages.push(ChatMessage::assistant(summary.content));
            return Ok(AgentOutcome::finished(
                answer,
                messages,
                summary_turn,
                AgentStopReason::SummarizedAfterLimit,
                usage,
            ));
        }
        // 总结没有产出正文：把已取得的资料和过场答复交出去，并保留上限标记，供界面给出
        // 可重试的提示。若 summary 有 tool_calls，不把孤儿调用写进历史。
        return Ok(AgentOutcome::finished(
            answer,
            messages,
            summary_turn,
            AgentStopReason::LimitReached,
            usage,
        ));
    }

    // 没撞上限时只有取消会走到这里：把已经拿到的交出去，不报错。
    Ok(AgentOutcome::finished(
        answer,
        messages,
        turns,
        if canceled {
            AgentStopReason::Canceled
        } else {
            AgentStopReason::Completed
        },
        usage,
    ))
}

/// 解析一次调用的入参。
///
/// 单独拎出来是因为**这里必然会失败**：模型给的 JSON 可能不合法、字段可能缺。
/// 失败的正确处理是变成一条工具结果喂回去，而不是让整轮对话崩掉，所以返回的是
/// `Result<T, ToolOutcome>`——调用方 `?` 一下就能把错误原样交给模型。
pub fn parse_arguments<T: serde::de::DeserializeOwned>(call: &ToolCall) -> Result<T, ToolOutcome> {
    serde_json::from_str(&call.arguments).map_err(|error| {
        ToolOutcome::failed(format!(
            "参数不是合法 JSON 或字段不符（{error}）。收到的是：{}",
            call.arguments
        ))
    })
}

/// 一个工具都没注册时的兜底错误，避免把「没配工具」这件事伪装成模型不肯回答。
pub fn ensure_not_empty(specs: &[ToolSpec]) -> AppResult<()> {
    if specs.is_empty() {
        return Err(AppError::Other("没有注册任何工具，助手无事可做".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::sync::Mutex;

    fn call(id: &str, name: &str, args: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: args.into(),
        }
    }

    fn says(text: &str) -> crate::llm::ChatResponse {
        crate::llm::ChatResponse {
            content: text.into(),
            tool_calls: Vec::new(),
            usage: None,
        }
    }

    fn wants(calls: Vec<ToolCall>) -> crate::llm::ChatResponse {
        crate::llm::ChatResponse {
            content: String::new(),
            tool_calls: calls,
            usage: None,
        }
    }

    fn scripted(steps: Vec<crate::llm::ChatResponse>) -> Provider {
        Provider::Scripted {
            steps: Mutex::new(steps),
        }
    }

    fn flaky(
        failures: usize,
        permanent: bool,
        steps: Vec<crate::llm::ChatResponse>,
        cancel_on_fail: Option<std::sync::Arc<AtomicBool>>,
    ) -> Provider {
        Provider::Flaky {
            failures: Mutex::new(failures),
            permanent,
            message: "网关抖动（测试注入）".into(),
            steps: Mutex::new(steps),
            calls: std::sync::atomic::AtomicUsize::new(0),
            cancel_on_fail,
        }
    }

    #[test]
    fn the_forced_summary_request_disables_tools_and_keeps_the_collected_history() {
        let request = forced_summary_request(
            "m",
            Some("原系统提示"),
            vec![ChatMessage::tool_result("c1", "检索结果")],
        );

        assert!(request.tools.is_empty());
        assert!(request
            .system
            .as_deref()
            .is_some_and(|text| text.contains(FORCE_SUMMARY_INSTRUCTION)));
        assert_eq!(request.messages.len(), 1);
        assert_eq!(request.messages[0].content, "检索结果");
    }

    #[test]
    fn stop_reasons_derive_compatible_flags_without_ambiguous_combinations() {
        let cases = [
            (AgentStopReason::Completed, false, false),
            (AgentStopReason::SummarizedAfterLimit, false, false),
            (AgentStopReason::Canceled, true, false),
            (AgentStopReason::LimitReached, false, true),
        ];

        for (reason, canceled, hit_turn_limit) in cases {
            let outcome = AgentOutcome::finished(String::new(), Vec::new(), 0, reason, None);
            assert_eq!(outcome.canceled, canceled, "{reason:?}");
            assert_eq!(outcome.hit_turn_limit, hit_turn_limit, "{reason:?}");
        }
    }

    #[test]
    fn usage_from_every_request_is_accumulated_into_the_outcome() {
        let mut total: Option<crate::llm::Usage> = None;
        accumulate_usage(
            &mut total,
            Some(crate::llm::Usage {
                prompt_tokens: 100,
                cached_tokens: 40,
                completion_tokens: 10,
                reasoning_tokens: 5,
            }),
        );
        accumulate_usage(
            &mut total,
            Some(crate::llm::Usage {
                prompt_tokens: 50,
                cached_tokens: 0,
                completion_tokens: 8,
                reasoning_tokens: 0,
            }),
        );
        accumulate_usage(&mut total, None);
        let total = total.expect("报过用量就一定有合计");
        assert_eq!(total.prompt_tokens, 150);
        assert_eq!(total.cached_tokens, 40);
        assert_eq!(total.completion_tokens, 18);
        assert_eq!(total.reasoning_tokens, 5);
        // 从没报过用量时保持 None，不把缺失当成零消耗。
        let mut never: Option<crate::llm::Usage> = None;
        accumulate_usage(&mut never, None);
        assert!(never.is_none());
    }

    /// 循环里每一次请求报的用量都要累加进最终结果：工具轮 + 答复轮 = 合计，
    /// 界面据此展示「这一轮实际花了多少」。
    #[tokio::test]
    async fn token_usage_is_accumulated_across_turns() {
        let mut tool_turn = wants(vec![call("c1", "probe", "{}")]);
        tool_turn.usage = Some(crate::llm::Usage {
            prompt_tokens: 100,
            cached_tokens: 0,
            completion_tokens: 10,
            reasoning_tokens: 0,
        });
        let mut answer_turn = says("查完了");
        answer_turn.usage = Some(crate::llm::Usage {
            prompt_tokens: 200,
            cached_tokens: 50,
            completion_tokens: 20,
            reasoning_tokens: 3,
        });
        let provider = scripted(vec![tool_turn, answer_turn]);
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("查一下")],
            &Recorder::new(false),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap();

        let usage = out.usage.expect("端点报了用量就要透出");
        assert_eq!(usage.prompt_tokens, 300);
        assert_eq!(usage.cached_tokens, 50);
        assert_eq!(usage.completion_tokens, 30);
        assert_eq!(usage.reasoning_tokens, 3);
    }

    /// 端点全程不报用量的运行保持 None，界面不能把「没报」当成「免费」。
    #[tokio::test]
    async fn a_run_without_reported_usage_keeps_usage_none() {
        let provider = scripted(vec![says("没报用量")]);
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("问")],
            &Recorder::new(false),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap();

        assert!(out.usage.is_none());
    }

    /// 记录被执行过哪些工具；`fail` 时一律执行失败。
    struct Recorder {
        executed: RefCell<Vec<String>>,
        fail: bool,
    }

    impl Recorder {
        fn new(fail: bool) -> Self {
            Self {
                executed: RefCell::new(Vec::new()),
                fail,
            }
        }
    }

    impl ToolBox for Recorder {
        fn specs(&self) -> Vec<ToolSpec> {
            vec![ToolSpec {
                name: "probe".into(),
                description: "测试用".into(),
                parameters: serde_json::json!({"type":"object"}),
            }]
        }
        async fn run_unchecked(&self, call: &ToolCall) -> ToolOutcome {
            self.executed.borrow_mut().push(call.id.clone());
            if self.fail {
                ToolOutcome::failed("端点 500")
            } else {
                ToolOutcome::ok("结果若干")
            }
        }
    }

    #[tokio::test]
    async fn a_tool_round_trip_ends_with_the_models_answer() {
        let provider = scripted(vec![
            wants(vec![call("c1", "probe", "{}")]),
            says("查完了，答案是这个"),
        ]);
        let tools = Recorder::new(false);
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("帮我查一下")],
            &tools,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap();

        assert_eq!(out.answer, "查完了，答案是这个");
        assert_eq!(out.turns, 2);
        assert_eq!(out.stop_reason, AgentStopReason::Completed);
        assert_eq!(tools.executed.borrow().as_slice(), ["c1"]);

        // 对话顺序：用户 → 模型要求调用 → 工具结果 → 模型作答。
        // 「要求调用」那一轮必须在结果之前，否则下一次请求里的结果就是孤儿。
        let roles: Vec<&str> = out.messages.iter().map(|m| m.role.as_str()).collect();
        assert_eq!(roles, ["user", "assistant", "tool", "assistant"]);
        assert_eq!(out.messages[1].tool_calls[0].id, "c1");
        assert_eq!(out.messages[2].tool_call_id.as_deref(), Some("c1"));
    }

    /// 循环里 answer 是**逐轮替换**的：第二轮说的话不接在第一轮后面。
    /// 界面据此在每个 TurnStarted 上清空已显示的正文——少了这条边界，
    /// 「我先查一下」和「查完了」会被拼成一段谁也没说过的话。
    #[tokio::test]
    async fn each_turn_is_announced_before_its_own_text() {
        let provider = scripted(vec![
            crate::llm::ChatResponse {
                content: "我先查一下".into(),
                tool_calls: vec![call("c1", "probe", "{}")],
                usage: None,
            },
            says("查完了，答案是这个"),
        ]);
        let tools = Recorder::new(false);
        let mut trace: Vec<String> = Vec::new();
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("帮我查一下")],
            &tools,
            &AtomicBool::new(false),
            &mut |event| match event {
                AgentEvent::TurnStarted(turn) => trace.push(format!("turn:{turn}")),
                AgentEvent::Content(delta) => trace.push(format!("text:{delta}")),
                AgentEvent::ToolStarted(call) => trace.push(format!("tool:{}", call.name)),
                _ => {}
            },
        )
        .await
        .unwrap();

        assert_eq!(
            trace,
            [
                "turn:1",
                "text:我先查一下",
                "tool:probe",
                "turn:2",
                "text:查完了，答案是这个",
            ],
            "每一轮的正文都必须落在它自己的 turn 之后"
        );
        // 最终答案是最后一轮说的，不是两轮拼起来的。
        assert_eq!(out.answer, "查完了，答案是这个");
    }

    /// 工具标签此前要等整轮跑完才出现（只在返回值里带 tools_used）。
    /// 现在开始执行就发一次，界面能实时显示助手正在做什么。
    #[tokio::test]
    async fn tools_are_announced_as_they_start_not_at_the_end() {
        let provider = scripted(vec![
            wants(vec![call("a", "probe", "{}"), call("b", "probe", "{}")]),
            says("好了"),
        ]);
        let tools = Recorder::new(false);
        let mut announced_before_answer = 0usize;
        let mut answered = false;
        run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("做两件事")],
            &tools,
            &AtomicBool::new(false),
            &mut |event| match event {
                AgentEvent::ToolStarted(_) if !answered => announced_before_answer += 1,
                AgentEvent::Content(text) if text.contains("好了") => answered = true,
                _ => {}
            },
        )
        .await
        .unwrap();

        assert_eq!(announced_before_answer, 2, "两个工具都要在答案之前报出来");
    }

    #[tokio::test]
    async fn every_announced_call_gets_exactly_one_result() {
        // 一轮里要求调多个工具时，每一次调用都必须配一条结果——少一条，
        // 服务端会因为「有调用没结果」拒收整轮对话。
        let provider = scripted(vec![
            wants(vec![call("a", "probe", "{}"), call("b", "probe", "{}")]),
            says("好了"),
        ]);
        let tools = Recorder::new(false);
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("做两件事")],
            &tools,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap();

        let announced: Vec<String> = out
            .messages
            .iter()
            .flat_map(|m| m.tool_calls.iter().map(|c| c.id.clone()))
            .collect();
        let answered: Vec<String> = out
            .messages
            .iter()
            .filter_map(|m| m.tool_call_id.clone())
            .collect();
        assert_eq!(announced, ["a", "b"]);
        assert_eq!(answered, ["a", "b"]);
    }

    #[tokio::test]
    async fn preflight_rejections_become_results_without_entering_tool_dispatch() {
        let provider = scripted(vec![
            wants(vec![
                call("unknown", "made_up_tool", "{}"),
                call("malformed", "probe", "{"),
                call("not-object", "probe", "[]"),
            ]),
            says("参数有问题，已停止调用并说明原因"),
        ]);
        let tools = Recorder::new(false);
        let mut started = 0;
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("测试工具边界")],
            &tools,
            &AtomicBool::new(false),
            &mut |event| {
                if matches!(event, AgentEvent::ToolStarted(_)) {
                    started += 1;
                }
            },
        )
        .await
        .unwrap();

        assert!(
            tools.executed.borrow().is_empty(),
            "preflight 失败不能进入 dispatch"
        );
        assert_eq!(started, 0, "被 preflight 拒绝的调用不能冒充已开始");
        let results: Vec<_> = out
            .messages
            .iter()
            .filter(|message| message.role == "tool")
            .map(|message| message.content.as_str())
            .collect();
        assert_eq!(results.len(), 3, "每个被拒绝的调用仍要补齐 tool result");
        assert!(results[0].contains("没有名为 made_up_tool"));
        assert!(results[1].contains("不是合法 JSON"));
        assert!(results[2].contains("必须是 JSON 对象"));
        assert_eq!(out.answer, "参数有问题，已停止调用并说明原因");
    }

    #[tokio::test]
    async fn a_model_that_never_stops_gets_one_forced_summary_after_the_cap() {
        // 模型可以自己跟自己调一晚上工具，而每轮的结果都留在上下文里，成本是乘法涨的。
        // 达到工具轮上限后只允许再做一次无工具总结，不能把「我先查一下」当成最终答案。
        let mut steps: Vec<_> = (0..MAX_TURNS)
            .map(|i| wants(vec![call(&format!("c{i}"), "probe", "{}")]))
            .collect();
        steps.push(says("基于已经查到的资料，最终答案如下"));
        let provider = scripted(steps);
        let tools = Recorder::new(false);
        let mut trace: Vec<String> = Vec::new();
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("一直做")],
            &tools,
            &AtomicBool::new(false),
            &mut |event| match event {
                AgentEvent::HitTurnLimit => trace.push("limit".into()),
                AgentEvent::TurnStarted(turn) => trace.push(format!("turn:{turn}")),
                // 工具轮的过场话是空串，也会触发一次 Content 回调；只记真正有字的正文。
                AgentEvent::Content(delta) if !delta.is_empty() => trace.push("text".into()),
                _ => {}
            },
        )
        .await
        .unwrap();

        assert_eq!(out.turns, MAX_TURNS + 1, "最后一次只负责总结");
        // 撞上限事件必须先于总结轮开始、先于总结正文：界面据此知道「封顶」早于「完成」。
        let limit_at = trace.iter().position(|e| e == "limit").expect("要发撞上限事件");
        let summary_at = trace
            .iter()
            .position(|e| e == format!("turn:{}", MAX_TURNS + 1).as_str())
            .expect("总结轮要单独播报");
        let text_at = trace.iter().position(|e| e == "text").expect("总结正文要播出");
        assert!(limit_at < summary_at && summary_at < text_at, "顺序应为 撞上限→总结轮→总结正文，实际 {trace:?}");
        assert_eq!(out.answer, "基于已经查到的资料，最终答案如下");
        assert!(
            !out.hit_turn_limit,
            "总结成功后不能再让界面声称没有得出结论"
        );
        assert!(!out.canceled);
        assert_eq!(out.stop_reason, AgentStopReason::SummarizedAfterLimit);
        assert_eq!(tools.executed.borrow().len(), MAX_TURNS);
        assert_eq!(
            out.messages.last().map(|message| message.content.as_str()),
            Some("基于已经查到的资料，最终答案如下")
        );
    }

    #[tokio::test]
    async fn the_forced_summary_never_executes_or_loops_on_more_tool_calls() {
        // Scripted 故意模拟一个违约端点：请求已经不带 tools，它仍返回 tool_calls。
        // Agent 不能执行上限外的工具，更不能由此开始第二段无限循环。
        let mut steps: Vec<_> = (0..MAX_TURNS)
            .map(|i| wants(vec![call(&format!("c{i}"), "probe", "{}")]))
            .collect();
        steps.push(wants(vec![call("summary-call", "probe", "{}")]));
        let provider = scripted(steps);
        let tools = Recorder::new(false);
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("一直做")],
            &tools,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap();

        assert_eq!(out.turns, MAX_TURNS + 1);
        assert_eq!(tools.executed.borrow().len(), MAX_TURNS);
        assert!(out.hit_turn_limit, "总结没有正文时仍要给界面上限提示");
        assert_eq!(out.stop_reason, AgentStopReason::LimitReached);
        assert!(out
            .messages
            .iter()
            .flat_map(|message| &message.tool_calls)
            .all(|call| call.id != "summary-call"));
    }

    #[tokio::test]
    async fn a_failed_forced_summary_keeps_the_tool_results_instead_of_failing_the_request() {
        // Scripted 在步骤耗尽时返回错误。只给满额工具轮步骤，就能精确模拟随后的
        // 总结请求失败，而前面的检索结果仍应作为一个可继续追问的 outcome 返回。
        let provider = scripted(
            (0..MAX_TURNS)
                .map(|i| wants(vec![call(&format!("c{i}"), "probe", "{}")]))
                .collect(),
        );
        let tools = Recorder::new(false);
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("一直做")],
            &tools,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .expect("总结失败不应抹掉已经完成的工具轮");

        assert_eq!(out.turns, MAX_TURNS + 1);
        assert_eq!(tools.executed.borrow().len(), MAX_TURNS);
        assert!(out.hit_turn_limit);
        assert_eq!(out.stop_reason, AgentStopReason::LimitReached);
        assert_eq!(
            out.messages
                .iter()
                .filter(|message| message.role == "tool")
                .count(),
            MAX_TURNS
        );
    }

    #[tokio::test]
    async fn oversized_tool_results_are_capped_before_forced_summary() {
        struct LargeResult;
        impl ToolBox for LargeResult {
            fn specs(&self) -> Vec<ToolSpec> {
                Recorder::new(false).specs()
            }

            async fn run_unchecked(&self, _call: &ToolCall) -> ToolOutcome {
                ToolOutcome::ok("资料".repeat(MAX_TOTAL_TOOL_RESULT_CHARS))
            }
        }

        let provider = scripted(vec![
            wants(vec![call("large", "probe", "{}")]),
            says("根据已保留的资料完成总结"),
        ]);
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("查很多资料")],
            &LargeResult,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap();

        let result = out
            .messages
            .iter()
            .find(|message| message.tool_call_id.as_deref() == Some("large"))
            .expect("工具调用必须保留对应结果");
        assert!(result.content.chars().count() <= MAX_TOOL_RESULT_CHARS);
        assert!(result.content.contains("截断"));
        assert_eq!(out.answer, "根据已保留的资料完成总结");
        assert_eq!(out.turns, 2);
    }

    #[tokio::test]
    async fn excessive_tool_calls_are_answered_but_not_executed_past_the_budget() {
        let calls: Vec<_> = (0..MAX_TOOL_CALLS + 2)
            .map(|index| call(&format!("budget-{index}"), "probe", "{}"))
            .collect();
        let provider = scripted(vec![wants(calls), says("预算内结果总结")]);
        let tools = Recorder::new(false);
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("调用太多工具")],
            &tools,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap();

        assert_eq!(tools.executed.borrow().len(), MAX_TOOL_CALLS);
        assert_eq!(
            out.messages
                .iter()
                .filter(|message| message.role == "tool")
                .count(),
            MAX_TOOL_CALLS + 2,
            "未执行的调用也要补结果，不能留下孤儿 tool_call"
        );
        assert!(out
            .messages
            .iter()
            .any(|message| { message.role == "tool" && message.content == TOOL_BUDGET_EXHAUSTED }));
        assert_eq!(out.answer, "预算内结果总结");
    }

    #[tokio::test]
    async fn a_model_that_answers_normally_is_not_flagged_as_having_run_out_of_turns() {
        // 这个标记会让界面挂出「没得出结论」。答得好好的却挂上，比不挂更糟。
        let provider = scripted(vec![says("答完了")]);
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("问")],
            &Recorder::new(false),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap();

        assert!(!out.hit_turn_limit);
        assert_eq!(out.stop_reason, AgentStopReason::Completed);
    }

    #[tokio::test]
    async fn canceling_stops_execution_but_still_answers_every_call() {
        let provider = scripted(vec![
            wants(vec![call("a", "probe", "{}"), call("b", "probe", "{}")]),
            says("不该走到这里"),
        ]);
        let tools = Recorder::new(false);
        let cancel = AtomicBool::new(true); // 用户在开始前就点了停止
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("做两件事")],
            &tools,
            &cancel,
            &mut |_| {},
        )
        .await
        .unwrap();

        // 一开始就取消：一次模型调用都不该发出去。
        assert_eq!(out.turns, 0);
        assert!(tools.executed.borrow().is_empty());
        assert!(out.answer.is_empty());
        assert_eq!(out.stop_reason, AgentStopReason::Canceled);
    }

    #[tokio::test]
    async fn canceling_midway_leaves_no_orphan_call() {
        // 取消发生在工具执行之间：剩下的不执行，但仍要补一条结果，
        // 否则这段对话带着「有调用没结果」的窟窿，再发一次就会被服务端拒。
        struct CancelAfterFirst<'a> {
            cancel: &'a AtomicBool,
            executed: RefCell<Vec<String>>,
        }
        impl ToolBox for CancelAfterFirst<'_> {
            fn specs(&self) -> Vec<ToolSpec> {
                vec![ToolSpec {
                    name: "probe".into(),
                    description: String::new(),
                    parameters: serde_json::json!({"type":"object"}),
                }]
            }
            async fn run_unchecked(&self, call: &ToolCall) -> ToolOutcome {
                self.executed.borrow_mut().push(call.id.clone());
                self.cancel.store(true, Ordering::SeqCst);
                ToolOutcome::ok("第一个做完了")
            }
        }

        let provider = scripted(vec![wants(vec![
            call("a", "probe", "{}"),
            call("b", "probe", "{}"),
        ])]);
        let cancel = AtomicBool::new(false);
        let tools = CancelAfterFirst {
            cancel: &cancel,
            executed: RefCell::new(Vec::new()),
        };
        let mut finished = Vec::new();
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("做两件事")],
            &tools,
            &cancel,
            &mut |event| {
                if let AgentEvent::ToolFinished { call, status } = event {
                    finished.push((call.id.clone(), status));
                }
            },
        )
        .await
        .unwrap();

        assert_eq!(tools.executed.borrow().as_slice(), ["a"], "第二个不该执行");
        let answered: Vec<String> = out
            .messages
            .iter()
            .filter_map(|m| m.tool_call_id.clone())
            .collect();
        assert_eq!(answered, ["a", "b"], "两次调用都要有结果，哪怕是「已取消」");
        assert_eq!(
            finished,
            [("a".to_string(), ToolExecutionStatus::Completed)],
            "工具已经返回结果时，即使整轮同时收到取消，也不能把该工具误报为取消"
        );
    }

    #[tokio::test]
    async fn canceling_interrupts_a_tool_that_never_returns() {
        struct NeverReturns {
            started: AtomicBool,
        }

        impl ToolBox for NeverReturns {
            fn specs(&self) -> Vec<ToolSpec> {
                vec![ToolSpec {
                    name: "probe".into(),
                    description: String::new(),
                    parameters: serde_json::json!({"type":"object"}),
                }]
            }

            async fn run_unchecked(&self, _call: &ToolCall) -> ToolOutcome {
                self.started.store(true, Ordering::SeqCst);
                std::future::pending::<ToolOutcome>().await
            }
        }

        let provider = scripted(vec![wants(vec![
            call("running", "probe", "{}"),
            call("queued", "probe", "{}"),
        ])]);
        let cancel = AtomicBool::new(false);
        let tools = NeverReturns {
            started: AtomicBool::new(false),
        };
        let mut finished = Vec::new();
        let mut on_event = |event: AgentEvent<'_>| {
            if let AgentEvent::ToolFinished { call, status } = event {
                finished.push((call.id.clone(), status));
            }
        };

        let scenario = async {
            let stop_when_started = async {
                while !tools.started.load(Ordering::SeqCst) {
                    tokio::task::yield_now().await;
                }
                cancel.store(true, Ordering::SeqCst);
            };
            let (result, ()) = tokio::join!(
                run(
                    &provider,
                    "m",
                    None,
                    vec![ChatMessage::user("执行慢工具")],
                    &tools,
                    &cancel,
                    &mut on_event,
                ),
                stop_when_started,
            );
            result.unwrap()
        };

        let out = tokio::time::timeout(std::time::Duration::from_secs(1), scenario)
            .await
            .expect("停止后不该继续等待挂起的工具");
        assert!(out.canceled);
        assert_eq!(
            finished,
            [("running".to_string(), ToolExecutionStatus::Canceled)],
            "只有真正被中断的工具才应标记为 canceled"
        );

        let results: Vec<(&str, &str)> = out
            .messages
            .iter()
            .filter_map(|message| {
                Some((message.tool_call_id.as_deref()?, message.content.as_str()))
            })
            .collect();
        assert_eq!(
            results,
            [
                ("running", "已取消，执行未完成。"),
                ("queued", "已取消，未执行。"),
            ],
            "正在执行和尚未执行的调用都要各有一条取消结果"
        );
    }

    #[tokio::test]
    async fn being_canceled_is_not_reported_as_hitting_the_turn_limit() {
        // 两者都会走到收尾，但对用户是两件事：一个是「你叫停的」，
        // 一个是「它自己转不出来了」。混着说会让人以为助手卡死了。
        // 必须在**最后一轮**才取消，否则循环提前 break，turns 根本到不了上限，
        // 这个判断就没被走到——测试会假装通过。
        struct CancelOnLastTool<'a> {
            cancel: &'a AtomicBool,
            seen: RefCell<usize>,
        }
        impl ToolBox for CancelOnLastTool<'_> {
            fn specs(&self) -> Vec<ToolSpec> {
                vec![ToolSpec {
                    name: "probe".into(),
                    description: String::new(),
                    parameters: serde_json::json!({"type":"object"}),
                }]
            }
            async fn run_unchecked(&self, _call: &ToolCall) -> ToolOutcome {
                *self.seen.borrow_mut() += 1;
                if *self.seen.borrow() >= MAX_TURNS {
                    self.cancel.store(true, Ordering::SeqCst);
                }
                ToolOutcome::ok("做完了")
            }
        }

        let provider = scripted(
            (0..MAX_TURNS + 2)
                .map(|i| wants(vec![call(&format!("c{i}"), "probe", "{}")]))
                .collect(),
        );
        let cancel = AtomicBool::new(false);
        let tools = CancelOnLastTool {
            cancel: &cancel,
            seen: RefCell::new(0),
        };
        let mut hit_limit = false;
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("一直做")],
            &tools,
            &cancel,
            &mut |e| {
                if matches!(e, AgentEvent::HitTurnLimit) {
                    hit_limit = true;
                }
            },
        )
        .await
        .unwrap();
        assert!(!hit_limit, "被取消不该报成撞上限");
        assert!(!out.hit_turn_limit, "结果里同样不能混为一谈");
        assert!(out.canceled);
        assert_eq!(out.stop_reason, AgentStopReason::Canceled);
    }

    #[tokio::test]
    async fn what_the_model_said_alongside_its_tool_calls_stays_in_the_conversation() {
        // 置空的话，它下一轮看不到自己刚才的交代，容易把同一件事再解释一遍。
        let provider = scripted(vec![
            crate::llm::ChatResponse {
                content: "我先查一下".into(),
                tool_calls: vec![call("c1", "probe", "{}")],
                usage: None,
            },
            says("查完了"),
        ]);
        let tools = Recorder::new(false);
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("查查看")],
            &tools,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap();
        let announced = out
            .messages
            .iter()
            .find(|m| !m.tool_calls.is_empty())
            .unwrap();
        assert_eq!(announced.content, "我先查一下");
    }

    #[tokio::test]
    async fn a_failing_tool_is_fed_back_instead_of_aborting() {
        let provider = scripted(vec![
            wants(vec![call("c1", "probe", "{}")]),
            says("那件事没做成，因为端点挂了"),
        ]);
        let tools = Recorder::new(true);
        let mut finished = Vec::new();
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("做点什么")],
            &tools,
            &AtomicBool::new(false),
            &mut |event| {
                if let AgentEvent::ToolFinished { call, status } = event {
                    finished.push((call.id.clone(), status));
                }
            },
        )
        .await
        .unwrap();

        // 失败进的是对话，不是错误通道——模型因此有机会改口。
        let result = out.messages.iter().find(|m| m.role == "tool").unwrap();
        assert!(result.content.contains("端点 500"));
        assert_eq!(
            finished,
            [("c1".to_string(), ToolExecutionStatus::Failed)],
            "领域失败必须是结构化状态，不能靠解析错误文本识别"
        );
        assert_eq!(out.answer, "那件事没做成，因为端点挂了");
    }

    #[test]
    fn malformed_arguments_turn_into_a_readable_tool_result() {
        #[derive(serde::Deserialize)]
        struct Args {
            #[allow(dead_code)]
            video_id: String,
        }
        let bad = call("c", "probe", r#"{"video_id": "#);
        let outcome = parse_arguments::<Args>(&bad).err().expect("应当失败");
        // 把模型实际给的东西回显出去，它才知道自己哪里写错了。
        assert!(outcome.content.contains(r#"{"video_id": "#));
    }

    #[test]
    fn an_empty_toolbox_is_reported_rather_than_silently_idle() {
        assert!(ensure_not_empty(&[]).is_err());
        assert!(ensure_not_empty(&[ToolSpec {
            name: "x".into(),
            description: String::new(),
            parameters: serde_json::json!({}),
        }])
        .is_ok());
    }

    /// 抖动重试的成功路径：第一次被网络抖动打断，第二次拿到答案。
    /// 没有重试的话，这次失败直接变红条——批量管线能忍的抖动，助手也必须能忍。
    #[tokio::test]
    async fn a_retryable_stream_failure_is_retried_until_it_succeeds() {
        let provider = flaky(1, false, vec![says("第二次才答上")], None);
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("问")],
            &Recorder::new(false),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap();

        assert_eq!(provider.call_count(), 2, "失败一次后应当重试并成功");
        assert_eq!(out.answer, "第二次才答上");
        assert_eq!(out.stop_reason, AgentStopReason::Completed);
    }

    /// 重试次数有上限（2 次）：退避预算耗尽后仍失败才上抛，不会无限重试。
    #[tokio::test]
    async fn retry_gives_up_after_the_backoff_budget_is_exhausted() {
        let provider = flaky(5, false, Vec::new(), None);
        let error = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("问")],
            &Recorder::new(false),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .err()
        .expect("应当报错");

        // 初始 1 次 + 2 次重试；第 3 次失败时预算耗尽，原样上抛。
        assert_eq!(provider.call_count(), 3);
        assert!(error.to_string().contains("网关抖动"));
    }

    /// 鉴权、余额这类错误再发一遍还是同一句话，重试只是让用户白等退避。
    #[tokio::test]
    async fn a_permanent_failure_is_not_retried() {
        let provider = flaky(1, true, Vec::new(), None);
        let error = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("问")],
            &Recorder::new(false),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .err()
        .expect("应当报错");

        assert!(error.is_permanent());
        assert_eq!(provider.call_count(), 1, "permanent 错误不该触发任何重试");
    }

    /// 用户在失败与重试之间点了停止：重试前的取消检查必须拦住下一次请求，
    /// 否则「停止」之后模型请求还在背后继续发。
    #[tokio::test]
    async fn a_canceled_between_failure_and_retry_stops_sending_requests() {
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        // Flaky 在失败时置位这个标志，确定性模拟「失败之后、重试之前用户点了停止」。
        let provider = flaky(1, false, vec![says("不该走到这里")], Some(cancel.clone()));
        let error = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("问")],
            &Recorder::new(false),
            &cancel,
            &mut |_| {},
        )
        .await
        .err()
        .expect("应当报错");

        assert!(cancel.load(Ordering::SeqCst), "注入的失败应当置位取消标志");
        assert_eq!(provider.call_count(), 1, "取消后绝不能再发请求");
        assert!(error.to_string().contains("网关抖动"));
    }

    /// 并发探针工具集：`read_a`/`read_b` 只读，`write` 非只读。
    /// 每个调用执行期间把活跃计数 +1 并记录最大值——串行执行 max_active
    /// 永远是 1，并发执行才会到 2；这是并发唯一不依赖时钟的硬证据。
    #[derive(Default)]
    struct Probe {
        active: std::sync::atomic::AtomicUsize,
        max_active: std::sync::atomic::AtomicUsize,
    }

    impl ToolBox for Probe {
        fn specs(&self) -> Vec<ToolSpec> {
            ["read_a", "read_b", "write"]
                .into_iter()
                .map(|name| ToolSpec {
                    name: name.into(),
                    description: "并发探针".into(),
                    parameters: serde_json::json!({ "type": "object" }),
                })
                .collect()
        }

        fn is_read_only(&self, name: &str) -> bool {
            name != "write"
        }

        async fn run_unchecked(&self, call: &ToolCall) -> ToolOutcome {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);
            // 停留一小段，让并发的调用有时间重叠。
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            ToolOutcome::ok(format!("{} 完成", call.name))
        }
    }

    /// 只读工具在一轮里并发执行，事件仍按调用序号成对：
    /// 两个「开始」按序聚簇播出，两个「结束」按序回收，前端看到的顺序不受并发影响。
    #[tokio::test]
    async fn read_only_calls_run_concurrently_with_events_paired_in_call_order() {
        let provider = scripted(vec![
            wants(vec![call("c1", "read_a", "{}"), call("c2", "read_b", "{}")]),
            says("两个都查完了"),
        ]);
        let probe = Probe::default();
        let mut trace: Vec<String> = Vec::new();
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("并发查两处")],
            &probe,
            &AtomicBool::new(false),
            &mut |event| match event {
                AgentEvent::ToolStarted(call) => trace.push(format!("start:{}", call.id)),
                AgentEvent::ToolFinished { call, status } => {
                    trace.push(format!("finish:{}:{}", call.id, status.as_str()))
                }
                _ => {}
            },
        )
        .await
        .unwrap();

        // 同一时刻有两个调用在执行——串行实现永远到不了 2。
        assert_eq!(probe.max_active.load(Ordering::SeqCst), 2, "只读工具应当并发执行");
        assert_eq!(
            trace,
            ["start:c1", "start:c2", "finish:c1:completed", "finish:c2:completed"],
            "事件按调用序号成对：Started 聚簇在前，Finished 保序在后"
        );
        // 工具结果按调用序号写回对话，模型看到的顺序不乱。
        let tool_ids: Vec<&str> = out
            .messages
            .iter()
            .filter_map(|message| message.tool_call_id.as_deref())
            .collect();
        assert_eq!(tool_ids, ["c1", "c2"]);
        assert_eq!(out.answer, "两个都查完了");
    }

    /// 非只读调用即使连续出现也单独成批：写操作保持串行，
    /// 模型依赖上一笔副作用时行为与旧实现完全一致。
    #[tokio::test]
    async fn mutating_calls_stay_serial_even_when_consecutive() {
        let provider = scripted(vec![
            wants(vec![call("c1", "write", "{}"), call("c2", "write", "{}")]),
            says("两个写操作都做完了"),
        ]);
        let probe = Probe::default();
        let mut trace: Vec<String> = Vec::new();
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("连做两笔写")],
            &probe,
            &AtomicBool::new(false),
            &mut |event| match event {
                AgentEvent::ToolStarted(call) => trace.push(format!("start:{}", call.id)),
                AgentEvent::ToolFinished { call, status } => {
                    trace.push(format!("finish:{}:{}", call.id, status.as_str()))
                }
                _ => {}
            },
        )
        .await
        .unwrap();

        assert_eq!(probe.max_active.load(Ordering::SeqCst), 1, "写操作必须串行，不能并发");
        // 串行批次的事件仍严格交错：c1 结束之后 c2 才开始。
        assert_eq!(
            trace,
            ["start:c1", "finish:c1:completed", "start:c2", "finish:c2:completed"],
            "非只读调用逐个执行、事件逐对回收"
        );
        assert_eq!(out.answer, "两个写操作都做完了");
    }

    /// 混合序列只并发「连续只读」前缀：c1/c2 并发，c3（写）单独串行，c4 单独执行。
    /// 分批边界由只读性决定，与调用之间的其他内容无关。
    #[tokio::test]
    async fn a_mixed_run_parallelizes_only_the_consecutive_read_only_prefix() {
        let provider = scripted(vec![
            wants(vec![
                call("c1", "read_a", "{}"),
                call("c2", "read_b", "{}"),
                call("c3", "write", "{}"),
                call("c4", "read_a", "{}"),
            ]),
            says("全部完成"),
        ]);
        let probe = Probe::default();
        let mut trace: Vec<String> = Vec::new();
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("混合调用")],
            &probe,
            &AtomicBool::new(false),
            &mut |event| match event {
                AgentEvent::ToolStarted(call) => trace.push(format!("start:{}", call.id)),
                AgentEvent::ToolFinished { call, status } => {
                    trace.push(format!("finish:{}:{}", call.id, status.as_str()))
                }
                _ => {}
            },
        )
        .await
        .unwrap();

        // 只读前缀并发到 2；写与之后的单独读都不能再与其他调用重叠。
        assert_eq!(probe.max_active.load(Ordering::SeqCst), 2, "只有连续只读前缀并发");
        assert_eq!(
            trace,
            [
                "start:c1",
                "start:c2",
                "finish:c1:completed",
                "finish:c2:completed",
                "start:c3",
                "finish:c3:completed",
                "start:c4",
                "finish:c4:completed",
            ],
            "写操作两侧的批次边界清晰：读前缀聚簇，写与后续单读严格串行"
        );
        assert_eq!(out.answer, "全部完成");
    }
}
