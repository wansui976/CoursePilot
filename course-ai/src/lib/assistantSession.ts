import type { AssistantAction, AssistantContext, AssistantMessage } from "./types";

const STORAGE_KEY = "course-ai-assistant-session:v1";
export const MAX_ASSISTANT_TURNS = 20;
export const MAX_ASSISTANT_ANSWER_CHARS = 24_000;
export const MAX_ASSISTANT_REASONING_CHARS = 16_000;
const MAX_DRAFT_CHARS = 10_000;
const MAX_QUESTION_CHARS = 10_000;
const MAX_TOOL_NAME_CHARS = 200;
const MAX_TOOLS_PER_TURN = 50;
const MAX_HISTORY_USER_TURNS = 8;
const MAX_HISTORY_CHARS = 48_000;
const MAX_ACTION_RESULTS = 50;
const MAX_ACTION_RESULT_CHARS = 2_000;
const CONTEXT_PREFIX = "（界面状态：";
const EXPIRED_ACTION_HISTORY_NOTICE =
  "（界面操作结果：应用重启后，本轮旧操作按钮已失效；已经完成的结果以操作记录为准，尚未确认的操作未执行。如仍需操作，必须重新调用工具核对当前状态并生成新按钮。）";

export interface AssistantTurnRecord {
  id: string;
  question: string;
  answer: string;
  /** 推理模型的思考过程；随答案一起保留，答案出来后折叠展示。旧记录没有。 */
  reasoning?: string;
  actions: AssistantAction[];
  /** 重启前这一轮曾有操作按钮；参数不会落盘，恢复后只能提示用户重新发起。 */
  actionsExpired?: boolean;
  tools: string[];
  canceled: boolean;
  /** 工具轮或上下文预算封顶且强制总结仍失败；这一轮回答不完整，重启后同样要说明。旧记录没有。 */
  hitTurnLimit?: boolean;
  /** 确认卡的实际执行结果；重启后仍需告诉用户已经完成、失败或取消。 */
  actionResults: string[];
  pending?: boolean;
  /** 回答产生时的界面上下文，确保以后点时间戳仍回到原视频。 */
  context?: AssistantContext;
}

export interface AssistantSession {
  turns: AssistantTurnRecord[];
  history: AssistantMessage[];
  draft: string;
}

const EMPTY_SESSION: AssistantSession = { turns: [], history: [], draft: "" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function capAssistantText(value: string, maxChars: number) {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function readTurn(value: unknown): AssistantTurnRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.question !== "string" ||
    typeof value.answer !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    question: capAssistantText(value.question, MAX_QUESTION_CHARS),
    answer: capAssistantText(value.answer, MAX_ASSISTANT_ANSWER_CHARS),
    ...(typeof value.reasoning === "string" && value.reasoning
      ? { reasoning: capAssistantText(value.reasoning, MAX_ASSISTANT_REASONING_CHARS) }
      : {}),
    // 旧确认卡不能跨重启复活：用户可能已经在别处完成了同一操作。
    actions: [],
    ...(value.actionsExpired === true ? { actionsExpired: true } : {}),
    tools: Array.isArray(value.tools)
      ? value.tools
          .filter((tool): tool is string => typeof tool === "string")
          .map((tool) => capAssistantText(tool, MAX_TOOL_NAME_CHARS))
          .slice(-MAX_TOOLS_PER_TURN)
      : [],
    canceled: value.canceled === true,
    ...(value.hitTurnLimit === true ? { hitTurnLimit: true } : {}),
    actionResults: Array.isArray(value.actionResults)
      ? value.actionResults
          .filter((result): result is string => typeof result === "string")
          .map((result) => result.slice(0, MAX_ACTION_RESULT_CHARS))
          .slice(-MAX_ACTION_RESULTS)
      : [],
    context: isRecord(value.context)
      ? {
          ...(typeof value.context.course_id === "string"
            ? { course_id: value.context.course_id }
            : {}),
          ...(typeof value.context.video_id === "string"
            ? { video_id: value.context.video_id }
            : {}),
          ...(typeof value.context.position_ms === "number" &&
          Number.isFinite(value.context.position_ms)
            ? { position_ms: value.context.position_ms }
            : {}),
        }
      : undefined,
  };
}

