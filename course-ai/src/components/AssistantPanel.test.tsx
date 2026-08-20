import "@testing-library/jest-dom/vitest";
import i18n from "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantPanel } from "./AssistantPanel";
import { useAssistantUi } from "@/stores/assistant";
import { useTheme } from "@/stores/theme";
import { useInlineAsk } from "@/stores/inlineAsk";
import {
  assistantSessionStorageKey,
  readAssistantSession,
  writeAssistantSession,
} from "@/lib/assistantSession";
import {
  assistantConversationsStorageKey,
  assistantConversationStorageKey,
  createAssistantConversation,
  MAX_ASSISTANT_CONVERSATIONS,
  readAssistantConversation,
  readAssistantConversations,
  readRecentAssistantQuestions,
  upsertAssistantConversation,
  writeRecentAssistantQuestions,
} from "@/lib/assistantConversations";
import type { AssistantSession } from "@/lib/assistantSession";
import type {
  AssistantAction,
  AssistantContext,
  AssistantEvent,
  AssistantReply,
} from "@/lib/types";

const { confirmMock, mockIpc, platformMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  mockIpc: {
    assistant: { ask: vi.fn(), cancel: vi.fn() },
    videos: { list: vi.fn(), updateTitle: vi.fn(), delete: vi.fn() },
    courses: { list: vi.fn(), create: vi.fn(), rename: vi.fn() },
    settings: { set: vi.fn(), get: vi.fn() },
    tools: {
      importBilibili: vi.fn(),
      probeBilibili: vi.fn(),
      hasBilibiliCookies: vi.fn(),
    },
    pipeline: { process: vi.fn() },
  },
  platformMock: { mobile: false, tablet: false },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: confirmMock }));
vi.mock("@/lib/platform", () => ({
  isMobile: () => platformMock.mobile,
  isAndroid: () => platformMock.mobile,
  isIOS: () => false,
  isTablet: () => platformMock.tablet,
  isDesktop: () => !platformMock.mobile,
}));

function reply(over: Partial<AssistantReply> = {}): AssistantReply {
  return {
    answer: "好了",
    canceled: false,
    hit_turn_limit: false,
    actions: [],
    turns: 1,
    tools_used: [],
    history: [],
    ...over,
  };
}

function renderPanel(
  onNavigate = vi.fn(),
  layout: {
    compact?: boolean;
    bottomNavigationVisible?: boolean;
    launcherVisible?: boolean;
    context?: AssistantContext;
    onActionApplied?: (action: AssistantAction) => void;
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AssistantPanel
        context={layout.context ?? { course_id: "c1", video_id: "v1" }}
        onNavigate={onNavigate}
        onActionApplied={layout.onActionApplied}
        compact={layout.compact}
        bottomNavigationVisible={layout.bottomNavigationVisible}
        launcherVisible={layout.launcherVisible}
      />
    </QueryClientProvider>,
  );
  return onNavigate;
}

async function ask(text: string) {
  fireEvent.change(screen.getByLabelText("对助手说"), { target: { value: text } });
  fireEvent.click(screen.getByLabelText("发送"));
}

function storedConversation(question: string): AssistantSession {
  const answer = `回答：${question}`;
  return {
    turns: [
      {
        id: `turn-${question}`,
        question,
        answer,
        actions: [],
        tools: [],
        canceled: false,
        actionResults: [],
      },
    ],
    history: [
      { role: "user", content: question },
      { role: "assistant", content: answer },
    ],
    draft: "",
  };
}

