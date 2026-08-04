//! 工具调用循环：让模型自己决定调哪个能力，直到它给出答复。
//!
//! 这一层**只管循环**，不管有哪些工具、更不管工具能干什么。工具的注册与执行由调用方
//! 通过 [`ToolBox`] 提供——助手要能改数据，而「改什么算安全、什么必须先问过用户」是
//! 产品决定，不该埋在这里。
//!
//! 三条硬约束，都是这个循环必须自带的：
//!
//! 1. **轮次有上限**。模型能自己跟自己调一晚上工具，每一轮的结果又都留在上下文里，
//!    成本是乘法涨的。撞到上限时不是报错，而是把已经拿到的东西交出去。
//! 2. **随时可取消**。用户点停止之后，正在等的那次模型调用要断，已经排上的工具不再执行。
//! 3. **工具失败不等于整轮失败**。执行出错时把错误当成工具结果喂回去，模型有机会换个
//!    参数重试或者改口说做不到；直接抛错则是把整段对话打断，用户只看到一个红条。

use crate::error::{AppError, AppResult};
use crate::llm::{ChatMessage, ChatRequest, Provider, ToolCall, ToolSpec};
use std::sync::atomic::{AtomicBool, Ordering};

/// 一轮循环最多来回几次。
///
/// 六次的依据：真实请求里「查一下再答」是一到两轮，「查、再查、确认、答」到四轮，
/// 超过这个数基本是模型在原地打转。留一点余量，但不能不封顶——每一轮的工具结果
/// 都留在上下文里，第六轮的输入已经是第一轮的好几倍。
pub const MAX_TURNS: usize = 6;

/// 一次工具执行的结果。
///
/// 失败也是一种结果，不是错误：`Err` 会打断整段对话，而把失败文本喂回去，
/// 模型能换个参数重试，或者老实告诉用户这件事没做成。
pub struct ToolOutcome {
    pub content: String,
}

impl ToolOutcome {
    pub fn ok(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
        }
    }

    /// 执行失败。文本会原样进入模型的上下文，所以要写成模型看得懂、
    /// 能据此改正的话，而不是内部堆栈。
    pub fn failed(reason: impl std::fmt::Display) -> Self {
        Self {
            content: format!(
                "工具执行失败：{reason}。请据此调整参数重试，或告诉用户这件事没做成。"
            ),
        }
    }
}

/// 调用方要提供的工具集：报出有哪些工具，以及怎么执行一次调用。
#[allow(async_fn_in_trait)] // 只在本进程内实现与调用，不需要 Send 边界。
pub trait ToolBox {
    fn specs(&self) -> Vec<ToolSpec>;
    async fn run(&self, call: &ToolCall) -> ToolOutcome;
}

