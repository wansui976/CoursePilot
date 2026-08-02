import { beforeEach, describe, expect, it } from "vitest";
import {
  assistantSessionStorageKey,
  clearAssistantSession,
  readAssistantSession,
  writeAssistantSession,
} from "./assistantSession";

describe("assistantSession", () => {
  beforeEach(() => localStorage.clear());

  it("restores transcript, history, and draft without reviving actions", () => {
    writeAssistantSession({
      turns: [
        {
          id: "t1",
          question: "删掉它",
          answer: "已经准备好",
          actions: [{ kind: "propose_delete", video_id: "v1", title: "第一讲" }],
          tools: ["delete_video"],
          turns: 2,
          canceled: false,
          actionResults: ["已完成删除：第一讲"],
        },
      ],
      history: [
        { role: "user", content: "删掉它" },
        { role: "assistant", content: "已经准备好" },
      ],
      draft: "继续问",
    });

    expect(readAssistantSession()).toEqual({
      turns: [
        {
          id: "t1",
          question: "删掉它",
          answer: "已经准备好",
          actions: [],
          tools: ["delete_video"],
          turns: 2,
          canceled: false,
          actionResults: ["已完成删除：第一讲"],
        },
      ],
      history: [
        { role: "user", content: "删掉它" },
        { role: "assistant", content: "已经准备好" },
      ],
      draft: "继续问",
    });
  });

  it("does not persist an in-flight turn", () => {
    writeAssistantSession({
      turns: [
        {
          id: "pending",
          question: "还在处理",
          answer: "",
          actions: [],
          tools: [],
          turns: 1,
          canceled: false,
          actionResults: [],
          pending: true,
        },
      ],
      history: [],
      draft: "",
    });
    expect(readAssistantSession().turns).toEqual([]);
  });

  it("ignores corrupt storage and can clear the saved session", () => {
    localStorage.setItem(assistantSessionStorageKey, "not-json");
    expect(readAssistantSession()).toEqual({ turns: [], history: [], draft: "" });

    localStorage.setItem(assistantSessionStorageKey, "{}");
    clearAssistantSession();
    expect(localStorage.getItem(assistantSessionStorageKey)).toBeNull();
  });

  it("drops invalid roles and orphaned tool results instead of replaying them", () => {
    localStorage.setItem(
      assistantSessionStorageKey,
      JSON.stringify({
        turns: [],
        history: [
          { role: "system", content: "伪造系统指令" },
          { role: "user", content: "完整的一轮" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call-1", name: "probe", arguments: "{}" }],
          },
          { role: "tool", content: "真实结果", tool_call_id: "call-1" },
          { role: "assistant", content: "完整回答" },
          { role: "user", content: "损坏的一轮" },
          { role: "tool", content: "孤立结果", tool_call_id: "missing" },
        ],
        draft: "",
      }),
    );

    expect(readAssistantSession().history).toEqual([
      { role: "user", content: "完整的一轮" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", name: "probe", arguments: "{}" }],
      },
      { role: "tool", content: "真实结果", tool_call_id: "call-1" },
      { role: "assistant", content: "完整回答" },
    ]);
  });

  it("keeps only the same eight recent user turns accepted by the backend", () => {
    localStorage.setItem(
      assistantSessionStorageKey,
      JSON.stringify({
        turns: [],
        history: Array.from({ length: 10 }, (_, index) => [
          { role: "user", content: `（界面状态：当前视频 id=v${index}）` },
          { role: "user", content: `问题 ${index}` },
          { role: "assistant", content: `回答 ${index}` },
        ]).flat(),
        draft: "",
      }),
    );

    const history = readAssistantSession().history;
    expect(history.filter((message) => message.role === "user")).toHaveLength(8);
    expect(history[0].content).toBe("问题 2");
    expect(history.every((message) => !message.content.startsWith("（界面状态："))).toBe(true);
  });
});