describe("AssistantPanel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    vi.clearAllMocks();
    localStorage.clear();
    platformMock.mobile = false;
    platformMock.tablet = false;
    useAssistantUi.setState({ open: true, side: "right", width: 380 });
    useInlineAsk.setState({ pending: null });
    mockIpc.assistant.ask.mockResolvedValue(reply());
    mockIpc.assistant.cancel.mockResolvedValue(undefined);
    confirmMock.mockResolvedValue(true);
  });

  it("收起时在界面边缘留一颗可点开的球", () => {
    useAssistantUi.setState({ open: false });
    renderPanel();
    expect(screen.getByLabelText("对助手说")).not.toBeVisible();
    const dockStrip = screen.getByLabelText("打开助手");
    expect(dockStrip).toHaveAttribute("data-dock-side", "right");
    // 圆球：贴边但留一点空隙，不再是糊在边上的窄条。
    expect(dockStrip).toHaveClass("right-3", "h-14", "w-14", "rounded-full");
    expect(dockStrip).toHaveClass("focus-visible:ring-[var(--focus-ring)]");
    expect(dockStrip.querySelector("svg")).toHaveClass("text-[var(--accent-text)]");
    fireEvent.click(dockStrip);
    expect(screen.getByLabelText("对助手说")).toBeVisible();
  });

  it("拖动球只是把球挪个地方，不会顺手把面板拽出来", () => {
    // 真实反馈：一拖动面板就打开了。挪位置和打开面板本是两件事，原先却揉在同一个手势里
    // ——向内拖过 16px 就展开——而任何一次拖动都会顺手越过这个门槛。
    useAssistantUi.setState({ open: false, side: "left" });
    renderPanel();
    const ball = screen.getByRole("button", { name: "打开助手" });

    fireEvent.pointerDown(ball, {
      pointerId: 3,
      pointerType: "mouse",
      button: 0,
      clientX: 22,
      clientY: 680,
    });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 900, clientY: 300 });
    // 拖动中球跟着指针走，不是钉死在边上。
    expect(ball).toHaveStyle({ left: "890px", top: "308px" });
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 900, clientY: 300 });

    // 松手贴回最近的一边：横着跨过了半屏，就换边。
    expect(ball).toHaveClass("right-3");
    expect(ball).toHaveStyle({ top: "308px" });
    expect(useAssistantUi.getState()).toMatchObject({ open: false, side: "right" });
    expect(screen.getByLabelText("对助手说")).not.toBeVisible();
  });

  it("球沿边缘拖动只调整位置，不会被随后的 click 误打开", async () => {
    useAssistantUi.setState({ open: false, side: "left" });
    renderPanel();
    const dockStrip = screen.getByRole("button", { name: "打开助手" });

    fireEvent.pointerDown(dockStrip, {
      pointerId: 4,
      pointerType: "mouse",
      button: 0,
      clientX: 22,
      clientY: 680,
    });
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 22, clientY: 530 });
    fireEvent.pointerUp(window, { pointerId: 4, clientX: 22, clientY: 530 });
    // 真实浏览器里 pointerup 和 click 之间隔着一次事件循环。原来的写法把两者排在同一个
    // 同步块里，任何「靠定时器复位」的压制都会显得正确——而线上那一下确实会误打开。
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(dockStrip);

    // 球比原来的窄条矮 56px，能停到更靠下的位置，所以下界跟着降。
    expect(dockStrip).toHaveStyle({ top: "538px" });
    expect(screen.getByLabelText("对助手说")).not.toBeVisible();
    expect(useAssistantUi.getState().open).toBe(false);
  });

  it("拖动后即使没有收到 click，下一次真点击照样能打开", async () => {
    // 松手时指针可能已经不在球上，那一下 click 根本不会来。压制标志若留着不清，
    // 会把后面那次真正的点击一起吃掉——面板从此点不开。
    useAssistantUi.setState({ open: false, side: "left" });
    renderPanel();
    const ball = screen.getByRole("button", { name: "打开助手" });

    fireEvent.pointerDown(ball, {
      pointerId: 7,
      pointerType: "mouse",
      button: 0,
      clientX: 22,
      clientY: 680,
    });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 22, clientY: 540 });
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 22, clientY: 540 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 这次没有 click。用户重新按下再抬起，是一次干净的点击。
    fireEvent.pointerDown(ball, {
      pointerId: 8,
      pointerType: "mouse",
      button: 0,
      clientX: 22,
      clientY: 540,
    });
    fireEvent.pointerUp(window, { pointerId: 8, clientX: 22, clientY: 540 });
    fireEvent.click(ball);

    expect(useAssistantUi.getState().open).toBe(true);
  });

  it("删除空白对话里的示例注脚", () => {
    renderPanel();
    expect(screen.queryByText(/这门课哪讲了梯度下降/)).not.toBeInTheDocument();
    expect(screen.queryByText(/把这个视频改名叫第三讲/)).not.toBeInTheDocument();
  });

  it("文稿选区提问会打开全局助手并预填带来源的草稿", async () => {
    useAssistantUi.setState({ open: false });
    renderPanel();

    act(() => useInlineAsk.getState().askAbout("贝叶斯定理", 5_000));

    await waitFor(() => expect(useAssistantUi.getState().open).toBe(true));
    expect(screen.getByLabelText("对助手说")).toHaveValue(
      "请解释这段文稿（00:05）：\n\n贝叶斯定理",
    );
    expect(useInlineAsk.getState().pending).toBeNull();
    expect(mockIpc.assistant.ask).not.toHaveBeenCalled();
  });

  it("空白对话给出可直接执行的当前视频建议", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "查找例题" }));
    await waitFor(() =>
      expect(mockIpc.assistant.ask).toHaveBeenCalledWith(
        "查找当前视频里讲例题的位置",
        { course_id: "c1", video_id: "v1" },
        [],
        expect.any(String),
        expect.any(Function),
      ),
    );
  });

  it("思考内容边生成边显示，且比答案先出现", async () => {
    // 助手此前是一次性的：转圈 → 什么都没有 → 答案和工具标签一起蹦出来。
    // 现在思考、正文、工具标签都实时到达。
    let emit!: (event: AssistantEvent) => void;
    mockIpc.assistant.ask.mockImplementationOnce(
      (_q, _c, _h, _id, onEvent: (event: AssistantEvent) => void) => {
        emit = onEvent;
        return new Promise<AssistantReply>(() => {}); // 一直不 resolve：停在流式中途
      },
    );
    renderPanel();
    await ask("讲讲这节课");

    await waitFor(() => expect(mockIpc.assistant.ask).toHaveBeenCalled());
    expect(screen.getByRole("log")).toHaveAttribute("aria-live", "off");
    expect(screen.getByRole("log")).toHaveAttribute("aria-relevant", "additions");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("正在思考");
    act(() => {
      emit({ type: "turn", turn: 1 });
      emit({ type: "reasoning", delta: "先看看" });
      emit({ type: "reasoning", delta: "字幕里有什么" });
    });

    // 思考比正文先到，所以不能藏在「有答案才渲染」的分支里。
    expect(await screen.findByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("先看看字幕里有什么")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在思考…");

    act(() => {
      emit({ type: "tool", call_id: "call-search-1", name: "search_content" });
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("正在搜索课程内容"),
    );

    act(() => {
      emit({
        type: "tool_finished",
        call_id: "call-search-1",
        name: "search_content",
        canceled: false,
      });
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("正在整理结果"));
    // 工具标签实时出现，不必等整轮跑完。
    expect(screen.getByTestId("tool-chips")).toHaveTextContent("搜索课程内容");

    act(() => {
      emit({ type: "token", delta: "这节课" });
      emit({ type: "token", delta: "讲的是导数。" });
    });
    expect(await screen.findByText("这节课讲的是导数。")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("正在作答"));
  });

  it("保留每次工具调用的真实终态，失败后立即结束也不会消失", async () => {
    let emit!: (event: AssistantEvent) => void;
    let finish!: (value: AssistantReply) => void;
    mockIpc.assistant.ask.mockImplementationOnce(
      (_q, _c, _h, _id, onEvent: (event: AssistantEvent) => void) => {
        emit = onEvent;
        return new Promise<AssistantReply>((resolve) => {
          finish = resolve;
        });
      },
    );
    renderPanel();
    await ask("换两种方式查找");
    await waitFor(() => expect(mockIpc.assistant.ask).toHaveBeenCalled());

    act(() => {
      emit({ type: "tool", call_id: "first", name: "search_content" });
      emit({
        type: "tool_finished",
        call_id: "first",
        name: "search_content",
        status: "failed",
        canceled: false,
      });
    });
    expect(
      await screen.findByRole("listitem", { name: "搜索课程内容，失败" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "搜索课程内容未能完成，正在调整方案",
    );

    act(() => {
      emit({ type: "tool", call_id: "second", name: "search_content" });
      emit({
        type: "tool_finished",
        call_id: "second",
        name: "search_content",
        status: "completed",
        canceled: false,
      });
      finish(
        reply({
          answer: "第二种方式查到了",
          tools_used: ["search_content", "search_content"],
        }),
      );
    });

    expect(await screen.findByText("第二种方式查到了")).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "搜索课程内容，失败" })).toBeInTheDocument();
    expect(
      screen.getByRole("listitem", { name: "搜索课程内容，已完成" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("×2")).not.toBeInTheDocument();
  });

  it("工具失败后立即结束时，最终读屏通知仍说明失败", async () => {
    let emit!: (event: AssistantEvent) => void;
    let finish!: (value: AssistantReply) => void;
    mockIpc.assistant.ask.mockImplementationOnce(
      (_q, _c, _h, _id, onEvent: (event: AssistantEvent) => void) => {
        emit = onEvent;
        return new Promise<AssistantReply>((resolve) => {
          finish = resolve;
        });
      },
    );
    renderPanel();
    await ask("立刻结束");
    await waitFor(() => expect(mockIpc.assistant.ask).toHaveBeenCalled());

    act(() => {
      emit({ type: "tool", call_id: "fast", name: "search_content" });
      emit({
        type: "tool_finished",
        call_id: "fast",
        name: "search_content",
        status: "failed",
        canceled: false,
      });
      finish(reply({ answer: "仍然给出结论", tools_used: ["search_content"] }));
    });

    expect(await screen.findByText("仍然给出结论")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("回答已完成；搜索课程内容失败");
    expect(screen.getByRole("listitem", { name: "搜索课程内容，失败" })).toBeInTheDocument();
  });

  it("兼容缺状态与乱序事件，不把旧协议冒充成功也不重复工具", async () => {
    let emit!: (event: AssistantEvent) => void;
    let finish!: (value: AssistantReply) => void;
    mockIpc.assistant.ask.mockImplementationOnce(
      (_q, _c, _h, _id, onEvent: (event: AssistantEvent) => void) => {
        emit = onEvent;
        return new Promise<AssistantReply>((resolve) => {
          finish = resolve;
        });
      },
    );
    renderPanel();
    await ask("查旧接口");
    await waitFor(() => expect(mockIpc.assistant.ask).toHaveBeenCalled());

    act(() => {
      // finish 先到也要建记录；后续重复 start/finish 不能降级或重复追加。
      emit({
        type: "tool_finished",
        call_id: "legacy",
        name: "list_videos",
        canceled: false,
      });
      emit({ type: "tool", call_id: "legacy", name: "list_videos" });
      emit({
        type: "tool_finished",
        call_id: "legacy",
        name: "list_videos",
        status: "failed",
        canceled: false,
      });
      emit({ type: "turn", turn: 2 });
      emit({
        type: "tool_finished",
        call_id: "future-status",
        name: "list_courses",
        status: "future-status",
        canceled: false,
      } as unknown as AssistantEvent);
      finish(reply({ answer: "已处理", tools_used: ["list_videos", "list_courses"] }));
    });

    expect(await screen.findByText("已处理")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem", { name: "查看视频列表，失败" })).toHaveLength(1);
    expect(screen.getByRole("listitem", { name: "查看课程，已结束" })).toBeInTheDocument();
    expect(screen.queryByRole("listitem", { name: "查看视频列表，已完成" })).toBeNull();
  });

  it("最终通知采用最后到达的工具失败，即使它先以未知状态结束", async () => {
    let emit!: (event: AssistantEvent) => void;
    let finish!: (value: AssistantReply) => void;
    mockIpc.assistant.ask.mockImplementationOnce(
      (_q, _c, _h, _id, onEvent: (event: AssistantEvent) => void) => {
        emit = onEvent;
        return new Promise<AssistantReply>((resolve) => {
          finish = resolve;
        });
      },
    );
    renderPanel();
    await ask("处理乱序结果");
    await waitFor(() => expect(mockIpc.assistant.ask).toHaveBeenCalled());

    act(() => {
      emit({
        type: "tool_finished",
        call_id: "first",
        name: "search_content",
        canceled: false,
      });
      emit({
        type: "tool_finished",
        call_id: "second",
        name: "list_videos",
        status: "failed",
        canceled: false,
      });
      emit({
        type: "tool_finished",
        call_id: "first",
        name: "search_content",
        status: "failed",
        canceled: false,
      });
      finish(
        reply({
          answer: "已结束",
          tools_used: ["search_content", "list_videos"],
        }),
      );
    });

    expect(await screen.findByText("已结束")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("回答已完成；搜索课程内容失败");
  });

  it("只有最终 tools_used 的兼容响应显示为中性终态", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ answer: "兼容回答", tools_used: ["get_study_progress"] }),
    );
    renderPanel();
    await ask("看进度");

    expect(
      await screen.findByRole("listitem", { name: "读取学习进度，已结束" }),
    ).toBeInTheDocument();
  });

  it("done 会先冲刷尚未到下一帧的思考片段", async () => {
    let emit!: (event: AssistantEvent) => void;
    let finish!: (value: AssistantReply) => void;
    mockIpc.assistant.ask.mockImplementationOnce(
      (_q, _c, _h, _id, onEvent: (event: AssistantEvent) => void) => {
        emit = onEvent;
        return new Promise<AssistantReply>((resolve) => {
          finish = resolve;
        });
      },
    );
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 9);
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    renderPanel();
    await ask("快速结束");
    await waitFor(() => expect(mockIpc.assistant.ask).toHaveBeenCalled());
    act(() => {
      emit({ type: "reasoning", delta: "最后一段思考" });
      finish(reply({ answer: "最终答复" }));
    });

    expect(await screen.findByText("最后一段思考")).toBeInTheDocument();
    expect(screen.getByText("最终答复")).toBeInTheDocument();
    expect(cancelFrame).toHaveBeenCalledWith(9);

    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it("pending token 不会反复序列化同一份已完成会话", async () => {
    let emit!: (event: AssistantEvent) => void;
    let finish!: (value: AssistantReply) => void;
    mockIpc.assistant.ask.mockImplementationOnce(
      (_q, _c, _h, _id, onEvent: (event: AssistantEvent) => void) => {
        emit = onEvent;
        return new Promise<AssistantReply>((resolve) => {
          finish = resolve;
        });
      },
    );
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    renderPanel();
    await ask("高频输出");
    await waitFor(() => expect(mockIpc.assistant.ask).toHaveBeenCalled());
    setItem.mockClear();

    act(() => {
      emit({ type: "turn", turn: 1 });
      for (const delta of ["高", "频", "流", "式", "回", "答"]) {
        emit({ type: "token", delta });
      }
    });
    expect(await screen.findByText("高频流式回答")).toBeInTheDocument();
    expect(setItem).not.toHaveBeenCalled();

    act(() => finish(reply({ answer: "高频流式回答" })));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("回答已完成"));
    await waitFor(() =>
      expect(
        setItem.mock.calls.filter(([key]) => key === assistantSessionStorageKey),
      ).toHaveLength(1),
    );

    setItem.mockRestore();
  });

  it("新一轮开始会清空上一轮的正文，不会拼成一句谁也没说过的话", async () => {
    // 循环里 answer 是逐轮替换的：第一轮「我先查一下」，第二轮「查完了」。
    // 接着往下拼会得到「我先查一下查完了」。
    let emit!: (event: AssistantEvent) => void;
    mockIpc.assistant.ask.mockImplementationOnce(
      (_q, _c, _h, _id, onEvent: (event: AssistantEvent) => void) => {
        emit = onEvent;
        return new Promise<AssistantReply>(() => {});
      },
    );
    renderPanel();
    await ask("查一下");
    await waitFor(() => expect(mockIpc.assistant.ask).toHaveBeenCalled());

    act(() => {
      emit({ type: "turn", turn: 1 });
      emit({ type: "token", delta: "我先查一下" });
    });
    expect(await screen.findByText("我先查一下")).toBeInTheDocument();

    act(() => {
      emit({ type: "turn", turn: 2 });
      emit({ type: "token", delta: "查完了" });
    });
    expect(await screen.findByText("查完了")).toBeInTheDocument();
    expect(screen.queryByText("我先查一下查完了")).not.toBeInTheDocument();
    expect(screen.queryByText("我先查一下")).not.toBeInTheDocument();
  });

  it("可以从标题栏拖动桌面面板", () => {
    renderPanel();
    const panel = screen.getByRole("complementary", { name: "助手" });
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      left: 648,
      top: 16,
      width: 360,
      height: 600,
      right: 1008,
      bottom: 616,
      x: 648,
      y: 16,
      toJSON: () => ({}),
    });

    const handle = screen.getByRole("button", { name: "拖动助手面板" });
    fireEvent.pointerDown(handle, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 700,
      clientY: 40,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 500, clientY: 140 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 500, clientY: 140 });

    expect(panel).toHaveStyle({ left: "448px", top: "116px" });
    expect(useAssistantUi.getState().open).toBe(true);
  });

  it("拖到左侧边缘后自动吸附成球", () => {
    renderPanel();
    const panel = screen.getByRole("complementary", { name: "助手" });
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      left: 648,
      top: 16,
      width: 360,
      height: 600,
      right: 1008,
      bottom: 616,
      x: 648,
      y: 16,
      toJSON: () => ({}),
    });

    const handle = screen.getByRole("button", { name: "拖动助手面板" });
    fireEvent.pointerDown(handle, {
      pointerId: 2,
      pointerType: "mouse",
      button: 0,
      clientX: 700,
      clientY: 40,
    });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 40, clientY: 180 });
    expect(panel).toHaveAttribute("data-snap-side", "left");
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 40, clientY: 180 });

    const dockStrip = screen.getByRole("button", { name: "打开助手" });
    expect(dockStrip).toHaveAttribute("data-dock-side", "left");
    expect(dockStrip).toHaveClass("left-3", "h-14", "w-14", "rounded-full");
    // 收起时按中心对齐，球矮了 56px，顶边就下移一半（28px）。
    expect(dockStrip).toHaveStyle({ top: "424px" });
    expect(useAssistantUi.getState()).toMatchObject({ open: false, side: "left" });
  });

  it("键盘可以把面板吸附到左右边缘", () => {
    renderPanel();
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动助手面板" }), { key: "Home" });
    expect(screen.getByRole("button", { name: "打开助手" })).toHaveAttribute(
      "data-dock-side",
      "left",
    );
  });

  it("方向键把面板吸附成入口后会把焦点交给入口", async () => {
    renderPanel();
    const handle = screen.getByRole("button", { name: "拖动助手面板" });
    handle.focus();

    fireEvent.keyDown(handle, { key: "ArrowRight" });

    const launcher = screen.getByRole("button", { name: "打开助手" });
    await waitFor(() => expect(launcher).toHaveFocus());
    expect(launcher).toHaveAttribute("data-dock-side", "right");
  });

  it("回答按 Markdown 渲染，而不是把 ** 和 - 原样铺出来", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ answer: "重点有两条：\n\n- **梯度下降**很关键\n- 学习率要调" }),
    );
    renderPanel();
    await ask("讲了什么");
    // 星号被吃掉、变成加粗元素；列表项也不再带前导的 "- "。
    const strong = await screen.findByText("梯度下降");
    expect(strong.tagName).toBe("STRONG");
    expect(screen.queryByText(/\*\*梯度下降\*\*/)).not.toBeInTheDocument();
    expect(screen.getByText(/学习率要调/).textContent).not.toMatch(/^- /);
  });

  it("主题当场生效，不用再点一次确认", async () => {
    useTheme.setState({ pref: "light" });
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ actions: [{ kind: "set_theme", pref: "dark" }] }),
    );
    renderPanel();
    await ask("设置主题为黑夜模式");
    // 无破坏性、一眼可见、再说一句就能改回来——不该为它加一次点击。
    await waitFor(() => expect(useTheme.getState().pref).toBe("dark"));
    expect(await screen.findByText(/已切换到夜间主题/)).toBeInTheDocument();
  });

  it("把界面状态一起发过去，助手才听得懂「这个视频」", async () => {
    renderPanel();
    await ask("这讲了什么");
    await waitFor(() =>
      expect(mockIpc.assistant.ask).toHaveBeenCalledWith(
        "这讲了什么",
        { course_id: "c1", video_id: "v1" },
        [],
        expect.any(String),
        expect.any(Function),
      ),
    );
  });

  it("续聊时把上一轮的完整往返传回去", async () => {
    const history = [{ role: "user", content: "第一句" }];
    mockIpc.assistant.ask.mockResolvedValueOnce(reply({ history }));
    renderPanel();
    await ask("第一句");
    await screen.findByText("好了");
    await ask("那第二个呢");
    // 工具往返也在 history 里；不原样带回去，模型就看不到自己刚查到了什么。
    await waitFor(() =>
      expect(mockIpc.assistant.ask).toHaveBeenLastCalledWith(
        "那第二个呢",
        expect.anything(),
        history,
        expect.any(String),
        expect.any(Function),
      ),
    );
  });

  it("出错时把问题放回输入框，不用重打一遍", async () => {
    mockIpc.assistant.ask.mockRejectedValueOnce(new Error("端点挂了"));
    renderPanel();
    await ask("帮我查查");
    await screen.findByRole("alert");
    expect(screen.getByLabelText("对助手说")).toHaveValue("帮我查查");
  });

  it("把后端错误翻成人能处理的提示", async () => {
    mockIpc.assistant.ask.mockRejectedValueOnce(new Error("HTTP 401 Unauthorized"));
    renderPanel();
    await ask("帮我查查");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("API Key");
    expect(alert).not.toHaveTextContent("HTTP 401");
  });

  it("等待 Agent 工具链时给屏幕阅读器明确状态", async () => {
    let finish!: (value: AssistantReply) => void;
    mockIpc.assistant.ask.mockReturnValueOnce(
      new Promise<AssistantReply>((resolve) => {
        finish = resolve;
      }),
    );
    renderPanel();
    await ask("找一下例题");

    expect(screen.getByTestId("user-bubble")).toHaveTextContent("找一下例题");
    expect(await screen.findByRole("status")).toHaveTextContent("正在思考");
    expect(screen.getByLabelText("停止生成")).toBeEnabled();
    expect(screen.getByLabelText("停止生成")).toHaveClass("ca-touch-44");

    finish(reply());
    await screen.findByText("好了");
    expect(screen.getByRole("status")).toHaveTextContent("回答已完成");
  });

  it("用户翻看旧消息时，新回复不会强行抢回滚动位置", async () => {
    let finish!: (value: AssistantReply) => void;
    mockIpc.assistant.ask.mockReturnValueOnce(
      new Promise<AssistantReply>((resolve) => {
        finish = resolve;
      }),
    );
    renderPanel();
    await ask("找一下例题");

    const log = screen.getByRole("log");
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(log, "scrollTop", { configurable: true, writable: true, value: 300 });
    fireEvent.scroll(log);

    finish(reply());
    await screen.findByText("好了");
    expect(log.scrollTop).toBe(300);
  });

  it("停止会取消当前 request_id，并明确标出这一轮没有执行完", async () => {
    let finish!: (value: AssistantReply) => void;
    mockIpc.assistant.ask.mockReturnValueOnce(
      new Promise<AssistantReply>((resolve) => {
        finish = resolve;
      }),
    );
    renderPanel();
    await ask("查完所有课程");

    const requestId = mockIpc.assistant.ask.mock.calls[0][3];
    const emit = mockIpc.assistant.ask.mock.calls[0][4] as (event: AssistantEvent) => void;
    act(() => emit({ type: "started" }));
    fireEvent.click(await screen.findByLabelText("停止生成"));
    await waitFor(() => expect(mockIpc.assistant.cancel).toHaveBeenCalledWith(requestId));
    expect(screen.getByRole("status")).toHaveTextContent("正在停止");

    finish(reply({ answer: "", canceled: true }));
    expect(await screen.findByText("已停止，未继续执行")).toBeInTheDocument();
    expect(screen.getByLabelText("发送")).toBeDisabled();
  });

  it("后端登记请求之前也会把停止意图交给 IPC 补发", async () => {
    let finish!: (value: AssistantReply) => void;
    mockIpc.assistant.ask.mockReturnValueOnce(
      new Promise<AssistantReply>((resolve) => {
        finish = resolve;
      }),
    );
    renderPanel();
    await ask("立即停止也不能漏掉");

    const stopButton = await screen.findByLabelText("停止生成");
    expect(stopButton).toBeEnabled();
    fireEvent.click(stopButton);
    await waitFor(() => expect(mockIpc.assistant.cancel).toHaveBeenCalledTimes(1));
    const emit = mockIpc.assistant.ask.mock.calls[0][4] as (event: AssistantEvent) => void;
    act(() => emit({ type: "started" }));
    expect(mockIpc.assistant.cancel).toHaveBeenCalledTimes(1);

    finish(reply({ answer: "", canceled: true }));
    expect(await screen.findByText("已停止，未继续执行")).toBeInTheDocument();
  });

  it("started 之前卸载也会立即把取消意图交给 IPC", async () => {
    let finish!: (value: AssistantReply) => void;
    mockIpc.assistant.ask.mockReturnValueOnce(
      new Promise<AssistantReply>((resolve) => {
        finish = resolve;
      }),
    );
    renderPanel();
    await ask("关闭界面也不能让请求继续跑");

    const requestId = mockIpc.assistant.ask.mock.calls[0][3];
    cleanup();
    await waitFor(() => expect(mockIpc.assistant.cancel).toHaveBeenCalledWith(requestId));
    finish(reply({ canceled: true }));
  });

  it("同一帧内的大量流式片段只安排一次界面刷新", async () => {
    let finish!: (value: AssistantReply) => void;
    mockIpc.assistant.ask.mockReturnValueOnce(
      new Promise<AssistantReply>((resolve) => {
        finish = resolve;
      }),
    );
    renderPanel();
    await ask("输出很多片段");
    const emit = mockIpc.assistant.ask.mock.calls[0][4] as (event: AssistantEvent) => void;
    let queued: FrameRequestCallback | null = null;
    const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queued = callback;
      return 42;
    });

    act(() => {
      emit({ type: "started" });
      for (let index = 0; index < 100; index += 1) {
        emit({ type: "token", delta: "字" });
      }
    });
    expect(frame).toHaveBeenCalledTimes(1);
    act(() => queued?.(0));
    expect(screen.getByText("字".repeat(100))).toBeInTheDocument();

    finish(reply({ answer: "字".repeat(100) }));
    await screen.findByText("字".repeat(100));
    frame.mockRestore();
  });

  it("停止后的半成品动作不会继续改界面或等待确认", async () => {
    useTheme.setState({ pref: "light" });
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        answer: "",
        canceled: true,
        actions: [
          { kind: "set_theme", pref: "dark" },
          { kind: "propose_delete", video_id: "v1", title: "第一讲" },
        ],
      }),
    );
    renderPanel();
    await ask("删掉它并切换主题");

    expect(await screen.findByText("已停止，未继续执行")).toBeInTheDocument();
    expect(useTheme.getState().pref).toBe("light");
    expect(screen.queryByText("删除视频")).not.toBeInTheDocument();
    expect(mockIpc.videos.delete).not.toHaveBeenCalled();
  });

  it("本地点了停止后，即使旧后端抢先返回完成也不执行动作或续接该轮", async () => {
    useTheme.setState({ pref: "light" });
    const previousHistory = [
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "第一轮回答" },
    ];
    let finish!: (value: AssistantReply) => void;
    mockIpc.assistant.ask
      .mockResolvedValueOnce(reply({ answer: "第一轮回答", history: previousHistory }))
      .mockReturnValueOnce(
        new Promise<AssistantReply>((resolve) => {
          finish = resolve;
        }),
      );
    renderPanel();
    await ask("第一轮");
    await screen.findByText("第一轮回答");
    await ask("第二轮");

    const emit = mockIpc.assistant.ask.mock.calls[1][4] as (event: AssistantEvent) => void;
    act(() => emit({ type: "started" }));
    fireEvent.click(await screen.findByLabelText("停止生成"));
    finish(
      reply({
        answer: "服务端其实已经答完",
        canceled: false,
        actions: [
          { kind: "set_theme", pref: "dark" },
          { kind: "propose_delete", video_id: "v1", title: "第一讲" },
        ],
        history: [
          ...previousHistory,
          { role: "user", content: "第二轮" },
          { role: "assistant", content: "服务端其实已经答完" },
        ],
      }),
    );

    expect(await screen.findByText("已停止，未继续执行")).toBeInTheDocument();
    expect(screen.queryByText("服务端其实已经答完")).not.toBeInTheDocument();
    expect(useTheme.getState().pref).toBe("light");
    expect(screen.queryByRole("button", { name: "确认删除" })).not.toBeInTheDocument();

    await ask("第三轮");
    await waitFor(() =>
      expect(mockIpc.assistant.ask).toHaveBeenLastCalledWith(
        "第三轮",
        expect.anything(),
        previousHistory,
        expect.any(String),
        expect.any(Function),
      ),
    );
  });

  it("新对话会清掉旧消息和后端历史", async () => {
    const oldHistory = [{ role: "user", content: "旧问题" }];
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ answer: "旧回答", history: oldHistory }),
    );
    renderPanel();
    await ask("旧问题");
    await screen.findByText("旧回答");

    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    expect(screen.queryByText("旧问题")).not.toBeInTheDocument();
    expect(screen.queryByText("旧回答")).not.toBeInTheDocument();

    await ask("重新开始");
    await waitFor(() =>
      expect(mockIpc.assistant.ask).toHaveBeenLastCalledWith(
        "重新开始",
        expect.anything(),
        [],
        expect.any(String),
        expect.any(Function),
      ),
    );
  });

  it("上下方向键浏览发送历史，并在越过最新一条后恢复未发送草稿", async () => {
    mockIpc.assistant.ask
      .mockResolvedValueOnce(reply({ answer: "第一答" }))
      .mockResolvedValueOnce(reply({ answer: "第二答" }));
    renderPanel();

    await ask("第一条问题");
    await screen.findByText("第一答");
    await ask("第二条问题");
    await screen.findByText("第二答");

    const input = screen.getByLabelText("对助手说") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "还没发送的草稿" } });
    input.setSelectionRange(0, 0);

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveValue("第二条问题");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveValue("第一条问题");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveValue("第二条问题");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveValue("还没发送的草稿");
  });

  it("多行中部、文本选择和输入法组词时保留原生方向键，只有光标在开头才回看历史", () => {
    writeRecentAssistantQuestions(["上一条已发送问题"]);
    renderPanel();

    const input = screen.getByLabelText("对助手说") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "第一行\n第二行" } });
    input.setSelectionRange(4, 4);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveValue("第一行\n第二行");

    input.setSelectionRange(0, 3);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveValue("第一行\n第二行");

    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: "ArrowUp", isComposing: true });
    expect(input).toHaveValue("第一行\n第二行");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveValue("上一条已发送问题");
  });

  it("浏览发送历史不会把原来的未发送草稿覆盖到会话快照", () => {
    writeRecentAssistantQuestions(["上一条已发送问题"]);
    renderPanel();

    const input = screen.getByLabelText("对助手说") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "需要保留的草稿" } });
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveValue("上一条已发送问题");

    cleanup();
    useAssistantUi.setState({ open: true, side: "right" });
    renderPanel();
    expect(screen.getByLabelText("对助手说")).toHaveValue("需要保留的草稿");
  });

  it("召回问题后把光标移到文本中间会退出历史浏览", () => {
    writeRecentAssistantQuestions(["更早的问题", "一条较长的历史问题"]);
    renderPanel();

    const input = screen.getByLabelText("对助手说") as HTMLTextAreaElement;
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveValue("一条较长的历史问题");

    input.setSelectionRange(3, 3);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveValue("一条较长的历史问题");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveValue("一条较长的历史问题");
  });

  it("新建会话后可从历史列表切回，并分别恢复两边的回答和草稿", async () => {
    mockIpc.assistant.ask
      .mockResolvedValueOnce(reply({ answer: "第一会话回答" }))
      .mockResolvedValueOnce(reply({ answer: "第二会话回答" }));
    renderPanel(vi.fn(), { compact: true });

    await ask("第一会话问题");
    await screen.findByText("第一会话回答");
    fireEvent.change(screen.getByLabelText("对助手说"), {
      target: { value: "第一会话草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));

    await ask("第二会话问题");
    await screen.findByText("第二会话回答");
    fireEvent.change(screen.getByLabelText("对助手说"), {
      target: { value: "第二会话草稿" },
    });

    fireEvent.click(screen.getByRole("button", { name: "会话历史" }));
    const firstConversation = screen.getByRole("button", { name: /^第一会话问题/ });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^第二会话问题/ })).toHaveFocus(),
    );
    expect(firstConversation).toHaveClass("ca-touch-44", "min-h-[52px]");
    expect(screen.queryByLabelText("对助手说")).not.toBeInTheDocument();
    fireEvent.click(firstConversation);

    expect(screen.getByText("第一会话回答")).toBeInTheDocument();
    expect(screen.queryByText("第二会话回答")).not.toBeInTheDocument();
    expect(screen.getByLabelText("对助手说")).toHaveValue("第一会话草稿");

    fireEvent.click(screen.getByRole("button", { name: "会话历史" }));
    fireEvent.click(screen.getByRole("button", { name: /^第二会话问题/ }));

    expect(screen.getByText("第二会话回答")).toBeInTheDocument();
    expect(screen.queryByText("第一会话回答")).not.toBeInTheDocument();
    expect(screen.getByLabelText("对助手说")).toHaveValue("第二会话草稿");

    const historyButton = screen.getByRole("button", { name: "会话历史" });
    fireEvent.click(historyButton);
    expect(historyButton).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(historyButton).toHaveFocus());
    expect(historyButton).toHaveAttribute("aria-expanded", "false");
  });

  it("历史改名支持取消与保存，并把焦点归还到对应会话", async () => {
    const initial = readAssistantConversations(1);
    const firstId = initial.activeId as string;
    upsertAssistantConversation({ id: firstId, session: storedConversation("待整理会话") }, 2);
    createAssistantConversation({
      id: "conversation-current",
      session: storedConversation("当前会话"),
      now: 3,
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "会话历史" }));
    const rename = screen.getByRole("button", { name: "重命名会话「待整理会话」" });
    fireEvent.click(rename);
    const titleInput = screen.getByRole("textbox", { name: "会话标题" });
    fireEvent.change(titleInput, { target: { value: "课程复盘" } });
    fireEvent.keyDown(titleInput, { key: "Escape" });

    expect(screen.getByRole("heading", { name: "会话历史" })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "重命名会话「待整理会话」" }),
      ).toHaveFocus(),
    );

    fireEvent.click(screen.getByRole("button", { name: "重命名会话「待整理会话」" }));
    const editingInput = screen.getByRole("textbox", { name: "会话标题" });
    fireEvent.change(editingInput, { target: { value: "课程复盘" } });
    fireEvent.keyDown(editingInput, { key: "Enter" });

    const renamedConversation = screen.getByRole("button", { name: /^课程复盘/ });
    await waitFor(() => expect(renamedConversation).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent("会话已重命名为「课程复盘」");
    expect(readAssistantConversations().conversations.find(({ id }) => id === firstId)?.title).toBe(
      "课程复盘",
    );
  });

  it("删除历史会话先确认，取消后保留数据，确认后聚焦相邻会话", async () => {
    const initial = readAssistantConversations(1);
    const firstId = initial.activeId as string;
    upsertAssistantConversation({ id: firstId, session: storedConversation("待删除会话") }, 2);
    createAssistantConversation({
      id: "conversation-current",
      session: storedConversation("保留会话"),
      now: 3,
    });
    const snapshot = localStorage.getItem(assistantConversationStorageKey(firstId));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "会话历史" }));

    confirmMock.mockResolvedValueOnce(false);
    const deleteButton = screen.getByRole("button", { name: "删除会话「待删除会话」" });
    fireEvent.click(deleteButton);
    await waitFor(() => expect(deleteButton).toHaveFocus());
    expect(confirmMock).toHaveBeenCalledWith(
      "确定删除会话「待删除会话」吗？其中的问答和草稿将永久删除。",
      {
        title: "删除会话",
        kind: "warning",
        okLabel: "删除",
        cancelLabel: "取消",
      },
    );
    expect(localStorage.getItem(assistantConversationStorageKey(firstId))).toBe(snapshot);

    confirmMock.mockResolvedValueOnce(true);
    fireEvent.click(deleteButton);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "删除会话「待删除会话」" })).not.toBeInTheDocument(),
    );
    expect(localStorage.getItem(assistantConversationStorageKey(firstId))).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("会话「待删除会话」已删除");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^保留会话/ })).toHaveFocus(),
    );
  });

  it("会话索引写失败时保留重命名编辑和删除目标并原地报错", async () => {
    const initial = readAssistantConversations(1);
    const firstId = initial.activeId as string;
    upsertAssistantConversation({ id: firstId, session: storedConversation("不能丢的会话") }, 2);
    createAssistantConversation({
      id: "conversation-current",
      session: storedConversation("当前保留会话"),
      now: 3,
    });
    const before = localStorage.getItem(assistantConversationStorageKey(firstId));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "会话历史" }));

    const originalSetItem = Storage.prototype.setItem;
    const indexFailure = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === assistantConversationsStorageKey) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        return originalSetItem.call(this, key, value);
      });
    try {
      fireEvent.click(
        screen.getByRole("button", { name: "重命名会话「不能丢的会话」" }),
      );
      const input = screen.getByRole("textbox", { name: "会话标题" });
      fireEvent.change(input, { target: { value: "不会假成功" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(await screen.findByRole("alert")).toHaveTextContent("会话历史未能保存");
      expect(input).toHaveValue("不会假成功");
      expect(readAssistantConversations().conversations.find(({ id }) => id === firstId)?.title).toBe(
        "不能丢的会话",
      );

      fireEvent.keyDown(input, { key: "Escape" });
      const deleteButton = screen.getByRole("button", {
        name: "删除会话「不能丢的会话」",
      });
      fireEvent.click(deleteButton);

      expect(await screen.findByRole("alert")).toHaveTextContent("会话历史未能保存");
      expect(localStorage.getItem(assistantConversationStorageKey(firstId))).toBe(before);
      expect(screen.getByRole("button", { name: /^不能丢的会话/ })).toBeInTheDocument();
      await waitFor(() => expect(deleteButton).toHaveFocus());
    } finally {
      indexFailure.mockRestore();
    }
  });

  it("删除最后一个会话时原子切换到新的空会话", async () => {
    const initial = readAssistantConversations(1);
    const oldId = initial.activeId as string;
    upsertAssistantConversation({ id: oldId, session: storedConversation("唯一会话") }, 2);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "会话历史" }));
    fireEvent.click(screen.getByRole("button", { name: "删除会话「唯一会话」" }));

    await waitFor(() => expect(screen.getByLabelText("对助手说")).toHaveFocus());
    expect(screen.queryByText("回答：唯一会话")).not.toBeInTheDocument();
    const after = readAssistantConversations();
    expect(after.activeId).not.toBe(oldId);
    expect(after.conversations).toHaveLength(1);
    expect(localStorage.getItem(assistantConversationStorageKey(oldId))).toBeNull();
    expect(readAssistantConversation(after.activeId as string)?.session).toEqual({
      turns: [],
      history: [],
      draft: "",
    });
  });

  it("新建时优先复用已有空会话，不堆积同名空条目", () => {
    const initial = readAssistantConversations(1);
    const emptyId = initial.activeId as string;
    createAssistantConversation({
      id: "conversation-current",
      session: storedConversation("当前非空会话"),
      now: 2,
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "新对话" }));

    const after = readAssistantConversations();
    expect(after.conversations).toHaveLength(2);
    expect(after.activeId).toBe(emptyId);
    expect(screen.queryByText("回答：当前非空会话")).not.toBeInTheDocument();
    expect(screen.getByLabelText("对助手说")).toHaveValue("");
  });

  it("二十个非空会话时明确提示上限且不切换或删除历史", () => {
    const initial = readAssistantConversations(1);
    const firstId = initial.activeId as string;
    upsertAssistantConversation({ id: firstId, session: storedConversation("会话 0") }, 2);
    for (let index = 1; index < MAX_ASSISTANT_CONVERSATIONS; index += 1) {
      createAssistantConversation({
        id: `conversation-panel-${index}`,
        session: storedConversation(`会话 ${index}`),
        now: index + 2,
      });
    }
    const before = readAssistantConversations(100);
    const snapshots = new Map(
      before.conversations.map(({ id }) => [
        id,
        localStorage.getItem(assistantConversationStorageKey(id)),
      ]),
    );
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "新对话" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "已保留 20 个非空会话。历史不会被自动删除，暂时无法新建；请继续使用现有会话。",
    );
    const after = readAssistantConversations();
    expect(after.conversations.map(({ id }) => id).sort()).toEqual(
      before.conversations.map(({ id }) => id).sort(),
    );
    expect(after.activeId).toBe(before.activeId);
    expect(after.conversations).toHaveLength(MAX_ASSISTANT_CONVERSATIONS);
    expect(screen.getByText("回答：会话 19")).toBeInTheDocument();
    for (const [id, snapshot] of snapshots) {
      expect(localStorage.getItem(assistantConversationStorageKey(id))).toBe(snapshot);
    }
  });

  it("重新回答不会把同一个问题重复写入最近问题", async () => {
    mockIpc.assistant.ask
      .mockResolvedValueOnce(reply({ answer: "第一次回答" }))
      .mockResolvedValueOnce(reply({ answer: "重新回答" }));
    renderPanel();

    await ask("只记一次的问题");
    await screen.findByText("第一次回答");
    expect(readRecentAssistantQuestions()).toEqual(["只记一次的问题"]);

    fireEvent.click(screen.getByRole("button", { name: "重新回答" }));
    await screen.findByText("重新回答");

    expect(readRecentAssistantQuestions()).toEqual(["只记一次的问题"]);
  });

  it("旧会话的迟到防抖保存不会覆盖新会话草稿", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(reply({ answer: "旧会话回答" }));
    renderPanel();
    await ask("旧会话问题");
    await screen.findByText("旧会话回答");

    const oldConversationId = readAssistantConversations().activeId;
    expect(oldConversationId).not.toBeNull();

    vi.useFakeTimers();
    const clearTimeout = vi.spyOn(window, "clearTimeout").mockImplementation(() => undefined);
    try {
      fireEvent.change(screen.getByLabelText("对助手说"), {
        target: { value: "旧会话未发送草稿" },
      });
      fireEvent.click(screen.getByRole("button", { name: "新对话" }));
      const newConversationId = readAssistantConversations().activeId;
      expect(newConversationId).not.toBe(oldConversationId);

      fireEvent.change(screen.getByLabelText("对助手说"), {
        target: { value: "新会话未发送草稿" },
      });
      act(() => vi.advanceTimersByTime(300));

      expect(readAssistantConversation(oldConversationId!)?.session.draft).toBe(
        "旧会话未发送草稿",
      );
      expect(readAssistantConversation(newConversationId!)?.session.draft).toBe(
        "新会话未发送草稿",
      );
    } finally {
      clearTimeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("当前会话保存失败时中止历史切换并保留界面内容", async () => {
    mockIpc.assistant.ask
      .mockResolvedValueOnce(reply({ answer: "第一会话回答" }))
      .mockResolvedValueOnce(reply({ answer: "第二会话回答" }));
    renderPanel();
    await ask("第一会话问题");
    await screen.findByText("第一会话回答");
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    await ask("第二会话问题");
    await screen.findByText("第二会话回答");
    fireEvent.change(screen.getByLabelText("对助手说"), {
      target: { value: "不能丢的草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "会话历史" }));

    const currentId = readAssistantConversations().activeId as string;
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === assistantConversationStorageKey(currentId)) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        return originalSetItem.call(this, key, value);
      });
    try {
      fireEvent.click(screen.getByRole("button", { name: /^第一会话问题/ }));
      expect(await screen.findByRole("alert")).toHaveTextContent("当前会话未能保存");
      expect(screen.getByText("第二会话回答")).toBeInTheDocument();
      expect(screen.queryByText("第一会话回答")).not.toBeInTheDocument();
      expect(screen.getByLabelText("对助手说")).toHaveValue("不能丢的草稿");
    } finally {
      setItem.mockRestore();
    }
  });

  it("activeId 索引保存失败时中止历史切换", async () => {
    mockIpc.assistant.ask
      .mockResolvedValueOnce(reply({ answer: "索引场景第一答" }))
      .mockResolvedValueOnce(reply({ answer: "索引场景第二答" }));
    renderPanel();
    await ask("索引场景第一问");
    await screen.findByText("索引场景第一答");
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    await ask("索引场景第二问");
    await screen.findByText("索引场景第二答");
    fireEvent.click(screen.getByRole("button", { name: "会话历史" }));

    const currentId = readAssistantConversations().activeId;
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === assistantConversationsStorageKey) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        return originalSetItem.call(this, key, value);
      });
    try {
      fireEvent.click(screen.getByRole("button", { name: /^索引场景第一问/ }));
      expect(await screen.findByRole("alert")).toHaveTextContent("当前会话未能保存");
      expect(screen.getByText("索引场景第二答")).toBeInTheDocument();
      expect(screen.queryByText("索引场景第一答")).not.toBeInTheDocument();
      expect(readAssistantConversations().activeId).toBe(currentId);
    } finally {
      setItem.mockRestore();
    }
  });

  it("重挂载后恢复对话、续聊历史和草稿，但不复活旧确认动作", async () => {
    const savedHistory = [
      { role: "user", content: "删掉第一讲" },
      { role: "assistant", content: "已经准备好，等你确认" },
    ];
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        answer: "已经准备好，等你确认",
        history: savedHistory,
        actions: [{ kind: "propose_delete", video_id: "v1", title: "第一讲" }],
      }),
    );
    renderPanel();
    await ask("删掉第一讲");
    expect(await screen.findByRole("button", { name: "确认删除" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("对助手说"), { target: { value: "接着问" } });

    cleanup();
    useAssistantUi.setState({ open: true, side: "right" });
    renderPanel();

    expect(screen.getByText("已经准备好，等你确认")).toBeInTheDocument();
    expect(screen.getByText(/本轮原有操作按钮已失效/)).toBeInTheDocument();
    expect(screen.getByLabelText("对助手说")).toHaveValue("接着问");
    expect(screen.queryByRole("button", { name: "确认删除" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("发送"));
    await waitFor(() =>
      expect(mockIpc.assistant.ask).toHaveBeenLastCalledWith(
        "接着问",
        expect.anything(),
        [
          ...savedHistory,
          {
            role: "assistant",
            content: expect.stringContaining("旧操作按钮已失效"),
          },
        ],
        expect.any(String),
        expect.any(Function),
      ),
    );
  });

  it("复制回答提供明确成功反馈", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockIpc.assistant.ask.mockResolvedValueOnce(reply({ answer: "可复制的回答" }));
    renderPanel();
    await ask("给我答案");

    fireEvent.click(await screen.findByRole("button", { name: "复制回答" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("可复制的回答"));
    expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();
  });

  it("旧回答里的时间戳会回到回答产生时的视频", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(reply({ answer: "回看 [01:30]" }));
    const onNavigate = vi.fn();
    renderPanel(onNavigate, { context: { course_id: "c1", video_id: "v1" } });
    await ask("在哪讲的");
    await screen.findByRole("button", { name: /01:30/ });

    cleanup();
    useAssistantUi.setState({ open: true, side: "right" });
    renderPanel(onNavigate, { context: { course_id: "c1", video_id: "v2" } });
    fireEvent.click(screen.getByRole("button", { name: /01:30/ }));

    expect(onNavigate).toHaveBeenCalledWith({
      kind: "open_video",
      video_id: "v1",
      course_id: "c1",
      title: "原视频",
      at_ms: 90_000,
    });
  });

  it("打开后聚焦输入框，Escape 收起并把焦点还给入口", async () => {
    useAssistantUi.setState({ open: false, side: "right" });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "打开助手" }));
    const input = screen.getByLabelText("对助手说");
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.keyDown(input, { key: "Escape" });
    const launcher = screen.getByRole("button", { name: "打开助手" });
    await waitFor(() => expect(launcher).toHaveFocus());
    expect(input).not.toBeVisible();
  });

  it("导航动作点一下才执行，不会自己跳走", async () => {
    const action: AssistantAction = {
      kind: "open_video",
      video_id: "v9",
      title: "第三讲",
      at_ms: 90000,
    };
    mockIpc.assistant.ask.mockResolvedValueOnce(reply({ actions: [action] }));
    const onNavigate = renderPanel();
    await ask("打开第三讲");

    const button = await screen.findByText(/打开《第三讲》/);
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(onNavigate).toHaveBeenCalledWith(action);
  });

  it("自己说的话显示成气泡", async () => {
    renderPanel();
    await ask("这讲了什么");
    const bubble = await screen.findByTestId("user-bubble");
    expect(bubble).toHaveTextContent("这讲了什么");
  });

  it("工具链用人话显示，不是函数名", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        tools_used: ["get_study_progress", "list_due_reviews", "search_content", "open_video"],
        turns: 3,
      }),
    );
    renderPanel();
    await ask("找找看");
    const chips = await screen.findByTestId("tool-chips");
    expect(chips).toHaveTextContent("读取学习进度");
    expect(chips).toHaveTextContent("查看待复习");
    expect(chips).toHaveTextContent("搜索课程内容");
    expect(chips).toHaveTextContent("打开视频");
    // search_content 是给模型看的标识符，摆在界面上只会让人去猜它是什么。
    expect(chips).not.toHaveTextContent("search_content");
    expect(chips).not.toHaveTextContent("get_study_progress");
  });

  it("连着调同一个工具折叠成 ×N", async () => {
    // 真实遇到过：连搜三次 B 站，底下并排三颗一模一样的标签。
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ tools_used: ["search_bilibili", "search_bilibili", "search_bilibili"], turns: 3 }),
    );
    renderPanel();
    await ask("找视频");
    const chips = await screen.findByTestId("tool-chips");
    expect(chips).toHaveTextContent("搜索 B 站");
    expect(chips).toHaveTextContent("×3");
  });

  it("会改动东西的工具标成「准备」，免得看起来像已经做了", async () => {
    // 它只生成了确认卡、什么都没做。写成「删除视频」会让人以为已经删了，
    // 那底下紧跟着的确认卡就白设了。
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ tools_used: ["delete_video"], turns: 2 }),
    );
    renderPanel();
    await ask("删了它");
    expect(await screen.findByTestId("tool-chips")).toHaveTextContent("准备删除");
  });

  it("拖内侧边框能把面板拉宽，贴边的那一侧不动", () => {
    // 固定 360px 对一段带列表和公式的长回答太窄了：每行放不下十几个字，一条列表项要折三行。
    renderPanel();
    const panel = screen.getByRole("complementary", { name: "助手" });
    // 停在右边时抓的是左边框，右边缘应当钉住不动——不然拉宽会把整块面板推出屏幕。
    expect(panel).toHaveStyle({ left: "628px", width: "380px" });

    const handle = screen.getByRole("separator", { name: "调整助手宽度" });
    fireEvent.pointerDown(handle, { pointerId: 9, pointerType: "mouse", button: 0, clientX: 628 });
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 528 });
    expect(panel).toHaveStyle({ left: "528px", width: "480px" });
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 528 });

    expect(panel).toHaveStyle({ left: "528px", width: "480px" });
    // 松手才写进偏好：拖动过程中每动一像素就写一次磁盘毫无必要。
    expect(useAssistantUi.getState().width).toBe(480);
    expect(localStorage.getItem("assistant_panel_width")).toBe("480");
  });

  it("宽度夹在能读的区间里，既拉不成半个屏幕也压不成一条缝", () => {
    renderPanel();
    const panel = screen.getByRole("complementary", { name: "助手" });
    const handle = screen.getByRole("separator", { name: "调整助手宽度" });

    fireEvent.pointerDown(handle, { pointerId: 4, pointerType: "mouse", button: 0, clientX: 628 });
    fireEvent.pointerMove(window, { pointerId: 4, clientX: -4000 });
    expect(panel).toHaveStyle({ width: "720px" });
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 4000 });
    expect(panel).toHaveStyle({ width: "320px" });
    fireEvent.pointerUp(window, { pointerId: 4, clientX: 4000 });
  });

  it("键盘也能调面板宽度", () => {
    renderPanel();
    const panel = screen.getByRole("complementary", { name: "助手" });
    const handle = screen.getByRole("separator", { name: "调整助手宽度" });

    // 抓手在左边框上，向左即变宽。
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(panel).toHaveStyle({ left: "596px", width: "412px" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(panel).toHaveStyle({ left: "628px", width: "380px" });
    expect(handle).toHaveAttribute("aria-valuenow", "380");
  });

  it("快捷键能呼出和收起助手", async () => {
    // 只能靠鼠标点那颗球才打得开，等于把常驻助手排除在键盘之外。
    useAssistantUi.setState({ open: false });
    renderPanel();

    fireEvent.keyDown(window, { key: "j", metaKey: true });
    await waitFor(() => expect(screen.getByLabelText("对助手说")).toBeVisible());

    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    await waitFor(() => expect(screen.getByLabelText("对助手说")).not.toBeVisible());

    // 光按 j 不能生效，否则往输入框里打一个 j 就把面板关了。
    fireEvent.keyDown(window, { key: "j" });
    expect(screen.getByLabelText("对助手说")).not.toBeVisible();
  });

  it("翻上去看旧消息时留一条回到最新的路", async () => {
    renderPanel();
    await ask("问一句");
    await screen.findByText("好了");
    expect(screen.queryByRole("button", { name: "回到最新" })).not.toBeInTheDocument();

    const log = screen.getByRole("log");
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(log, "scrollTop", { configurable: true, writable: true, value: 300 });
    fireEvent.scroll(log);

    // 新回答落在屏幕外时，原来既没有提示也没有回去的路，只能自己往下拖。
    fireEvent.click(await screen.findByRole("button", { name: "回到最新" }));
    expect(log.scrollTop).toBe(1000);
    expect(screen.queryByRole("button", { name: "回到最新" })).not.toBeInTheDocument();
  });

  it("重新回答把这一轮换掉，并退回到提问之前的上下文", async () => {
    // 不退回去，模型会看见自己刚才那次回答，「重新回答」就变成了「顺着刚才继续说」
    // ——而用户点它，恰恰是因为刚才那次不满意。
    mockIpc.assistant.ask
      .mockResolvedValueOnce(
        reply({
          answer: "第一答",
          history: [
            { role: "user", content: "讲了什么" },
            { role: "assistant", content: "第一答" },
          ],
        }),
      )
      .mockResolvedValueOnce(reply({ answer: "换个说法" }));
    renderPanel();
    await ask("讲了什么");
    await screen.findByText("第一答");

    fireEvent.click(screen.getByRole("button", { name: "重新回答" }));

    await waitFor(() =>
      expect(mockIpc.assistant.ask).toHaveBeenLastCalledWith(
        "讲了什么",
        { course_id: "c1", video_id: "v1" },
        [],
        expect.any(String),
        expect.any(Function),
      ),
    );
    expect(await screen.findByText("换个说法")).toBeInTheDocument();
    // 换掉，而不是并排留着两条回答。
    expect(screen.queryByText("第一答")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("user-bubble")).toHaveLength(1);
  });

  it("重启后的检查点说明旧操作，并只用当前上下文重新核对", async () => {
    writeAssistantSession(
      {
        turns: [
          {
            id: "expired-turn",
            question: "删除导论",
            answer: "请确认",
            actions: [
              {
                kind: "propose_delete",
                video_id: "stale-video-id",
                course_id: "stale-course-id",
                course_name: "课程甲",
                title: "导论",
              },
            ],
            tools: ["delete_video"],
            canceled: false,
            actionResults: [],
          },
        ],
        history: [
          { role: "user", content: "删除导论" },
          { role: "assistant", content: "请确认" },
        ],
        draft: "",
      },
      Date.now() - 1_000,
    );
    mockIpc.assistant.ask.mockResolvedValueOnce(reply({ answer: "已重新核对" }));

    renderPanel(vi.fn(), {
      context: { course_id: "current-course-id", video_id: "current-video-id" },
    });

    expect(screen.getByText("上次待处理：删除视频 · 导论（课程甲）")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新核对这项操作" }));

    await waitFor(() =>
      expect(mockIpc.assistant.ask).toHaveBeenCalledWith(
        "删除导论",
        { course_id: "current-course-id", video_id: "current-video-id" },
        [
          { role: "user", content: "删除导论" },
          {
            role: "assistant",
            content: expect.stringContaining("旧操作按钮已失效"),
          },
        ],
        expect.any(String),
        expect.any(Function),
      ),
    );
    expect(JSON.stringify(mockIpc.assistant.ask.mock.calls[0])).not.toContain("stale-video-id");
    expect(JSON.stringify(mockIpc.assistant.ask.mock.calls[0])).not.toContain("stale-course-id");
    expect(await screen.findByText("已重新核对")).toBeInTheDocument();
  });

  it("重新回答被停掉的那一轮，不会把上一轮真实问答也砍掉", async () => {
    // 停掉的那轮整轮都没进上下文，现在的 history 已经就是提问之前的样子。
    mockIpc.assistant.ask
      .mockResolvedValueOnce(
        reply({
          answer: "第一答",
          history: [
            { role: "user", content: "第一问" },
            { role: "assistant", content: "第一答" },
          ],
        }),
      )
      .mockResolvedValueOnce(reply({ answer: "半截", canceled: true }))
      .mockResolvedValueOnce(reply({ answer: "重来的答案" }));
    renderPanel();
    await ask("第一问");
    await screen.findByText("第一答");
    await ask("第二问");
    await screen.findByText("半截");

    fireEvent.click(screen.getByRole("button", { name: "重新回答" }));

    await waitFor(() =>
      expect(mockIpc.assistant.ask).toHaveBeenLastCalledWith(
        "第二问",
        expect.anything(),
        [
          { role: "user", content: "第一问" },
          { role: "assistant", content: "第一答" },
        ],
        expect.any(String),
        expect.any(Function),
      ),
    );
  });

  it("重新回答不会清掉输入框里正打着的下一个问题", async () => {
    mockIpc.assistant.ask.mockResolvedValue(reply({ answer: "第一答" }));
    renderPanel();
    await ask("讲了什么");
    await screen.findByText("第一答");

    const box = screen.getByLabelText("对助手说");
    fireEvent.change(box, { target: { value: "顺手打的下一个问题" } });
    fireEvent.click(screen.getByRole("button", { name: "重新回答" }));

    await waitFor(() => expect(mockIpc.assistant.ask).toHaveBeenCalledTimes(2));
    expect(box).toHaveValue("顺手打的下一个问题");
  });

  it("只给最后一轮重新回答：往回重生成会让后面的问答全部失去依据", async () => {
    renderPanel();
    await ask("第一问");
    await screen.findByText("好了");
    mockIpc.assistant.ask.mockResolvedValueOnce(reply({ answer: "第二答" }));
    await ask("第二问");
    await screen.findByText("第二答");

    expect(screen.getAllByRole("button", { name: "重新回答" })).toHaveLength(1);
  });

  it("助手转到轮次上限停下时说清楚，不让过场话冒充结论", async () => {
    // 撞上限那一轮，answer 里留的常常是它某一轮的交代，而不是答案。原样铺出来，
    // 用户读到的是一句「我先查一下」，还以为助手就答成这样。
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ answer: "我先查一下这门课有哪些视频", hit_turn_limit: true }),
    );
    renderPanel();
    await ask("把这门课整理成提纲");

    expect(await screen.findByText(/没能得出结论/)).toBeInTheDocument();
    // 它说过的话仍然留着——被截断不代表这段过程没有价值。
    expect(screen.getByText("我先查一下这门课有哪些视频")).toBeInTheDocument();
  });

  it("以后端 stop_reason 为准识别轮次上限", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        answer: "我还在整理",
        stop_reason: "limit_reached",
        hit_turn_limit: false,
      }),
    );
    renderPanel();
    await ask("继续整理");

    expect(await screen.findByText(/没能得出结论/)).toBeInTheDocument();
  });

  it("强制总结成功时不被旧的轮次上限字段误报为未完成", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        answer: "这是收束后的完整总结",
        stop_reason: "summarized_after_limit",
        hit_turn_limit: true,
      }),
    );
    renderPanel();
    await ask("总结这门课");

    expect(await screen.findByText("这是收束后的完整总结")).toBeInTheDocument();
    expect(screen.queryByText(/没能得出结论/)).not.toBeInTheDocument();
  });

  it("一个字都没回时不留一片空白，并且就地给出重试入口", async () => {
    // 这是最糟的一种：问完之后什么都没有，和程序坏了长得一模一样。
    // 而那排重新回答按钮挂在回答上，恰恰是最需要重试的这种情况反而没有入口。
    mockIpc.assistant.ask.mockResolvedValueOnce(reply({ answer: "", hit_turn_limit: true }));
    renderPanel();
    await ask("把这门课整理成提纲");

    expect(await screen.findByText(/没能得出结论/)).toBeInTheDocument();
    mockIpc.assistant.ask.mockResolvedValueOnce(reply({ answer: "这次答出来了" }));
    fireEvent.click(screen.getByRole("button", { name: "重新回答" }));

    expect(await screen.findByText("这次答出来了")).toBeInTheDocument();
    expect(mockIpc.assistant.ask.mock.calls[1][0]).toBe("把这门课整理成提纲");
  });

  it("回答为空又没撞上限时，同样明说这次没回答", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(reply({ answer: "" }));
    renderPanel();
    await ask("讲讲这段");

    expect(await screen.findByText("助手这次没有给出回答。")).toBeInTheDocument();
  });

  it("英文建议发送英文完整问题，并用英文说明空回答", async () => {
    await i18n.changeLanguage("en");
    mockIpc.assistant.ask.mockResolvedValueOnce(reply({ answer: "" }));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Summarize this video" }));

    await waitFor(() =>
      expect(mockIpc.assistant.ask).toHaveBeenCalledWith(
        "Summarize the main content of this video",
        expect.objectContaining({ course_id: "c1", video_id: "v1" }),
        expect.any(Array),
        expect.any(String),
        expect.any(Function),
      ),
    );
    expect(
      await screen.findByText("The assistant did not return an answer this time."),
    ).toBeInTheDocument();
    expect(screen.queryByText("助手这次没有给出回答。")).not.toBeInTheDocument();
  });

  it("用户叫停的那一轮不挂「没得出结论」——它没转不出来，是被按停的", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ answer: "", canceled: true, hit_turn_limit: true }),
    );
    renderPanel();
    await ask("查完所有课程");

    expect(await screen.findByText("已停止，未继续执行")).toBeInTheDocument();
    expect(screen.queryByText(/没能得出结论/)).not.toBeInTheDocument();
    // 「已停止」已经把话说完了，再补一句「这次没有给出回答」是同一件事说两遍。
    expect(screen.queryByText("助手这次没有给出回答。")).not.toBeInTheDocument();
  });

  it("stop_reason 标记取消时不执行旧字段携带的动作", async () => {
    useTheme.setState({ pref: "light" });
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        answer: "",
        stop_reason: "canceled",
        canceled: false,
        actions: [
          { kind: "set_theme", pref: "dark" },
          { kind: "propose_delete", video_id: "v1", title: "第一讲" },
        ],
      }),
    );
    renderPanel();
    await ask("停止并删除它");

    expect(await screen.findByText("已停止，未继续执行")).toBeInTheDocument();
    expect(useTheme.getState().pref).toBe("light");
    expect(screen.queryByRole("button", { name: "确认删除" })).not.toBeInTheDocument();
  });

  it("正常答完的一轮不挂任何未完成说明", async () => {
    renderPanel();
    await ask("讲讲这段");
    await screen.findByText("好了");

    expect(screen.queryByText(/没能得出结论/)).not.toBeInTheDocument();
    expect(screen.queryByText("助手这次没有给出回答。")).not.toBeInTheDocument();
  });

  it("输入法组词时的回车不发送", async () => {
    renderPanel();
    const box = screen.getByLabelText("对助手说");
    fireEvent.change(box, { target: { value: "梯度" } });
    // 中文用户每选一次候选词都会敲回车，当成发送就会不停误发。
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(mockIpc.assistant.ask).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(mockIpc.assistant.ask).toHaveBeenCalled());
  });

  it("组合输入区聚焦时不叠加输入框自身的焦点环", () => {
    renderPanel();
    expect(screen.getByLabelText("对助手说")).toHaveClass("ca-ask-input");
  });

  it("手机端不显示左右停靠按钮", async () => {
    platformMock.mobile = true;
    renderPanel();
    expect(screen.queryByLabelText(/停靠到/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拖动助手面板" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("对助手说")).toBeInTheDocument();
  });

  it("宽屏 iPad 跟随布局档位使用桌面面板", () => {
    platformMock.mobile = true;
    platformMock.tablet = true;
    renderPanel(vi.fn(), { compact: false });
    expect(screen.getByRole("button", { name: "拖动助手面板" })).toBeInTheDocument();
    expect(screen.getByLabelText("当前提问范围：当前视频")).toBeInTheDocument();
  });

  it("提问范围菜单支持方向键并在 Escape 后回到触发按钮", async () => {
    renderPanel();
    const trigger = screen.getByRole("button", { name: "当前提问范围：当前视频" });

    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "选择提问范围" });
    expect(trigger).toHaveAttribute("aria-controls", menu.id);
    const items = screen.getAllByRole("menuitemradio");
    expect(trigger).toHaveClass("focus-visible:ring-[var(--focus-ring)]");
    expect(items.every((item) => item.tabIndex === -1)).toBe(true);
    expect(items.every((item) => item.classList.contains("focus-visible:ring-[var(--focus-ring)]"))).toBe(true);
    await waitFor(() => expect(items[0]).toHaveFocus());
    expect(items.filter((item) => item.getAttribute("aria-checked") === "true")).toHaveLength(1);

    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1], { key: "End" });
    expect(items[items.length - 1]).toHaveFocus();
    fireEvent.keyDown(items[items.length - 1], { key: "Home" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu", { name: "选择提问范围" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    const reopened = screen.getAllByRole("menuitemradio")[0];
    await waitFor(() => expect(reopened).toHaveFocus());
    fireEvent.keyDown(reopened, { key: "Tab" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "选择提问范围" })).not.toBeInTheDocument());
    expect(trigger).not.toHaveFocus();
  });

  it("窄视口按移动抽屉渲染，并避开底部主导航", () => {
    renderPanel(vi.fn(), { compact: true, bottomNavigationVisible: true });
    const panel = screen.getByRole("dialog", { name: "助手" });
    expect(screen.queryByRole("button", { name: "拖动助手面板" })).not.toBeInTheDocument();
    expect(panel).toHaveClass("inset-x-0", "h-[70dvh]");
    expect(panel.getAttribute("style")).toContain("bottom: calc(56px");
  });

  it("工作台收起助手时避开面板右下角操作轨道", () => {
    platformMock.mobile = true;
    useAssistantUi.setState({ open: false });
    renderPanel(vi.fn(), { compact: true, bottomNavigationVisible: false });
    const launcher = screen.getByRole("button", { name: "打开助手" });
    expect(launcher).toHaveClass("ca-workbench-assistant-launcher");
    // jsdom 会规范化 env() 的 calc 顺序；保留几何契约的关键安全间距即可。
    expect(launcher.getAttribute("style")).toContain("88px");
  });

  it("工具型整页可以收起浮动入口，避免遮挡行内操作", () => {
    platformMock.mobile = true;
    useAssistantUi.setState({ open: false });
    renderPanel(vi.fn(), { compact: true, bottomNavigationVisible: true, launcherVisible: false });

    expect(screen.queryByRole("button", { name: "打开助手" })).not.toBeInTheDocument();
  });

  it("移动抽屉有模态遮罩，焦点循环在抽屉内并可点击遮罩关闭", async () => {
    renderPanel(vi.fn(), { compact: true });
    const panel = screen.getByRole("dialog", { name: "助手" });
    expect(panel).toHaveAttribute("aria-modal", "true");
    const input = screen.getByLabelText("对助手说");
    const send = screen.getByLabelText("发送");
    const close = screen.getByLabelText("收起助手");
    expect(send).toHaveClass("ca-touch-44");
    expect(close).toHaveClass("ca-touch-44");
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: "查一下" } });

    send.focus();
    fireEvent.keyDown(send, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(send).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "关闭助手" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "打开助手" })).toHaveFocus());
    expect(panel).not.toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "打开助手" }));
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "收起助手" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "打开助手" })).toHaveFocus());
  });

  it("移动抽屉的思考摘要参与键盘焦点循环", async () => {
    writeAssistantSession({
      turns: [
        {
          id: "reasoning-turn",
          question: "为什么",
          answer: "因为条件成立。",
          reasoning: "先检查条件。",
          actions: [],
          tools: [],
          canceled: false,
          actionResults: [],
        },
      ],
      history: [
        { role: "user", content: "为什么" },
        { role: "assistant", content: "因为条件成立。" },
      ],
      draft: "",
    });
    renderPanel(vi.fn(), { compact: true });

    const summary = screen.getByText("思考过程");
    expect(screen.getByRole("button", { name: "复制回答" })).toHaveClass("ca-touch-44");
    expect(screen.getByRole("button", { name: "重新回答" })).toHaveClass("ca-touch-44");
    summary.focus();
    fireEvent.keyDown(summary, { key: "Tab" });
    expect(screen.getByRole("button", { name: "复制回答" })).toHaveFocus();
  });
});

