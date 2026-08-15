import type {
  AssistantAction,
  AssistantContext,
  AssistantMessage,
  ToolExecutionStatus,
} from "./types";

const STORAGE_KEY = "course-ai-assistant-session:v1";
export const MAX_ASSISTANT_TURNS = 20;
export const MAX_ASSISTANT_ANSWER_CHARS = 24_000;
export const MAX_ASSISTANT_REASONING_CHARS = 16_000;
const MAX_DRAFT_CHARS = 10_000;
const MAX_QUESTION_CHARS = 10_000;
const MAX_TOOL_NAME_CHARS = 200;
const MAX_TOOL_CALL_ID_CHARS = 256;
const MAX_TOOLS_PER_TURN = 50;
const MAX_HISTORY_USER_TURNS = 8;
const MAX_HISTORY_CHARS = 48_000;
const MAX_ACTION_RESULTS = 50;
const MAX_ACTION_RESULT_CHARS = 2_000;
const MAX_CHECKPOINT_TARGETS = 12;
const MAX_CHECKPOINT_LABEL_CHARS = 240;
const CONTEXT_PREFIX = "（界面状态：";
const EXPIRED_ACTION_HISTORY_NOTICE =
  "（界面操作结果：应用重启后，本轮旧操作按钮已失效；已经完成的结果以操作记录为准，尚未确认的操作未执行。如仍需操作，必须重新调用工具核对当前状态并生成新按钮。）";
const INTERRUPTED_ACTION_HISTORY_NOTICE =
  "（界面操作结果：应用在操作执行期间关闭，部分操作结果可能已经生效；旧按钮已经失效。继续之前必须重新调用工具核对当前状态，不能直接重复执行。）";
const UI_ACTION_RESULT_PREFIXES = ["（界面操作结果：", "(UI action result:"];

export const ASSISTANT_CHECKPOINT_VERSION = 1 as const;
export const ASSISTANT_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_ASSISTANT_PROMPT_HISTORY = 50;
export const MAX_ASSISTANT_PROMPT_CHARS = MAX_QUESTION_CHARS;

type CheckpointAction = Exclude<AssistantAction, { kind: "set_theme" }>;
export type AssistantCheckpointActionKind = CheckpointAction["kind"];

export interface AssistantCheckpointTarget {
  action: AssistantCheckpointActionKind;
  /** 仅供重新说明上下文，不包含 URL、路径、新值或资源 id。 */
  label?: string;
  courseLabel?: string;
}

export interface AssistantCheckpoint {
  version: typeof ASSISTANT_CHECKPOINT_VERSION;
  /** 从本地存储读出的检查点永远不可执行。 */
  status: "expired";
  expiredReason: "restart" | "timeout" | "interrupted";
  createdAt: number;
  expiresAt: number;
  targets: AssistantCheckpointTarget[];
}

export type AssistantInteractionState =
  | { status: "none" }
  | { status: "awaiting_user"; actions: CheckpointAction[] }
  | { status: "executing"; actions: CheckpointAction[] }
  | { status: "expired"; checkpoint?: AssistantCheckpoint };

export type AssistantToolRunStatus = "running" | "unknown" | ToolExecutionStatus;

export interface AssistantToolRun {
  callId: string;
  name: string;
  status: AssistantToolRunStatus;
}

/**
 * 以最终工具名列表为顺序基准补齐逐调用状态，同时保留流事件里独有的调用。
 * `finalizeRunning` 只用于请求结束或会话恢复，不能让仍在执行的界面状态提前结束。
 */
export function reconcileAssistantToolRuns(
  tools: string[],
  toolRuns: AssistantToolRun[],
  finalizeRunning = false,
): AssistantToolRun[] {
  const unmatched = toolRuns.map((run) =>
    finalizeRunning && run.status === "running" ? { ...run, status: "unknown" as const } : run,
  );
  const ordered = tools.map((name, index) => {
    const matchIndex = unmatched.findIndex((run) => run.name === name);
    if (matchIndex < 0) {
      return { callId: `legacy-${index}`, name, status: "unknown" as const };
    }
    return unmatched.splice(matchIndex, 1)[0];
  });
  return [...ordered, ...unmatched].slice(-MAX_TOOLS_PER_TURN);
}

