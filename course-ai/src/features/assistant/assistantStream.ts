import {
  capAssistantText,
  MAX_ASSISTANT_ANSWER_CHARS,
  MAX_ASSISTANT_REASONING_CHARS,
  type AssistantToolRun,
  type AssistantToolRunStatus,
} from "@/lib/assistantSession";
import type { AssistantEvent } from "@/lib/types";
import type { Turn } from "./turnModel";

/**
 * 一次提问的流式事件 → 轮次状态。
 *
 * 从 AssistantPanel 的 send 里拆出：事件怎么折叠成 Turn 与面板生命周期无关，
 * 面板只负责发起请求、在结束时收尾。
 */

export const MAX_STREAMED_TOOLS = 50;

export function appendStreamChunk(
  chunks: string[],
  currentChars: number,
  delta: string,
  maxChars: number,
) {
  const kept = delta.slice(0, Math.max(0, maxChars - currentChars));
  if (!kept) return currentChars;
  chunks.push(kept);
  // 后台标签页可能长时间不执行动画帧；偶尔合并小片段，避免数组对象本身无限增长。
  if (chunks.length >= 256) chunks.splice(0, chunks.length, chunks.join(""));
  return currentChars + kept.length;
}

export function recordToolStarted(
  toolRuns: AssistantToolRun[],
  callId: string,
  name: string,
): AssistantToolRun[] {
  const existing = toolRuns.find((run) => run.callId === callId);
  if (existing) return toolRuns;
  const next: AssistantToolRun = { callId, name, status: "running" };
  return [...toolRuns, next].slice(-MAX_STREAMED_TOOLS);
}

export function recordToolFinished(
  toolRuns: AssistantToolRun[],
  callId: string,
  name: string,
  status: AssistantToolRunStatus,
): AssistantToolRun[] {
  const index = toolRuns.findIndex((run) => run.callId === callId);
  if (index < 0) {
    const next: AssistantToolRun = { callId, name, status };
    return [...toolRuns, next].slice(-MAX_STREAMED_TOOLS);
  }
  // 重复或迟到事件不能把一个已经确定的终态改回另一种状态。
  if (
    toolRuns[index].status !== "running" &&
    !(toolRuns[index].status === "unknown" && status !== "unknown")
  ) {
    return toolRuns;
  }
  return toolRuns.map((run, runIndex) =>
    runIndex === index ? { ...run, name, status } : run,
  );
}

export function normalizeFinishedToolStatus(
  status: unknown,
  canceled: boolean,
): AssistantToolRunStatus {
  return status === "completed" || status === "failed" || status === "canceled"
    ? status
    : canceled
      ? "canceled"
      : "unknown";
}

export type ToolIssue = { name: string; status: "failed" | "canceled" };

export type TurnStream = {
  /** 交给 ipc.assistant.ask 的事件回调。 */
  onEvent: (event: AssistantEvent) => void;
  /** 立即把缓冲的片段写进轮次（请求结束时调用，免得最后一帧丢掉）。 */
  flush: () => void;
  /** 本次请求里最后一个失败 / 取消的工具，用于结束播报。 */
  latestToolIssue: () => ToolIssue | null;
};

/**
 * SSE 常把一个字拆成一个事件。逐片 setState 会让 React 每秒渲染几十次，并反复复制
 * 已有长字符串；先缓冲到下一帧，每帧最多更新一次。
 */