describe("确认卡", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    platformMock.mobile = false;
    platformMock.tablet = false;
    useAssistantUi.setState({ open: true, side: "right" });
    mockIpc.assistant.ask.mockResolvedValue(reply());
    mockIpc.assistant.cancel.mockResolvedValue(undefined);
    mockIpc.courses.list.mockResolvedValue([
      {
        id: "c1",
        name: "线性代数",
        root_path: "/tmp/course",
        cover_image: null,
        created_at: 1,
        updated_at: 1,
      },
    ]);
    mockIpc.videos.list.mockResolvedValue([]);
    mockIpc.tools.hasBilibiliCookies.mockResolvedValue(true);
    mockIpc.tools.probeBilibili.mockResolvedValue({
      title: "双曲线",
      qualities: [1080, 720],
      tracks: [
        { lang: "ai-zh", auto: true, label: "AI 中文" },
        { lang: "zh-Hans", auto: false, label: "中文（简体）" },
      ],
    });
    mockIpc.tools.importBilibili.mockResolvedValue({ id: "newvid" });
    mockIpc.settings.get.mockResolvedValue(null);
  });

  it("改名要等用户点确认才真的改", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_rename",
            video_id: "v1",
            course_name: "线性代数",
            current_title: "未命名",
            new_title: "第三讲 特征值",
          },
        ],
      }),
    );
    renderPanel();
    await ask("改个名");

    // 卡片必须把原名和新名都摆出来——最大的风险不是「AI 要改名」，是它认错了对象。
    expect(await screen.findByText("未命名")).toBeInTheDocument();
    expect(screen.getByText("第三讲 特征值")).toBeInTheDocument();
    expect(screen.getByText("课程：线性代数")).toBeInTheDocument();
    // 还没点之前，什么都不该发生。
    expect(mockIpc.videos.updateTitle).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认改名" }));
    await waitFor(() =>
      expect(mockIpc.videos.updateTitle).toHaveBeenCalledWith("v1", "第三讲 特征值"),
    );
    expect(await screen.findByText("已生效")).toBeInTheDocument();
  });

  it("已完成的动作在收起再打开后不会复活", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_rename",
            video_id: "v1",
            current_title: "未命名",
            new_title: "第一讲",
          },
        ],
      }),
    );
    renderPanel();
    await ask("改名");
    fireEvent.click(await screen.findByRole("button", { name: "确认改名" }));
    expect(await screen.findByText("已生效")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "收起助手" }));
    fireEvent.click(screen.getByRole("button", { name: "打开助手" }));

    expect(screen.getByText("已生效")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认改名" })).not.toBeInTheDocument();
    expect(mockIpc.videos.updateTitle).toHaveBeenCalledTimes(1);
  });

  it("动作结果写回续聊历史，Agent 不再误以为仍待确认", async () => {
    const initialHistory = [
      { role: "user", content: "改名" },
      { role: "assistant", content: "已经准备好，等你确认" },
    ];
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        history: initialHistory,
        actions: [
          {
            kind: "propose_rename",
            video_id: "v1",
            current_title: "未命名",
            new_title: "第一讲",
          },
        ],
      }),
    );
    renderPanel();
    await ask("改名");
    fireEvent.click(await screen.findByRole("button", { name: "确认改名" }));
    await screen.findByText("已生效");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("操作状态更新：已完成改名：第一讲");
    expect(screen.getByText("已生效")).toHaveFocus();

    await ask("完成了吗");
    await waitFor(() => {
      const calls = mockIpc.assistant.ask.mock.calls;
      const sentHistory = calls[calls.length - 1]?.[2];
      expect(sentHistory[sentHistory.length - 1].content).toContain(
        "界面操作结果：已完成改名：第一讲",
      );
    });
  });

  it("请求进行时执行旧确认卡，操作结果不会被新回复覆盖", async () => {
    const initialHistory = [
      { role: "user", content: "改名" },
      { role: "assistant", content: "已经准备好，等你确认" },
    ];
    const secondHistory = [
      ...initialHistory,
      { role: "user", content: "顺便总结一下" },
      { role: "assistant", content: "这是第二轮回答" },
    ];
    let finishSecond!: (value: AssistantReply) => void;
    mockIpc.assistant.ask
      .mockResolvedValueOnce(
        reply({
          history: initialHistory,
          actions: [
            {
              kind: "propose_rename",
              video_id: "v1",
              current_title: "未命名",
              new_title: "第一讲",
            },
          ],
        }),
      )
      .mockReturnValueOnce(
        new Promise<AssistantReply>((resolve) => {
          finishSecond = resolve;
        }),
      );
    renderPanel();
    await ask("改名");
    const confirm = await screen.findByRole("button", { name: "确认改名" });

    await ask("顺便总结一下");
    fireEvent.click(confirm);
    expect(await screen.findByText("操作结果：已完成改名：第一讲")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("操作状态更新：已完成改名：第一讲"),
    );
    finishSecond(reply({ answer: "这是第二轮回答", history: secondHistory }));
    await screen.findByText("这是第二轮回答");

    await ask("现在完成了吗");
    await waitFor(() => {
      const calls = mockIpc.assistant.ask.mock.calls;
      const sentHistory = calls[calls.length - 1]?.[2];
      expect(sentHistory).toEqual([
        ...secondHistory,
        { role: "assistant", content: "（界面操作结果：已完成改名：第一讲）" },
      ]);
    });
  });

  it("旧确认动作在后一轮请求期间完成，重生成仍保留它的操作回执", async () => {
    const initialHistory = [
      { role: "user", content: "改名" },
      { role: "assistant", content: "已经准备好，等你确认" },
    ];
    const secondHistory = [
      ...initialHistory,
      { role: "user", content: "顺便总结一下" },
      { role: "assistant", content: "这是第二轮回答" },
    ];
    let finishSecond!: (value: AssistantReply) => void;
    mockIpc.assistant.ask
      .mockResolvedValueOnce(
        reply({
          history: initialHistory,
          actions: [
            {
              kind: "propose_rename",
              video_id: "v1",
              current_title: "未命名",
              new_title: "第一讲",
            },
          ],
        }),
      )
      .mockReturnValueOnce(
        new Promise<AssistantReply>((resolve) => {
          finishSecond = resolve;
        }),
      )
      .mockResolvedValueOnce(reply({ answer: "重生成的回答" }));
    renderPanel();
    await ask("改名");
    const confirm = await screen.findByRole("button", { name: "确认改名" });

    await ask("顺便总结一下");
    fireEvent.click(confirm);
    await screen.findByText("操作结果：已完成改名：第一讲");
    finishSecond(reply({ answer: "这是第二轮回答", history: secondHistory }));
    await screen.findByText("这是第二轮回答");

    fireEvent.click(screen.getByRole("button", { name: "重新回答" }));
    await waitFor(() => {
      expect(mockIpc.assistant.ask).toHaveBeenCalledTimes(3);
      expect(mockIpc.assistant.ask.mock.calls[2][2]).toEqual([
        ...initialHistory,
        { role: "assistant", content: "（界面操作结果：已完成改名：第一讲）" },
      ]);
    });
  });

  it("已完成动作在真正重挂载后保留结果，但不复活确认卡", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        history: [
          { role: "user", content: "改名" },
          { role: "assistant", content: "已经准备好，等你确认" },
        ],
        actions: [
          {
            kind: "propose_rename",
            video_id: "v1",
            current_title: "未命名",
            new_title: "第一讲",
          },
        ],
      }),
    );
    renderPanel();
    await ask("改名");
    fireEvent.click(await screen.findByRole("button", { name: "确认改名" }));
    expect(await screen.findByText("操作结果：已完成改名：第一讲")).toBeInTheDocument();

    cleanup();
    useAssistantUi.setState({ open: true, side: "right" });
    renderPanel();

    expect(screen.getByText("操作结果：已完成改名：第一讲")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认改名" })).not.toBeInTheDocument();
    expect(screen.queryByText(/原有操作按钮已失效/)).not.toBeInTheDocument();
    expect(mockIpc.videos.updateTitle).toHaveBeenCalledTimes(1);
  });

  it("确认动作执行中卸载后按结果不确定恢复，不能伪装成未执行", async () => {
    let finishRename!: () => void;
    mockIpc.videos.updateTitle.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishRename = resolve;
      }),
    );
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        history: [
          { role: "user", content: "改名" },
          { role: "assistant", content: "已经准备好，等你确认" },
        ],
        actions: [
          {
            kind: "propose_rename",
            video_id: "v1",
            current_title: "未命名",
            new_title: "第一讲",
          },
        ],
      }),
    );
    renderPanel();
    await ask("改名");
    fireEvent.click(await screen.findByRole("button", { name: "确认改名" }));
    await waitFor(() =>
      expect(mockIpc.videos.updateTitle).toHaveBeenCalledWith("v1", "第一讲"),
    );

    cleanup();
    await act(async () => {
      finishRename();
      await Promise.resolve();
    });
    useAssistantUi.setState({ open: true, side: "right" });
    renderPanel();

    expect(screen.getByText(/结果可能已经生效/)).toBeInTheDocument();
    expect(screen.getByText(/上次待处理：改名 · 未命名/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认改名" })).not.toBeInTheDocument();
    expect(mockIpc.videos.updateTitle).toHaveBeenCalledTimes(1);
  });

  it("确认操作执行中不能丢掉旧会话，完成后才允许新建对话", async () => {
    let finishRename!: () => void;
    mockIpc.videos.updateTitle.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishRename = resolve;
      }),
    );
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        history: [
          { role: "user", content: "改名" },
          { role: "assistant", content: "已经准备好，等你确认" },
        ],
        actions: [
          {
            kind: "propose_rename",
            video_id: "v1",
            current_title: "未命名",
            new_title: "第一讲",
          },
        ],
      }),
    );
    renderPanel();
    await ask("改名");
    fireEvent.click(await screen.findByRole("button", { name: "确认改名" }));

    const executingSession = JSON.parse(
      localStorage.getItem(assistantSessionStorageKey) ?? "{}",
    );
    expect(executingSession.turns[0].checkpoint.status).toBe("executing");

    const newConversation = screen.getByRole("button", { name: "新对话" });
    expect(newConversation).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新回答" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "停止剩余" })).not.toBeInTheDocument();
    fireEvent.click(newConversation);
    expect(screen.getByTestId("user-bubble")).toHaveTextContent("改名");

    await act(async () => {
      finishRename();
      await Promise.resolve();
    });
    await waitFor(() => expect(newConversation).toBeEnabled());
    expect(screen.getByRole("button", { name: "重新回答" })).toBeEnabled();
    const persistedTurn = readAssistantSession().turns[0];
    expect(persistedTurn.actionResults).toEqual(["已完成改名：第一讲"]);
    expect(persistedTurn.actionsExpired).toBeUndefined();
    expect(persistedTurn.checkpoint).toBeUndefined();

    fireEvent.click(newConversation);
    expect(screen.queryByTestId("user-bubble")).not.toBeInTheDocument();
  });

  it("不同确认卡不能并发执行，前一张完成后才解锁下一张", async () => {
    let finishDelete!: () => void;
    mockIpc.videos.delete.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishDelete = resolve;
      }),
    );
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          { kind: "propose_delete", video_id: "v2", title: "第五讲" },
          {
            kind: "propose_setting",
            key: "subtitle_autocorrect",
            label: "字幕 AI 纠错",
            current: null,
            value: "true",
          },
        ],
      }),
    );
    renderPanel();
    await ask("先删视频，再开字幕纠错");

    const deleteButton = await screen.findByRole("button", { name: "确认删除" });
    const settingButton = await screen.findByRole("button", { name: "确认修改" });
    act(() => {
      fireEvent.click(deleteButton);
      fireEvent.click(settingButton);
    });
    await waitFor(() => expect(mockIpc.videos.delete).toHaveBeenCalledWith("v2"));
    expect(mockIpc.settings.set).not.toHaveBeenCalled();
    expect(settingButton).toBeDisabled();

    await act(async () => {
      finishDelete();
      await Promise.resolve();
    });
    await waitFor(() => expect(settingButton).toBeEnabled());
    fireEvent.click(settingButton);
    await waitFor(() =>
      expect(mockIpc.settings.set).toHaveBeenCalledWith("subtitle_autocorrect", "true"),
    );
  });

  it("确认写操作与导航共享原子锁，同一帧只执行前一个动作", async () => {
    let finishDelete!: () => void;
    mockIpc.videos.delete.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishDelete = resolve;
      }),
    );
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          { kind: "propose_delete", video_id: "v2", title: "第五讲" },
          { kind: "open_video", video_id: "v3", title: "第六讲" },
        ],
      }),
    );
    const onNavigate = vi.fn();
    renderPanel(onNavigate);
    await ask("删除第五讲，再打开第六讲");

    const deleteButton = await screen.findByRole("button", { name: "确认删除" });
    const navigationButton = screen.getByRole("button", { name: /打开《第六讲》/ });
    act(() => {
      fireEvent.click(deleteButton);
      fireEvent.click(navigationButton);
    });
    await waitFor(() => expect(mockIpc.videos.delete).toHaveBeenCalledWith("v2"));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(navigationButton).toBeDisabled();

    await act(async () => {
      finishDelete();
      await Promise.resolve();
    });
    await waitFor(() => expect(navigationButton).toBeEnabled());
    fireEvent.click(navigationButton);
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "open_video", video_id: "v3" }),
    );
  });

  it("删除要等确认，并说清楚是进回收站", async () => {
    const onActionApplied = vi.fn();
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_delete",
            video_id: "v2",
            course_name: "高等数学",
            title: "第五讲",
          },
        ],
      }),
    );
    renderPanel(undefined, { onActionApplied });
    await ask("删了它");

    expect(await screen.findByText("第五讲")).toBeInTheDocument();
    expect(screen.getByText("课程：高等数学")).toBeInTheDocument();
    expect(screen.getByText(/30 天内可还原/)).toBeInTheDocument();
    expect(mockIpc.videos.delete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(mockIpc.videos.delete).toHaveBeenCalledWith("v2"));
    expect(onActionApplied).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "propose_delete", video_id: "v2" }),
    );
  });

  it("移动端确认按钮保留 44px 触控命中区并允许换行", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ actions: [{ kind: "propose_delete", video_id: "v2", title: "第五讲" }] }),
    );
    renderPanel(vi.fn(), { compact: true });
    await ask("删了它");

    const confirm = await screen.findByRole("button", { name: "确认删除" });
    const cancel = screen.getByRole("button", { name: "取消" });
    expect(confirm).toHaveClass("ca-touch-44");
    expect(cancel).toHaveClass("ca-touch-44");
    expect(confirm.parentElement).toHaveClass("flex-wrap");
  });

  it("取消提案就什么都不做", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ actions: [{ kind: "propose_delete", video_id: "v2", title: "第五讲" }] }),
    );
    renderPanel();
    await ask("删了它");
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    expect(mockIpc.videos.delete).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("第五讲")).not.toBeInTheDocument());
  });

  it("改设置显示改前改后，确认后才写", async () => {
    mockIpc.settings.get.mockResolvedValueOnce("false");
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_setting",
            key: "subtitle_autocorrect",
            label: "字幕 AI 纠错",
            current: "false",
            value: "true",
          },
        ],
      }),
    );
    renderPanel();
    await ask("把字幕纠错打开");
    expect(await screen.findByText("字幕 AI 纠错")).toBeInTheDocument();
    expect(screen.getByText("false → true")).toBeInTheDocument();
    expect(mockIpc.settings.set).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认修改" }));
    await waitFor(() =>
      expect(mockIpc.settings.set).toHaveBeenCalledWith("subtitle_autocorrect", "true"),
    );
  });

  it("执行失败要说出来，而不是悄悄退回待确认", async () => {
    mockIpc.videos.delete.mockRejectedValueOnce(new Error("文件被占用"));
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ actions: [{ kind: "propose_delete", video_id: "v2", title: "第五讲" }] }),
    );
    renderPanel();
    await ask("删了它");
    fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));
    // 悄悄退回的话，用户会以为自己没点上而再点一次——而第一次可能已经生效了。
    expect(await screen.findByRole("alert")).toHaveTextContent("文件被占用");
  });

  it("确认前目标已变化时整批不执行", async () => {
    mockIpc.videos.list.mockResolvedValueOnce([
      {
        id: "v1",
        course_id: "c1",
        title: "用户刚改的新名字",
      },
    ]);
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_rename",
            video_id: "v1",
            course_id: "c1",
            current_title: "旧名字",
            new_title: "助手建议的名字",
          },
        ],
      }),
    );
    renderPanel();
    await ask("改名");
    fireEvent.click(await screen.findByRole("button", { name: "确认改名" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("已发生变化");
    expect(screen.getByRole("button", { name: "目标已变化" })).toBeDisabled();
    expect(mockIpc.videos.updateTitle).not.toHaveBeenCalled();
  });

  it("新建课程要确认，并显示建在哪个目录", async () => {
    mockIpc.settings.get.mockResolvedValueOnce("/Users/me/课程");
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [{ kind: "propose_create_course", name: "概率论", root_path: "/Users/me/课程" }],
      }),
    );
    renderPanel();
    await ask("新建一门概率论");
    expect(await screen.findByText("概率论")).toBeInTheDocument();
    // 多数人记不清默认存放位置，建错地方后面很难收拾。
    expect(screen.getByText(/\/Users\/me\/课程/)).toBeInTheDocument();
    expect(mockIpc.courses.create).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认创建" }));
    await waitFor(() =>
      expect(mockIpc.courses.create).toHaveBeenCalledWith("概率论", "/Users/me/课程"),
    );
  });

  it("课程改名要确认，且和视频改名是两回事", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_rename_course",
            course_id: "c1",
            current_name: "线性代数",
            new_name: "线代复习",
          },
        ],
      }),
    );
    renderPanel();
    await ask("把课程改个名");
    expect(await screen.findByText("课程改名")).toBeInTheDocument();
    expect(screen.getByText("线性代数")).toBeInTheDocument();
    expect(mockIpc.courses.rename).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认改名" }));
    await waitFor(() => expect(mockIpc.courses.rename).toHaveBeenCalledWith("c1", "线代复习"));
    // 别把课程改名走成视频改名。
    expect(mockIpc.videos.updateTitle).not.toHaveBeenCalled();
  });

  it("确认之后要让列表失效，否则界面还在显示旧名字", async () => {
    // 真实反馈：确认了但名字没变。库里其实改好了，是界面在拿缓存——
    // 应用里别处的改动都顺带做了失效，这张卡直接调 IPC，漏了这一步。
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_rename",
            video_id: "v1",
            current_title: "未命名",
            new_title: "第三讲",
          },
        ],
      }),
    );
    renderPanel();
    await ask("改个名");
    fireEvent.click(await screen.findByRole("button", { name: "确认改名" }));
    await waitFor(() => expect(mockIpc.videos.updateTitle).toHaveBeenCalled());
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["videos"] }),
      ),
    );
    invalidate.mockRestore();
  });

  it("批量改名合成一张卡，只点一次确认", async () => {
    // 让人为一次批量改名点十下确认，等于把确认训练成一件要赶紧跳过的事，
    // 那就再也拦不住真正该拦的那一次了。
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          { kind: "propose_rename", video_id: "v1", current_title: "01", new_title: "第一讲" },
          { kind: "propose_rename", video_id: "v2", current_title: "02", new_title: "第二讲" },
          { kind: "propose_rename", video_id: "v3", current_title: "03", new_title: "第三讲" },
        ],
      }),
    );
    renderPanel();
    await ask("批量改名");

    expect(await screen.findByText("3 项")).toBeInTheDocument();
    // 只有一个确认按钮，不是三个。
    expect(screen.getAllByRole("button", { name: /确认改名/ })).toHaveLength(1);
    expect(screen.getByText("第一讲")).toBeInTheDocument();
    expect(screen.getByText("第三讲")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认改名 3 项" }));
    await waitFor(() => expect(mockIpc.videos.updateTitle).toHaveBeenCalledTimes(3));
    expect(mockIpc.videos.updateTitle).toHaveBeenCalledWith("v2", "第二讲");
  });

  it("批量里可以单独剔掉认错的那一条", async () => {
    // 批量里错一两个是常态，不该逼着人要么全接受要么全放弃。
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          { kind: "propose_rename", video_id: "v1", current_title: "01", new_title: "第一讲" },
          { kind: "propose_rename", video_id: "v2", current_title: "02", new_title: "认错了" },
        ],
      }),
    );
    renderPanel();
    await ask("批量改名");
    fireEvent.click(await screen.findByRole("button", { name: "跳过 认错了" }));

    fireEvent.click(screen.getByRole("button", { name: "确认改名 1 项" }));
    await waitFor(() => expect(mockIpc.videos.updateTitle).toHaveBeenCalledTimes(1));
    expect(mockIpc.videos.updateTitle).toHaveBeenCalledWith("v1", "第一讲");
  });

  it("批量里部分失败要说清是哪几项", async () => {
    mockIpc.videos.updateTitle
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("重名"));
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          { kind: "propose_rename", video_id: "v1", current_title: "01", new_title: "第一讲" },
          { kind: "propose_rename", video_id: "v2", current_title: "02", new_title: "第二讲" },
        ],
      }),
    );
    renderPanel();
    await ask("批量改名");
    fireEvent.click(await screen.findByRole("button", { name: "确认改名 2 项" }));
    // 只报一条错的话，用户无从知道该重做哪个。
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("1 项完成");
    expect(alert).toHaveTextContent("第二讲");
  });

  it("批量重试只执行失败项，已经成功的不能再做一次", async () => {
    mockIpc.videos.updateTitle
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("重名"))
      .mockResolvedValueOnce(undefined);
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          { kind: "propose_rename", video_id: "v1", current_title: "01", new_title: "第一讲" },
          { kind: "propose_rename", video_id: "v2", current_title: "02", new_title: "第二讲" },
        ],
      }),
    );
    renderPanel();
    await ask("批量改名");
    fireEvent.click(await screen.findByRole("button", { name: "确认改名 2 项" }));

    const retry = await screen.findByRole("button", { name: "重试失败的 1 项" });
    expect(screen.getByText("已完成")).toBeInTheDocument();
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByText("已生效")).toBeInTheDocument());
    expect(mockIpc.videos.updateTitle.mock.calls.filter(([id]) => id === "v1")).toHaveLength(1);
    expect(mockIpc.videos.updateTitle.mock.calls.filter(([id]) => id === "v2")).toHaveLength(2);
  });

  it("执行中可以停止剩余批量项，之后从未完成项继续", async () => {
    let finishFirst!: () => void;
    mockIpc.videos.updateTitle
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
      )
      .mockResolvedValueOnce(undefined);
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          { kind: "propose_rename", video_id: "v1", current_title: "01", new_title: "第一讲" },
          { kind: "propose_rename", video_id: "v2", current_title: "02", new_title: "第二讲" },
        ],
      }),
    );
    renderPanel();
    await ask("批量改名");
    fireEvent.click(await screen.findByRole("button", { name: "确认改名 2 项" }));
    await waitFor(() => expect(mockIpc.videos.updateTitle).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "停止剩余" }));
    finishFirst();

    expect(await screen.findByText(/剩余 1 项尚未完成/)).toBeInTheDocument();
    expect(mockIpc.videos.updateTitle).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "跳过 第一讲" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "跳过 第二讲" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续剩余 1 项" }));

    await waitFor(() => expect(screen.getByText("已生效")).toBeInTheDocument());
    expect(mockIpc.videos.updateTitle).toHaveBeenCalledTimes(2);
    expect(mockIpc.videos.updateTitle).toHaveBeenLastCalledWith("v2", "第二讲");
  });

  it("导入要带上字幕轨和清晰度，并在之后跑流水线", async () => {
    // 之前这里只调了一次裸的下载：视频进来了，但没字幕、没分析。
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_import",
            url: "https://www.bilibili.com/video/BV1",
            title: "双曲线",
            course_id: "c1",
            course_name: "解析几何",
          },
        ],
      }),
    );
    renderPanel();
    await ask("导入这个");
    expect(await screen.findByText("导入到：解析几何")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "确认导入" }));

    await waitFor(() =>
      expect(mockIpc.tools.importBilibili).toHaveBeenCalledWith(
        "c1",
        "https://www.bilibili.com/video/BV1",
        1080,
        // 手打中文优先于 AI 中文——必须和导入对话框用同一套规则，
        // 否则同一个视频从不同入口导进来会拿到不同字幕。
        "zh-Hans",
        true,
      ),
    );
    // 有字幕就要立刻跑流水线，否则用户还得自己再点一次「开始处理」。
    await waitFor(() => expect(mockIpc.pipeline.process).toHaveBeenCalledWith("newvid"));
  });

  it("没有 cookies 时说清楚，而不是让人对着 412 猜", async () => {
    mockIpc.tools.hasBilibiliCookies.mockResolvedValueOnce(false);
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_import",
            url: "https://www.bilibili.com/video/BV1",
            title: "双曲线",
            course_id: "c1",
          },
        ],
      }),
    );
    renderPanel();
    await ask("导入这个");
    fireEvent.click(await screen.findByRole("button", { name: "确认导入" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cookies");
    expect(mockIpc.tools.importBilibili).not.toHaveBeenCalled();
  });

  it("非 B 站链接不要求 B 站 cookies", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_import",
            url: "https://www.youtube.com/watch?v=course-1",
            title: "公开课",
            course_id: "c1",
          },
        ],
      }),
    );
    renderPanel();
    await ask("导入这个公开课");
    fireEvent.click(await screen.findByRole("button", { name: "确认导入" }));

    await waitFor(() =>
      expect(mockIpc.tools.importBilibili).toHaveBeenCalledWith(
        "c1",
        "https://www.youtube.com/watch?v=course-1",
        1080,
        "zh-Hans",
        true,
      ),
    );
    expect(mockIpc.tools.hasBilibiliCookies).not.toHaveBeenCalled();
  });

  it("导入完成但流水线失败时，重试只继续处理而不重复下载", async () => {
    mockIpc.pipeline.process
      .mockRejectedValueOnce(new Error("服务暂不可用"))
      .mockResolvedValueOnce(undefined);
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_import",
            url: "https://www.bilibili.com/video/BV1",
            title: "双曲线",
            course_id: "c1",
          },
        ],
      }),
    );
    renderPanel();
    await ask("导入这个");
    fireEvent.click(await screen.findByRole("button", { name: "确认导入" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("视频已导入");
    expect(mockIpc.tools.importBilibili).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "重试失败的 1 项" }));

    await waitFor(() => expect(screen.getByText("已生效")).toBeInTheDocument());
    expect(mockIpc.tools.importBilibili).toHaveBeenCalledTimes(1);
    expect(mockIpc.pipeline.process).toHaveBeenCalledTimes(2);
    expect(mockIpc.pipeline.process).toHaveBeenNthCalledWith(2, "newvid");
  });

  it("没有课程时导入卡直说而不是提交一个必然失败的请求", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          { kind: "propose_import", url: "https://b23.tv/x", title: "线代速成", course_id: null },
        ],
      }),
    );
    renderPanel();
    await ask("把这个导进来");
    expect(await screen.findByText(/还没选课程/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认导入" })).toBeDisabled();
  });
});