function readToolCall(value: unknown) {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.arguments !== "string"
  ) {
    return null;
  }
  return { id: value.id, name: value.name, arguments: value.arguments };
}

function readMessage(value: unknown): AssistantMessage | null {
  if (!isRecord(value) || typeof value.role !== "string" || typeof value.content !== "string") {
    return null;
  }
  if (value.role !== "user" && value.role !== "assistant" && value.role !== "tool") return null;

  const parsedToolCalls = Array.isArray(value.tool_calls)
    ? value.tool_calls.map(readToolCall)
    : undefined;
  if (parsedToolCalls?.some((call) => call === null)) return null;
  const toolCalls = parsedToolCalls?.filter((call) => call !== null);
  const toolCallId = typeof value.tool_call_id === "string" ? value.tool_call_id : undefined;

  if (value.role === "user" && (toolCalls?.length || toolCallId)) return null;
  if (value.role === "assistant" && toolCallId) return null;
  if (value.role === "tool" && (!toolCallId || toolCalls?.length)) return null;

  return {
    role: value.role,
    content: value.content,
    ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(toolCallId ? { tool_call_id: toolCallId } : {}),
  };
}

function messageChars(message: AssistantMessage) {
  return (
    message.role.length +
    message.content.length +
    (message.tool_call_id?.length ?? 0) +
    (message.tool_calls?.reduce(
      (sum, call) => sum + call.id.length + call.name.length + call.arguments.length,
      0,
    ) ?? 0)
  );
}

function validHistoryGroup(messages: AssistantMessage[]) {
  const pendingToolCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.tool_call_id || !pendingToolCalls.delete(message.tool_call_id)) return false;
      continue;
    }
    if (pendingToolCalls.size > 0) return false;
    if (message.role === "assistant" && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        if (!call.id || pendingToolCalls.has(call.id)) return false;
        pendingToolCalls.add(call.id);
      }
    }
  }
  return pendingToolCalls.size === 0;
}

/**
 * localStorage 可以被旧版本或手工修改。只恢复最近的完整用户轮次，避免把孤立的
 * tool 结果或任意 role 反复发给模型端点；边界与后端 prepare_history 保持一致。
 */
export function boundAssistantHistory(values: unknown[]): AssistantMessage[] {
  const groups: { messages: AssistantMessage[]; invalid: boolean }[] = [];
  let current: { messages: AssistantMessage[]; invalid: boolean } | null = null;

  for (const value of values) {
    const message = readMessage(value);
    // 和后端 prepare_history 一样，旧界面状态每轮都会被当前状态替换，既不持久化，
    // 也不占用户轮次预算。
    if (message?.role === "user" && message.content.startsWith(CONTEXT_PREFIX)) continue;
    if (message?.role === "user") {
      if (current) groups.push(current);
      current = { messages: [message], invalid: false };
    } else if (current) {
      if (message) current.messages.push(message);
      else current.invalid = true;
    }
  }
  if (current) groups.push(current);

  const valid = groups.filter(
    (group) =>
      !group.invalid && group.messages.length > 1 && validHistoryGroup(group.messages),
  );
  const kept: AssistantMessage[][] = [];
  let keptChars = 0;
  for (let index = valid.length - 1; index >= 0; index -= 1) {
    if (kept.length >= MAX_HISTORY_USER_TURNS) break;
    const group = valid[index].messages;
    const groupChars = group.reduce((sum, message) => sum + messageChars(message), 0);
    if (keptChars + groupChars > MAX_HISTORY_CHARS) break;
    kept.unshift(group);
    keptChars += groupChars;
  }
  return kept.flat();
}