export interface AssistantTurnRecord {
  id: string;
  question: string;
  answer: string;
  /** 推理模型的思考过程；随答案一起保留，答案出来后折叠展示。旧记录没有。 */
  reasoning?: string;
  actions: AssistantAction[];
  /** 当前进程里已经成功、跳过、取消或判定失效的动作索引；只用于筛掉恢复检查点。 */
  resolvedActionIndexes?: number[];
  /** 正在执行、但尚未拿到确定结果的动作索引；卸载时据此保存结果不确定的检查点。 */
  executingActionIndexes?: number[];
  /** 重启前这一轮曾有操作按钮；参数不会落盘，恢复后只能提示用户重新发起。 */
  actionsExpired?: boolean;
  /** 重启后只用于解释等待过什么；不能转换回 AssistantAction。 */
  checkpoint?: AssistantCheckpoint;
  tools: string[];
  /** 每次工具调用各自的终态；旧会话只有 tools，渲染时按状态未知兼容。 */
  toolRuns?: AssistantToolRun[];
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
  /** 旧调用端可随会话保存；新版输入历史使用独立的全局存储。 */
  promptHistory?: string[];
}

const EMPTY_SESSION: AssistantSession = { turns: [], history: [], draft: "" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function capAssistantText(value: string, maxChars: number) {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

export function boundAssistantPromptHistory(values: unknown[]): string[] {
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => capAssistantText(value.trim(), MAX_ASSISTANT_PROMPT_CHARS))
    .filter(Boolean)
    .slice(-MAX_ASSISTANT_PROMPT_HISTORY);
}

const CHECKPOINT_ACTION_KINDS = new Set<AssistantCheckpointActionKind>([
  "open_video",
  "seek_to",
  "propose_rename",
  "propose_delete",
  "propose_setting",
  "propose_import",
  "propose_create_course",
  "propose_rename_course",
]);

function isCheckpointActionKind(value: unknown): value is AssistantCheckpointActionKind {
  return (
    typeof value === "string" &&
    CHECKPOINT_ACTION_KINDS.has(value as AssistantCheckpointActionKind)
  );
}

function safeCheckpointLabel(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // 导入标题可能直接回退为 URL；路径和 URL 都不能进入可恢复状态。
  if (
    /[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ||
    /(?:^|\s)(?:~?\/|\\\\)\S/.test(trimmed) ||
    /(?:^|\s)[a-z]:[\\/]\S/i.test(trimmed)
  ) {
    return undefined;
  }
  return capAssistantText(trimmed, MAX_CHECKPOINT_LABEL_CHARS);
}

function checkpointTarget(action: CheckpointAction): AssistantCheckpointTarget {
  switch (action.kind) {
    case "open_video":
      return { action: action.kind, label: safeCheckpointLabel(action.title) };
    case "seek_to":
      return { action: action.kind };
    case "propose_rename":
      return {
        action: action.kind,
        label: safeCheckpointLabel(action.current_title),
        courseLabel: safeCheckpointLabel(action.course_name),
      };
    case "propose_delete":
      return {
        action: action.kind,
        label: safeCheckpointLabel(action.title),
        courseLabel: safeCheckpointLabel(action.course_name),
      };
    case "propose_setting":
      return { action: action.kind, label: safeCheckpointLabel(action.label) };
    case "propose_import":
      return {
        action: action.kind,
        label: safeCheckpointLabel(action.title),
        courseLabel: safeCheckpointLabel(action.course_name),
      };
    case "propose_create_course":
      return { action: action.kind, label: safeCheckpointLabel(action.name) };
    case "propose_rename_course":
      return { action: action.kind, label: safeCheckpointLabel(action.current_name) };
  }
}

function createCheckpoint(
  actions: CheckpointAction[],
  status: "awaiting_user" | "executing",
  now: number,
) {
  return {
    version: ASSISTANT_CHECKPOINT_VERSION,
    status,
    createdAt: now,
    expiresAt: now + ASSISTANT_CHECKPOINT_TTL_MS,
    targets: actions.slice(0, MAX_CHECKPOINT_TARGETS).map(checkpointTarget),
  };
}

function readCheckpointTarget(value: unknown): AssistantCheckpointTarget | null {
  if (!isRecord(value) || !isCheckpointActionKind(value.action)) return null;
  const label = safeCheckpointLabel(value.label);
  const courseLabel = safeCheckpointLabel(value.courseLabel);
  return {
    action: value.action,
    ...(label ? { label } : {}),
    ...(courseLabel ? { courseLabel } : {}),
  };
}

function readCheckpoint(value: unknown, now: number): AssistantCheckpoint | undefined {
  if (
    !isRecord(value) ||
    value.version !== ASSISTANT_CHECKPOINT_VERSION ||
    (value.status !== "awaiting_user" &&
      value.status !== "executing" &&
      value.status !== "expired") ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt < 0 ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt < value.createdAt ||
    !Array.isArray(value.targets)
  ) {
    return undefined;
  }
  const targets = value.targets
    .map(readCheckpointTarget)
    .filter((target) => target !== null)
    .slice(0, MAX_CHECKPOINT_TARGETS);
  if (targets.length === 0) return undefined;
  const interrupted =
    value.status === "executing" ||
    (value.status === "expired" && value.expiredReason === "interrupted");
  return {
    version: ASSISTANT_CHECKPOINT_VERSION,
    status: "expired",
    expiredReason: interrupted ? "interrupted" : now >= value.expiresAt ? "timeout" : "restart",
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    targets,
  };
}

export function getAssistantInteractionState(
  turn: AssistantTurnRecord,
): AssistantInteractionState {
  const resolved = new Set(
    (turn.resolvedActionIndexes ?? []).filter(
      (index) => Number.isInteger(index) && index >= 0 && index < turn.actions.length,
    ),
  );
  const executing = new Set(
    (turn.executingActionIndexes ?? []).filter(
      (index) => Number.isInteger(index) && index >= 0 && index < turn.actions.length,
    ),
  );
  const unresolved = turn.actions
    .map((action, index) => ({ action, index }))
    .filter(
      (entry): entry is { action: CheckpointAction; index: number } =>
        entry.action.kind !== "set_theme" && !resolved.has(entry.index),
    );
  const actions = unresolved.map(({ action }) => action);
  if (unresolved.some(({ index }) => executing.has(index))) {
    return { status: "executing", actions };
  }
  if (actions.length > 0) return { status: "awaiting_user", actions };
  if (turn.actionsExpired || turn.checkpoint) {
    return {
      status: "expired",
      ...(turn.checkpoint ? { checkpoint: turn.checkpoint } : {}),
    };
  }
  return { status: "none" };
}

const TOOL_RUN_STATUSES = new Set<AssistantToolRunStatus>([
  "running",
  "unknown",
  "completed",
  "failed",
  "canceled",
]);

function readToolRun(value: unknown): AssistantToolRun | null {
  if (
    !isRecord(value) ||
    typeof value.callId !== "string" ||
    !value.callId ||
    typeof value.name !== "string" ||
    !value.name
  ) {
    return null;
  }
  const status =
    typeof value.status === "string" &&
    TOOL_RUN_STATUSES.has(value.status as AssistantToolRunStatus) &&
    value.status !== "running"
      ? (value.status as AssistantToolRunStatus)
      : "unknown";
  return {
    callId: capAssistantText(value.callId, MAX_TOOL_CALL_ID_CHARS),
    name: capAssistantText(value.name, MAX_TOOL_NAME_CHARS),
    // 持久化会话里不应出现仍在转动的工具；旧版本或手工数据一律按未知终态恢复。
    status,
  };
}

function readTurn(value: unknown, now: number): AssistantTurnRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.question !== "string" ||
    typeof value.answer !== "string"
  ) {
    return null;
  }

  const checkpoint = readCheckpoint(value.checkpoint, now);
  const tools = Array.isArray(value.tools)
    ? value.tools
        .filter((tool): tool is string => typeof tool === "string")
        .map((tool) => capAssistantText(tool, MAX_TOOL_NAME_CHARS))
        .slice(-MAX_TOOLS_PER_TURN)
    : [];
  const toolRuns = Array.isArray(value.toolRuns)
    ? reconcileAssistantToolRuns(
        tools,
        value.toolRuns
          .map(readToolRun)
          .filter((run) => run !== null)
          .slice(-MAX_TOOLS_PER_TURN),
        true,
      )
    : undefined;
  return {
    id: value.id,
    question: capAssistantText(value.question, MAX_QUESTION_CHARS),
    answer: capAssistantText(value.answer, MAX_ASSISTANT_ANSWER_CHARS),
    ...(typeof value.reasoning === "string" && value.reasoning
      ? { reasoning: capAssistantText(value.reasoning, MAX_ASSISTANT_REASONING_CHARS) }
      : {}),
    // 旧确认卡不能跨重启复活：用户可能已经在别处完成了同一操作。
    actions: [],
    ...(value.actionsExpired === true || checkpoint ? { actionsExpired: true } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    tools,
    ...(toolRuns ? { toolRuns } : {}),
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
 * 去掉最后一次提问对应的模型往返，得到「问那句话之前」的上下文。
 *
 * 重新生成用它：同一个问题要在同样的上下文里再问一遍，否则模型会看见自己上一次的
 * 回答，「换个说法再答一次」就变成了「顺着刚才继续说」——而用户点重新生成，恰恰是
 * 因为刚才那次不满意。
 *
 * 界面操作回执是例外：它可能来自更早轮次、只是在这轮请求期间才完成；即使来自当前轮次，
 * 外部副作用也不会随重生成撤销。必须把这些回执留下，避免模型随后重复执行。
 */
export function historyBeforeLastQuestion(history: AssistantMessage[]): AssistantMessage[] {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].role !== "user") continue;
    const actionResults = history.slice(index + 1).filter(
      (message) =>
        message.role === "assistant" &&
        UI_ACTION_RESULT_PREFIXES.some((prefix) => message.content.startsWith(prefix)),
    );
    const before = history.slice(0, index);
    // 后端只接受从 user 开始的完整轮次。第一轮发生过外部副作用时，保留原问题作为
    // 回执锚点；否则孤立的 assistant 回执会在 prepare_history 中被直接丢弃。
    return actionResults.length > 0 && !before.some((message) => message.role === "user")
      ? [history[index], ...actionResults]
      : [...before, ...actionResults];
  }
  return [];
}

