import { beforeEach, describe, expect, it } from "vitest";
import {
  ASSISTANT_CHECKPOINT_TTL_MS,
  assistantSessionStorageKey,
  clearAssistantSession,
  getAssistantInteractionState,
  historyBeforeLastQuestion,
  MAX_ASSISTANT_ANSWER_CHARS,
  MAX_ASSISTANT_REASONING_CHARS,
  readAssistantSession,
  writeAssistantSession,
} from "./assistantSession";

describe("assistantSession", () => {
  beforeEach(() => localStorage.clear());

  it("restores transcript, history, and draft without reviving executable actions", () => {
    const savedAt = 1_000;
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
    }, savedAt);

    const restored = readAssistantSession(savedAt + 1);
    expect(restored).toEqual({
      turns: [
        {
          id: "t1",
          question: "删掉它",
          answer: "已经准备好",
          actions: [],
          actionsExpired: true,
          checkpoint: {
            version: 1,
            status: "expired",
            expiredReason: "restart",
            createdAt: savedAt,
            expiresAt: savedAt + ASSISTANT_CHECKPOINT_TTL_MS,
            targets: [{ action: "propose_delete", label: "第一讲" }],
          },
          tools: ["delete_video"],
          canceled: false,
          actionResults: ["已完成删除：第一讲"],
        },
      ],
      history: [
        { role: "user", content: "删掉它" },
        { role: "assistant", content: "已经准备好" },
        {
          role: "assistant",
          content:
            "（界面操作结果：应用重启后，本轮旧操作按钮已失效；已经完成的结果以操作记录为准，尚未确认的操作未执行。如仍需操作，必须重新调用工具核对当前状态并生成新按钮。）",
        },
      ],
      draft: "继续问",
    });
    expect(getAssistantInteractionState(restored.turns[0])).toMatchObject({
      status: "expired",
      checkpoint: { expiredReason: "restart" },
    });

    const stored = JSON.parse(localStorage.getItem(assistantSessionStorageKey) ?? "{}") as {
      turns?: Array<{
        actions?: unknown[];
        actionsExpired?: boolean;
        checkpoint?: { status?: string };
      }>;
    };
    expect(stored.turns?.[0]).toMatchObject({ actions: [], actionsExpired: true });
    expect(stored.turns?.[0].checkpoint?.status).toBe("awaiting_user");
  });

  it("keeps checkpoint descriptions non-executable and strips sensitive action parameters", () => {
    writeAssistantSession(
      {
        turns: [
          {
            id: "t1",
            question: "准备这些操作",
            answer: "请确认",
            actions: [
              {
                kind: "propose_import",
                url: "https://example.test/private-video",
                title: "待导入 https://example.test/private-video",
                course_id: "course-secret-id",
                course_name: "课程甲",
              },
              {
                kind: "propose_create_course",
                name: "新课程",
                root_path: "/Users/test/private-course",
              },
              {
                kind: "propose_setting",
                key: "provider_api_key",
                label: "模型设置",
                current: "old-secret-value",
                value: "new-secret-value",
              },
              {
                kind: "propose_rename",
                video_id: "video-secret-id",
                current_title: "第一讲",
                new_title: "内部新标题",
              },
              { kind: "seek_to", at_ms: 98_765 },
            ],
            tools: [],
            canceled: false,
            actionResults: [],
          },
        ],
        history: [],
        draft: "",
      },
      2_000,
    );

    const stored = JSON.parse(localStorage.getItem(assistantSessionStorageKey) ?? "{}") as {
      turns?: Array<{ checkpoint?: unknown }>;
    };
    const checkpointText = JSON.stringify(stored.turns?.[0].checkpoint);
    expect(checkpointText).not.toContain("example.test");
    expect(checkpointText).not.toContain("private-course");
    expect(checkpointText).not.toContain("secret-id");
    expect(checkpointText).not.toContain("secret-value");
    expect(checkpointText).not.toContain("内部新标题");
    expect(checkpointText).not.toContain("98765");
    expect(readAssistantSession(2_001).turns[0].checkpoint?.targets).toEqual([
      { action: "propose_import", courseLabel: "课程甲" },
      { action: "propose_create_course", label: "新课程" },
      { action: "propose_setting", label: "模型设置" },
      { action: "propose_rename", label: "第一讲" },
      { action: "seek_to" },
    ]);
  });

  it("preserves same-named targets as separate display records without persisting their ids", () => {
    writeAssistantSession(
      {
        turns: [
          {
            id: "same-name",
            question: "删除两门课里的导论",
            answer: "请逐项确认",
            actions: [
              {
                kind: "propose_delete",
                video_id: "video-a",
                course_id: "course-a",
                course_name: "课程甲",
                title: "导论",
              },
              {
                kind: "propose_delete",
                video_id: "video-b",
                course_id: "course-b",
                course_name: "课程乙",
                title: "导论",
              },
            ],
            tools: [],
            canceled: false,
            actionResults: [],
          },
        ],
        history: [],
        draft: "",
      },
      3_000,
    );

    const checkpoint = readAssistantSession(3_001).turns[0].checkpoint;
    expect(checkpoint?.targets).toEqual([
      { action: "propose_delete", label: "导论", courseLabel: "课程甲" },
      { action: "propose_delete", label: "导论", courseLabel: "课程乙" },
    ]);
    expect(JSON.stringify(checkpoint)).not.toContain("video-a");
    expect(JSON.stringify(checkpoint)).not.toContain("course-a");
  });

  it("marks an old checkpoint as timed out and still never restores stale resource actions", () => {
    const savedAt = 4_000;
    writeAssistantSession(
      {
        turns: [
          {
            id: "deleted-resource",
            question: "打开之后可能已删除的视频",
            answer: "已准备",
            actions: [
              { kind: "open_video", video_id: "deleted-video", title: "已删除的课" },
            ],
            tools: ["open_video"],
            canceled: false,
            actionResults: [],
          },
        ],
        history: [],
        draft: "",
      },
      savedAt,
    );

    const restored = readAssistantSession(savedAt + ASSISTANT_CHECKPOINT_TTL_MS);
    expect(restored.turns[0].actions).toEqual([]);
    expect(restored.turns[0].checkpoint).toMatchObject({
      status: "expired",
      expiredReason: "timeout",
      targets: [{ action: "open_video", label: "已删除的课" }],
    });
    expect(JSON.stringify(restored.turns[0].checkpoint)).not.toContain("deleted-video");
  });

  it("does not call an already-applied theme switch an expired action", () => {
    writeAssistantSession({
      turns: [
        {
          id: "t1",
          question: "切到夜间",
          answer: "已切换",
          actions: [{ kind: "set_theme", pref: "dark" }],
          tools: ["set_theme"],
          canceled: false,
          actionResults: [],
        },
      ],
      history: [
        { role: "user", content: "切到夜间" },
        { role: "assistant", content: "已切换" },
      ],
      draft: "",
    });

    const restored = readAssistantSession();
    expect(restored.turns[0].actionsExpired).toBeUndefined();
    expect(restored.history).toEqual([
      { role: "user", content: "切到夜间" },
      { role: "assistant", content: "已切换" },
    ]);
  });

  it("keeps legacy actionsExpired records visible without inventing a checkpoint", () => {
    localStorage.setItem(
      assistantSessionStorageKey,
      JSON.stringify({
        turns: [
          {
            id: "legacy",
            question: "旧问题",
            answer: "旧回答",
            actions: [{ kind: "propose_delete", video_id: "must-not-revive" }],
            actionsExpired: true,
            tools: [],
            canceled: false,
            actionResults: [],
          },
        ],
        history: [],
        draft: "",
      }),
    );

    const turn = readAssistantSession(5_000).turns[0];
    expect(turn.actions).toEqual([]);
    expect(turn.checkpoint).toBeUndefined();
    expect(getAssistantInteractionState(turn)).toEqual({ status: "expired" });
  });

  it("remembers that a turn ran out of steps instead of restoring it as a finished answer", () => {
    // 重启之后这一轮看起来和答完了一模一样：一句过场话，或者干脆是空的。
    // 不把标记存下来，那条「没能得出结论」的说明就跟着消失了。
    writeAssistantSession({
      turns: [
        {
          id: "t1",
          question: "整理成提纲",
          answer: "我先查一下这门课有哪些视频",
          actions: [],
          tools: ["list_videos"],
          canceled: false,
          hitTurnLimit: true,
          actionResults: [],
        },
      ],
      history: [],
      draft: "",
    });

    expect(readAssistantSession().turns[0].hitTurnLimit).toBe(true);
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

  it("caps restored answer and reasoning text so one model response cannot fill localStorage", () => {
    writeAssistantSession({
      turns: [
        {
          id: "large",
          question: "长回答",
          answer: "答".repeat(MAX_ASSISTANT_ANSWER_CHARS + 500),
          reasoning: "想".repeat(MAX_ASSISTANT_REASONING_CHARS + 500),
          actions: [],
          tools: [],
          canceled: false,
          actionResults: [],
        },
      ],
      history: [],
      draft: "",
    });

    const restored = readAssistantSession().turns[0];
    expect(restored.answer).toHaveLength(MAX_ASSISTANT_ANSWER_CHARS);
    expect(restored.reasoning).toHaveLength(MAX_ASSISTANT_REASONING_CHARS);
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