/** 后端刚返回的历史已经过结构校验，只需按同一用户轮次/字符预算裁剪。 */
export function boundTrustedAssistantHistory(history: AssistantMessage[]): AssistantMessage[] {
  const messages = history.filter(
    (message) => !(message.role === "user" && message.content.startsWith(CONTEXT_PREFIX)),
  );
  const userStarts = messages.flatMap((message, index) =>
    message.role === "user" ? [index] : [],
  );
  let start = messages.length;
  let end = messages.length;
  let keptTurns = 0;
  let keptChars = 0;
  for (let index = userStarts.length - 1; index >= 0; index -= 1) {
    if (keptTurns >= MAX_HISTORY_USER_TURNS) break;
    const candidate = userStarts[index];
    const groupChars = messages
      .slice(candidate, end)
      .reduce((sum, message) => sum + messageChars(message), 0);
    if (keptChars + groupChars > MAX_HISTORY_CHARS) break;
    start = candidate;
    end = candidate;
    keptTurns += 1;
    keptChars += groupChars;
  }
  return start === messages.length ? [] : messages.slice(start);
}

/**
 * 去掉最后一次提问以及它之后的所有消息，得到「问那句话之前」的上下文。
 *
 * 重新生成用它：同一个问题要在同样的上下文里再问一遍，否则模型会看见自己上一次的
 * 回答，「换个说法再答一次」就变成了「顺着刚才继续说」——而用户点重新生成，恰恰是
 * 因为刚才那次不满意。
 *
 * 从最后一条 user 消息切断，那一轮的工具往返和界面操作回执都跟着丢掉：它们都是这次
 * 提问的产物，重问一遍会重新产生。
 */
export function historyBeforeLastQuestion(history: AssistantMessage[]): AssistantMessage[] {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].role === "user") return history.slice(0, index);
  }
  return [];
}

export function readAssistantSession(): AssistantSession {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_SESSION;
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return EMPTY_SESSION;

    const turns = Array.isArray(value.turns)
      ? value.turns
          .map(readTurn)
          .filter((turn) => turn !== null)
          .slice(-MAX_ASSISTANT_TURNS)
      : [];
    const history = Array.isArray(value.history) ? boundAssistantHistory(value.history) : [];
    const draft = typeof value.draft === "string" ? value.draft.slice(0, MAX_DRAFT_CHARS) : "";
    return { turns, history, draft };
  } catch {
    return EMPTY_SESSION;
  }
}

export function writeAssistantSession(session: AssistantSession) {
  try {
    // 主题已经当场生效；其余按钮都依赖生成时的界面状态，重启后不得复活。
    const hasLiveActionPayload = session.turns.some((turn) =>
      turn.actions.some((action) => action.kind !== "set_theme"),
    );
    const turns = session.turns
      .filter((turn) => !turn.pending)
      .slice(-MAX_ASSISTANT_TURNS)
      .map((turn) => ({
        ...turn,
        question: capAssistantText(turn.question, MAX_QUESTION_CHARS),
        answer: capAssistantText(turn.answer, MAX_ASSISTANT_ANSWER_CHARS),
        reasoning: turn.reasoning
          ? capAssistantText(turn.reasoning, MAX_ASSISTANT_REASONING_CHARS)
          : undefined,
        tools: turn.tools
          .map((tool) => capAssistantText(tool, MAX_TOOL_NAME_CHARS))
          .slice(-MAX_TOOLS_PER_TURN),
        actionResults: turn.actionResults
          .map((result) => capAssistantText(result, MAX_ACTION_RESULT_CHARS))
          .slice(-MAX_ACTION_RESULTS),
        actions: [],
        actionsExpired:
          turn.actionsExpired === true ||
          turn.actions.some((action) => action.kind !== "set_theme") ||
          undefined,
        pending: undefined,
      }));
    const cleanHistory = boundAssistantHistory(session.history);
    const history = hasLiveActionPayload
      ? boundAssistantHistory([
          ...cleanHistory,
          { role: "assistant", content: EXPIRED_ACTION_HISTORY_NOTICE },
        ])
      : cleanHistory;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        turns,
        history,
        draft: session.draft.slice(0, MAX_DRAFT_CHARS),
      }),
    );
  } catch {
    // 本地存储只是连续性增强；不可用时当前会话仍应正常工作。
  }
}

export function clearAssistantSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 同上，清理失败不应阻塞新对话。
  }
}

export const assistantSessionStorageKey = STORAGE_KEY;