export function deserializeAssistantSession(
  serialized: string | null | undefined,
  now = Date.now(),
): AssistantSession {
  try {
    if (!serialized) return EMPTY_SESSION;
    const value = JSON.parse(serialized) as unknown;
    if (!isRecord(value)) return EMPTY_SESSION;

    const turns = Array.isArray(value.turns)
      ? value.turns
          .map((turn) => readTurn(turn, now))
          .filter((turn) => turn !== null)
          .slice(-MAX_ASSISTANT_TURNS)
      : [];
    const history = Array.isArray(value.history) ? boundAssistantHistory(value.history) : [];
    const draft = typeof value.draft === "string" ? value.draft.slice(0, MAX_DRAFT_CHARS) : "";
    const promptHistory = Array.isArray(value.promptHistory)
      ? boundAssistantPromptHistory(value.promptHistory)
      : [];
    return {
      turns,
      history,
      draft,
      ...(promptHistory.length > 0 ? { promptHistory } : {}),
    };
  } catch {
    return EMPTY_SESSION;
  }
}

export function serializeAssistantSession(session: AssistantSession, now = Date.now()) {
  // 主题已经当场生效；其余按钮都依赖生成时的界面状态，重启后不得复活。
  const persistableTurns = session.turns
    .filter((turn) => !turn.pending)
    .slice(-MAX_ASSISTANT_TURNS);
  const interactions = persistableTurns.map(getAssistantInteractionState);
  const hasLiveActionPayload = interactions.some(
    (interaction) =>
      interaction.status === "awaiting_user" || interaction.status === "executing",
  );
  const hasExecutingAction = interactions.some(
    (interaction) => interaction.status === "executing",
  );
  const turns = persistableTurns.map((turn) => {
    const interaction = getAssistantInteractionState(turn);
    const checkpoint =
      interaction.status === "awaiting_user" || interaction.status === "executing"
        ? createCheckpoint(interaction.actions, interaction.status, now)
        : turn.checkpoint;
    return {
      ...turn,
      question: capAssistantText(turn.question, MAX_QUESTION_CHARS),
      answer: capAssistantText(turn.answer, MAX_ASSISTANT_ANSWER_CHARS),
      reasoning: turn.reasoning
        ? capAssistantText(turn.reasoning, MAX_ASSISTANT_REASONING_CHARS)
        : undefined,
      tools: turn.tools
        .map((tool) => capAssistantText(tool, MAX_TOOL_NAME_CHARS))
        .slice(-MAX_TOOLS_PER_TURN),
      toolRuns: turn.toolRuns
        ?.map((run) => ({
          callId: capAssistantText(run.callId, MAX_TOOL_CALL_ID_CHARS),
          name: capAssistantText(run.name, MAX_TOOL_NAME_CHARS),
          // 进程结束后已经无法判断调用是否真正完成，不能恢复成仍在运行。
          status: run.status === "running" ? "unknown" : run.status,
        }))
        .slice(-MAX_TOOLS_PER_TURN),
      actionResults: turn.actionResults
        .map((result) => capAssistantText(result, MAX_ACTION_RESULT_CHARS))
        .slice(-MAX_ACTION_RESULTS),
      actions: [],
      resolvedActionIndexes: undefined,
      executingActionIndexes: undefined,
      actionsExpired: interaction.status !== "none" || undefined,
      checkpoint,
      pending: undefined,
    };
  });
  const cleanHistory = boundAssistantHistory(session.history);
  const history = hasLiveActionPayload
    ? boundAssistantHistory([
        ...cleanHistory,
        {
          role: "assistant",
          content: hasExecutingAction
            ? INTERRUPTED_ACTION_HISTORY_NOTICE
            : EXPIRED_ACTION_HISTORY_NOTICE,
        },
      ])
    : cleanHistory;
  return JSON.stringify({
    turns,
    history,
    draft: session.draft.slice(0, MAX_DRAFT_CHARS),
    ...(session.promptHistory?.length
      ? { promptHistory: boundAssistantPromptHistory(session.promptHistory) }
      : {}),
  });
}

export function readAssistantSession(now = Date.now()): AssistantSession {
  try {
    return deserializeAssistantSession(localStorage.getItem(STORAGE_KEY), now);
  } catch {
    return EMPTY_SESSION;
  }
}

export function writeAssistantSession(session: AssistantSession, now = Date.now()) {
  try {
    localStorage.setItem(STORAGE_KEY, serializeAssistantSession(session, now));
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
