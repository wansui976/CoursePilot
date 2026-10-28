import { describe, expect, it } from "vitest";
import { createTurnStream, normalizeFinishedToolStatus, recordToolFinished } from "./assistantStream";
import type { Turn } from "./turnModel";

function harness() {
  let turn: Turn = {
    id: "t1",
    question: "q",
    answer: "",
    actions: [],
    tools: [],
    canceled: false,
    actionResults: [],
    pending: true,
  };
  const stream = createTurnStream({
    patch: (change) => {
      turn = change(turn);
    },
    isMounted: () => true,
  });
  return { stream, current: () => turn };
}

describe("createTurnStream", () => {
  it("缓冲 token / reasoning，flush 时一次写进轮次", () => {
    const { stream, current } = harness();
    stream.onEvent({ type: "token", delta: "你" });
    stream.onEvent({ type: "token", delta: "好" });
    stream.onEvent({ type: "reasoning", delta: "想" });
    expect(current().answer).toBe("");
    stream.flush();
    expect(current().answer).toBe("你好");
    expect(current().reasoning).toBe("想");
  });

  it("新一轮 turn 清掉上一轮的过场正文", () => {
    const { stream, current } = harness();
    stream.onEvent({ type: "token", delta: "先查一下" });
    stream.flush();
    stream.onEvent({ type: "turn", turn: 2 });
    stream.onEvent({ type: "token", delta: "结论" });
    stream.flush();
    expect(current().answer).toBe("结论");
  });

  it("工具开始 / 失败记进 toolRuns，并给出最后一次问题工具", () => {
    const { stream, current } = harness();
    stream.onEvent({ type: "tool", call_id: "c1", name: "search_content" });
    expect(current().activeTool).toEqual({ callId: "c1", name: "search_content" });
    stream.onEvent({
      type: "tool_finished",
      call_id: "c1",
      name: "search_content",
      status: "failed",
      canceled: false,
    });
    expect(current().activeTool).toBeUndefined();
    expect(current().toolExecutionStatus).toBe("failed");
    expect(current().toolRuns).toEqual([{ callId: "c1", name: "search_content", status: "failed" }]);
    expect(stream.latestToolIssue()).toEqual({ name: "search_content", status: "failed" });
    // 失败提示挂到下一段正文出现为止。
    stream.onEvent({ type: "token", delta: "x" });
    expect(current().toolExecutionStatus).toBeUndefined();
  });

  it("重复的 tool_finished 不会把终态改回去", () => {
    const { stream, current } = harness();
    stream.onEvent({ type: "tool", call_id: "c1", name: "a" });
    stream.onEvent({ type: "tool_finished", call_id: "c1", name: "a", status: "completed", canceled: false });
    stream.onEvent({ type: "tool_finished", call_id: "c1", name: "a", status: "failed", canceled: false });
    expect(current().toolRuns?.[0].status).toBe("completed");
  });
});

describe("tool status helpers", () => {
  it("未知状态按是否取消归类", () => {
    expect(normalizeFinishedToolStatus("weird", true)).toBe("canceled");
    expect(normalizeFinishedToolStatus(undefined, false)).toBe("unknown");
  });

  it("unknown 可以被确定的终态覆盖", () => {
    const runs = recordToolFinished([{ callId: "c", name: "a", status: "unknown" }], "c", "a", "completed");
    expect(runs[0].status).toBe("completed");
  });
});
