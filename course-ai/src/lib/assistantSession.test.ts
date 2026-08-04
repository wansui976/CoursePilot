import { beforeEach, describe, expect, it } from "vitest";
import {
  assistantSessionStorageKey,
  clearAssistantSession,
  historyBeforeLastQuestion,
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

describe("historyBeforeLastQuestion", () => {
  it("退回到提问之前，好让同一个问题在同样的上下文里重问一遍", () => {
    // 不退回去，模型会看见自己刚才那次回答，「重新回答」就变成了「顺着刚才继续说」
    // ——而用户点它，恰恰是因为刚才那次不满意。
    const history = [
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" },
      { role: "assistant", content: "第二答" },
    ];

    expect(historyBeforeLastQuestion(history)).toEqual([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
    ]);
  });

  it("那一轮的工具往返和操作回执一起丢掉，它们都是这次提问的产物", () => {
    const history = [
      { role: "user", content: "旧问" },
      { role: "assistant", content: "旧答" },
      { role: "user", content: "删掉第三讲" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", name: "delete_video", arguments: "{}" }],
      },
      { role: "tool", content: "已生成确认卡", tool_call_id: "c1" },
      { role: "assistant", content: "要删哪个？" },
      { role: "assistant", content: "（界面操作结果：已移入回收站）" },
    ];

    expect(historyBeforeLastQuestion(history)).toEqual([
      { role: "user", content: "旧问" },
      { role: "assistant", content: "旧答" },
    ]);
  });

  it("只有一轮时退回空上下文", () => {
    expect(
      historyBeforeLastQuestion([
        { role: "user", content: "唯一一问" },
        { role: "assistant", content: "唯一一答" },
      ]),
    ).toEqual([]);
    expect(historyBeforeLastQuestion([])).toEqual([]);
  });
});