/// 循环过程中的进度，交给调用方决定怎么显示。
pub enum AgentEvent<'a> {
    /// 模型这一轮要求调某个工具，即将执行。
    ToolStarted(&'a ToolCall),
    /// 该工具执行完毕（成功与否都算完毕）。
    ToolFinished(&'a ToolCall),
    /// 撞到轮次上限，已经停下。
    HitTurnLimit,
}

/// 一次完整循环的结果。
pub struct AgentOutcome {
    /// 模型最终说的话。撞上限或中途取消时，这里是它最后一次说过的内容，可能为空。
    pub answer: String,
    /// 整段对话（含工具往返），供调用方接着追问。
    pub messages: Vec<ChatMessage>,
    /// 实际来回了几轮。
    pub turns: usize,
    /// 是否由用户主动停止。撞轮次上限不算取消。
    pub canceled: bool,
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

    let pending = tools.run(call);
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

/// 跑一轮工具调用循环，直到模型给出不带工具调用的答复。
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

    for turn in 0..MAX_TURNS {
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
        // complete_or_cancel 而不是 complete：光在轮次之间查标志是不够的，
        // 单次调用最长要等到请求超时才回得来。用户点了停止，界面却还得转上几分钟——
        // 而这个循环最需要被打断的时刻，恰恰就是某一次调用卡住的时候。
        let Some(response) = crate::llm::complete_or_cancel_full(provider, &req, cancel).await?
        else {
            break;
        };

        if !response.content.trim().is_empty() {
            answer = response.content.clone();
        }

        // 没有要调的工具 = 它说完了。
        if response.tool_calls.is_empty() {
            messages.push(ChatMessage::assistant(response.content));
            return Ok(AgentOutcome {
                answer,
                messages,
                turns,
                canceled: false,
            });
        }

        // 模型要求调工具的那一轮必须原样放回对话里，后面那些结果才有出处；
        // 少了它，服务端会因为「孤儿 tool 消息」直接拒掉下一次请求。

        messages.push(ChatMessage::tool_calls(
            response.content.clone(),
            response.tool_calls.clone(),
        ));

        for call in &response.tool_calls {
            // 取消后不再执行剩下的工具，但已经执行过的结果要留在对话里——
            // 缺了任何一条结果，下一次请求同样是孤儿调用。
            if cancel.load(Ordering::SeqCst) {
                messages.push(ChatMessage::tool_result(&call.id, "已取消，未执行。"));
                continue;
            }
            on_event(AgentEvent::ToolStarted(call));
            let outcome = run_tool_or_cancel(tools, call, cancel).await;
            on_event(AgentEvent::ToolFinished(call));
            messages.push(ChatMessage::tool_result(
                &call.id,
                outcome
                    .map(|outcome| outcome.content)
                    .unwrap_or_else(|| "已取消，执行未完成。".to_string()),
            ));
        }
    }

    // 被取消不算撞上限。两者都会走到这里，但对用户是两件事：
    // 一个是「你叫停的」，一个是「它自己转不出来了」。
    if turns >= MAX_TURNS && !cancel.load(Ordering::SeqCst) {
        on_event(AgentEvent::HitTurnLimit);
    }
    // 撞上限或被取消：把已经拿到的交出去，不报错。用户宁可看到半截结果，
    // 也好过看到一个「失败」却不知道刚才那些工具到底做了什么。
    Ok(AgentOutcome {
        answer,
        messages,
        turns,
        canceled: cancel.load(Ordering::SeqCst),
    })
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

    fn ignore_event(_event: AgentEvent<'_>) {}

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
        async fn run(&self, call: &ToolCall) -> ToolOutcome {
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
        assert_eq!(tools.executed.borrow().as_slice(), ["c1"]);

        // 对话顺序：用户 → 模型要求调用 → 工具结果 → 模型作答。
        // 「要求调用」那一轮必须在结果之前，否则下一次请求里的结果就是孤儿。
        let roles: Vec<&str> = out.messages.iter().map(|m| m.role.as_str()).collect();
        assert_eq!(roles, ["user", "assistant", "tool", "assistant"]);
        assert_eq!(out.messages[1].tool_calls[0].id, "c1");
        assert_eq!(out.messages[2].tool_call_id.as_deref(), Some("c1"));
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
    async fn a_model_that_never_stops_is_capped_instead_of_looping_forever() {
        // 模型可以自己跟自己调一晚上工具，而每轮的结果都留在上下文里，成本是乘法涨的。
        let provider = scripted(
            (0..MAX_TURNS + 5)
                .map(|i| wants(vec![call(&format!("c{i}"), "probe", "{}")]))
                .collect(),
        );
        let tools = Recorder::new(false);
        let mut hit_limit = false;
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("一直做")],
            &tools,
            &AtomicBool::new(false),
            &mut |e| {
                if matches!(e, AgentEvent::HitTurnLimit) {
                    hit_limit = true;
                }
            },
        )
        .await
        .unwrap();

        assert_eq!(out.turns, MAX_TURNS);
        assert!(hit_limit, "撞上限要说一声");
        assert_eq!(tools.executed.borrow().len(), MAX_TURNS);
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
            async fn run(&self, call: &ToolCall) -> ToolOutcome {
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

        assert_eq!(tools.executed.borrow().as_slice(), ["a"], "第二个不该执行");
        let answered: Vec<String> = out
            .messages
            .iter()
            .filter_map(|m| m.tool_call_id.clone())
            .collect();
        assert_eq!(answered, ["a", "b"], "两次调用都要有结果，哪怕是「已取消」");
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

            async fn run(&self, _call: &ToolCall) -> ToolOutcome {
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

        let scenario = async {
            let mut on_event = ignore_event;
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
            async fn run(&self, _call: &ToolCall) -> ToolOutcome {
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
        run(
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
        let out = run(
            &provider,
            "m",
            None,
            vec![ChatMessage::user("做点什么")],
            &tools,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .await
        .unwrap();

        // 失败进的是对话，不是错误通道——模型因此有机会改口。
        let result = out.messages.iter().find(|m| m.role == "tool").unwrap();
        assert!(result.content.contains("端点 500"));
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
}