export function createTurnStream({
  patch,
  isMounted,
}: {
  patch: (change: (turn: Turn) => Turn) => void;
  isMounted: () => boolean;
}): TurnStream {
  let streamFrame: number | null = null;
  let clearBufferedAnswer = false;
  let bufferedAnswer: string[] = [];
  let bufferedAnswerChars = 0;
  let bufferedReasoning: string[] = [];
  let bufferedReasoningChars = 0;
  let bufferedTools: string[] = [];
  let hasToolOutcomePhase = false;
  let toolIssue: ToolIssue | null = null;
  const seenToolCallIds = new Set<string>();
  const finishedToolStatuses = new Map<string, AssistantToolRunStatus>();

  const flush = () => {
    if (streamFrame != null) cancelAnimationFrame(streamFrame);
    streamFrame = null;
    if (!isMounted()) return;
    const answerDelta = bufferedAnswer.join("");
    const reasoningDelta = bufferedReasoning.join("");
    const toolsDelta = bufferedTools;
    const shouldClear = clearBufferedAnswer;
    bufferedAnswer = [];
    bufferedAnswerChars = 0;
    bufferedReasoning = [];
    bufferedReasoningChars = 0;
    bufferedTools = [];
    clearBufferedAnswer = false;
    if (!shouldClear && !answerDelta && !reasoningDelta && toolsDelta.length === 0) return;
    patch((item) => ({
      ...item,
      answer: capAssistantText(
        `${shouldClear ? "" : item.answer}${answerDelta}`,
        MAX_ASSISTANT_ANSWER_CHARS,
      ),
      reasoning: reasoningDelta
        ? capAssistantText(`${item.reasoning ?? ""}${reasoningDelta}`, MAX_ASSISTANT_REASONING_CHARS)
        : item.reasoning,
      tools:
        toolsDelta.length > 0
          ? [...item.tools, ...toolsDelta].slice(-MAX_STREAMED_TOOLS)
          : item.tools,
    }));
  };
  const scheduleFlush = () => {
    if (streamFrame == null) streamFrame = requestAnimationFrame(flush);
  };
  // 工具失败 / 取消的提示只挂到下一段正文或思考出现为止。
  const leaveToolOutcomePhase = () => {
    if (!hasToolOutcomePhase) return;
    hasToolOutcomePhase = false;
    patch((item) => ({
      ...item,
      toolExecutionStatus: undefined,
      toolExecutionName: undefined,
    }));
  };

  const onEvent = (event: AssistantEvent) => {
    if (!isMounted() || event.type === "started") return;
    if (event.type === "turn") {
      clearBufferedAnswer = true;
      bufferedAnswer = [];
      bufferedAnswerChars = 0;
      hasToolOutcomePhase = false;
      patch((item) => ({
        ...item,
        activeTool: undefined,
        toolExecutionStatus: undefined,
        toolExecutionName: undefined,
      }));
      scheduleFlush();
    } else if (event.type === "reasoning") {
      leaveToolOutcomePhase();
      bufferedReasoningChars = appendStreamChunk(
        bufferedReasoning,
        bufferedReasoningChars,
        event.delta,
        MAX_ASSISTANT_REASONING_CHARS,
      );
      scheduleFlush();
    } else if (event.type === "token") {
      leaveToolOutcomePhase();
      bufferedAnswerChars = appendStreamChunk(
        bufferedAnswer,
        bufferedAnswerChars,
        event.delta,
        MAX_ASSISTANT_ANSWER_CHARS,
      );
      scheduleFlush();
    } else if (event.type === "tool") {
      if (seenToolCallIds.has(event.call_id)) return;
      seenToolCallIds.add(event.call_id);
      bufferedTools = [...bufferedTools, event.name].slice(-MAX_STREAMED_TOOLS);
      hasToolOutcomePhase = false;
      patch((item) => ({
        ...item,
        activeTool: { callId: event.call_id, name: event.name },
        toolExecutionStatus: undefined,
        toolExecutionName: undefined,
        toolRuns: recordToolStarted(item.toolRuns ?? [], event.call_id, event.name),
      }));
      scheduleFlush();
    } else if (event.type === "tool_finished") {
      const toolStatus = normalizeFinishedToolStatus(event.status, event.canceled);
      const previousStatus = finishedToolStatuses.get(event.call_id);
      if (previousStatus && (previousStatus !== "unknown" || toolStatus === "unknown")) return;
      seenToolCallIds.add(event.call_id);
      finishedToolStatuses.set(event.call_id, toolStatus);
      const issue = toolStatus === "failed" || toolStatus === "canceled";
      if (issue) toolIssue = { name: event.name, status: toolStatus };
      hasToolOutcomePhase = issue;
      patch((item) => ({
        ...item,
        activeTool: item.activeTool?.callId === event.call_id ? undefined : item.activeTool,
        toolExecutionStatus: issue ? toolStatus : undefined,
        toolExecutionName: issue ? event.name : undefined,
        toolRuns: recordToolFinished(item.toolRuns ?? [], event.call_id, event.name, toolStatus),
      }));
    } else if (event.type === "turn_limit") {
      // 撞上限到总结完成之间可能还有十几秒，期间没有任何其他事件；
      // 挂出进行中状态，否则用户只看到卡住。
      patch((item) => ({
        ...item,
        turnLimitNoticed: true,
        activeTool: undefined,
        toolExecutionStatus: undefined,
        toolExecutionName: undefined,
      }));
      scheduleFlush();
    }
  };

  return { onEvent, flush, latestToolIssue: () => toolIssue };
}
