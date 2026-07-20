import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RagSearchPanel } from "./RagSearchPanel";

const { mockIpc, mockConfirm, platformMock } = vi.hoisted(() => ({
  mockIpc: {
    ai: {
      ragQueryStream: vi.fn(),
      cancelRagQuery: vi.fn(),
      searchTranscript: vi.fn(),
    },
  },
  mockConfirm: vi.fn(),
  platformMock: { mobile: false },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: mockConfirm }));
vi.mock("@/lib/platform", () => ({
  isMobile: () => platformMock.mobile,
  isAndroid: () => platformMock.mobile,
  isIOS: () => false,
  isTablet: () => false,
  isDesktop: () => !platformMock.mobile,
}));

type StreamEvent =
  | { type: "status"; text: string }
  | { type: "reasoning"; delta: string }
  | { type: "token"; delta: string }
  | { type: "done"; answer: string };

/** ragQueryStream 的默认 mock 实现：一次 token 后 done 并 resolve。 */
function streamResolving(answer: string) {
  return async (
    _videoId: string,
    _query: string,
    _history: unknown,
    _requestId: string,
    onEvent: (e: StreamEvent) => void,
  ) => {
    onEvent({ type: "token", delta: answer });
    onEvent({ type: "done", answer });
    return { answer, citations: [] };
  };
}

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderAskPanel(queryClient = createTestQueryClient()) {

  return render(
    <QueryClientProvider client={queryClient}>
      <div data-theme="light">
        <RagSearchPanel videoId="video-1" mode="ask" />
      </div>
    </QueryClientProvider>,
  );
}

describe("RagSearchPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    mockIpc.ai.ragQueryStream.mockReset();
    mockIpc.ai.cancelRagQuery.mockReset();
    mockIpc.ai.searchTranscript.mockReset();
    mockConfirm.mockReset();
    platformMock.mobile = false;
  });

  it("renders ask turns as chat bubbles and sends the previous turn as context", async () => {
    mockIpc.ai.ragQueryStream
      .mockImplementationOnce(streamResolving("第一轮回复"))
      .mockImplementationOnce(streamResolving("第二轮回复"));

    renderAskPanel();

    const input = screen.getByLabelText("聊天内容");

    fireEvent.change(input, { target: { value: "第一轮问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("第一轮回复")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "我的提问" })).toHaveTextContent(
      "第一轮问题",
    );
    expect(screen.getByRole("article", { name: "AI 回复" })).toHaveTextContent(
      "第一轮回复",
    );

    fireEvent.change(input, { target: { value: "第二轮问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(mockIpc.ai.ragQueryStream).toHaveBeenCalledTimes(2),
    );
    expect(mockIpc.ai.ragQueryStream).toHaveBeenNthCalledWith(
      2,
      "video-1",
      "第二轮问题",
      [
        { role: "user", content: "第一轮问题" },
        { role: "assistant", content: "第一轮回复" },
      ],
      expect.any(String),
      expect.any(Function),
    );
  });

  it("renders LaTeX in the answer with KaTeX instead of raw delimiters", async () => {
    mockIpc.ai.ragQueryStream.mockImplementation(
      streamResolving("设 \\(M_0(x_0, y_0)\\)，倾斜角 \\(\\alpha\\)。"),
    );

    renderAskPanel();

    const input = screen.getByLabelText("聊天内容");
    fireEvent.change(input, { target: { value: "参数方程" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    // KaTeX 渲染出 .katex 元素，而不是把 \(..\) 定界符当作纯文本显示。
    await waitFor(() => {
      const bubble = screen.getByRole("article", { name: "AI 回复" });
      expect(bubble.querySelector(".katex")).not.toBeNull();
    });
    const bubble = screen.getByRole("article", { name: "AI 回复" });
    expect(bubble.textContent).not.toContain("\\(");
    expect(bubble.textContent).not.toContain("\\)");
  });

  it("renders markdown (bold + list) in the answer", async () => {
    mockIpc.ai.ragQueryStream.mockImplementation(
      streamResolving("**重点**：\n- 第一条\n- 第二条"),
    );

    renderAskPanel();
    const input = screen.getByLabelText("聊天内容");
    fireEvent.change(input, { target: { value: "总结" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    const bubble = await screen.findByRole("article", { name: "AI 回复" });
    expect(bubble.querySelector("strong")?.textContent).toBe("重点");
    expect(bubble.querySelectorAll("ul > li")).toHaveLength(2);
  });

  it("offers suggested questions on empty state and sends one on tap", async () => {
    mockIpc.ai.ragQueryStream.mockImplementation(streamResolving("概要"));

    renderAskPanel();

    fireEvent.click(screen.getByRole("button", { name: "帮我总结重点" }));

    await waitFor(() =>
      expect(mockIpc.ai.ragQueryStream).toHaveBeenCalledWith(
        "video-1",
        "帮我总结重点",
        [],
        expect.any(String),
        expect.any(Function),
      ),
    );
    expect(await screen.findByText("概要")).toBeInTheDocument();
  });

  it("clears the conversation after confirming the dialog", async () => {
    mockIpc.ai.ragQueryStream.mockImplementation(streamResolving("答复"));
    mockConfirm.mockResolvedValue(true);

    renderAskPanel();

    const input = screen.getByLabelText("聊天内容");
    fireEvent.change(input, { target: { value: "问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(await screen.findByText("答复")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "清空对话" }));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("答复")).not.toBeInTheDocument());
    // 清空后回到空状态，建议问题重新出现。
    expect(screen.getByRole("button", { name: "帮我总结重点" })).toBeInTheDocument();
  });

  it("keeps the dialog-cancelled conversation intact", async () => {
    mockIpc.ai.ragQueryStream.mockImplementation(streamResolving("答复"));
    mockConfirm.mockResolvedValue(false);

    renderAskPanel();

    const input = screen.getByLabelText("聊天内容");
    fireEvent.change(input, { target: { value: "问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(await screen.findByText("答复")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "清空对话" }));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    expect(screen.getByText("答复")).toBeInTheDocument();
  });

  it("streams tokens and shows the cleaned final answer", async () => {
    mockIpc.ai.ragQueryStream.mockImplementation(
      async (
        _v: string,
        _q: string,
        _h: unknown,
        _id: string,
        onEvent: (e: StreamEvent) => void,
      ) => {
        onEvent({ type: "token", delta: "参数" });
        onEvent({ type: "token", delta: "方程" });
        onEvent({ type: "done", answer: "参数方程 [00:05]" });
        return { answer: "参数方程 [00:05]", citations: [] };
      },
    );

    renderAskPanel();
    const input = screen.getByLabelText("聊天内容");
    fireEvent.change(input, { target: { value: "问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    // 最终答案落库后渲染；[00:05] 会渲染成可点击时间戳按钮，故按 textContent 断言。
    await waitFor(() =>
      expect(screen.getByRole("article", { name: "AI 回复" })).toHaveTextContent(
        "参数方程",
      ),
    );
    expect(screen.getByRole("article", { name: "AI 回复" })).toHaveTextContent(
      "00:05",
    );
  });

  it("shows a stop button while streaming and cancels on click", async () => {
    const box: { finish?: () => void } = {};
    mockIpc.ai.ragQueryStream.mockImplementation(
      (
        _v: string,
        _q: string,
        _h: unknown,
        _id: string,
        onEvent: (e: StreamEvent) => void,
      ) =>
        new Promise((resolve) => {
          onEvent({ type: "token", delta: "生成中" });
          box.finish = () => resolve({ answer: "生成中", citations: [] });
        }),
    );

    renderAskPanel();
    const input = screen.getByLabelText("聊天内容");
    fireEvent.change(input, { target: { value: "问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    const stop = await screen.findByRole("button", { name: "停止生成" });
    fireEvent.click(stop);
    expect(mockIpc.ai.cancelRagQuery).toHaveBeenCalledTimes(1);
    // 收尾，避免悬挂 promise。
    box.finish?.();
  });

  it("can cancel a pending answer after the panel remounts", async () => {
    const box: { finish?: () => void } = {};
    mockIpc.ai.ragQueryStream.mockImplementation(
      (
        _v: string,
        _q: string,
        _h: unknown,
        _id: string,
      ) =>
        new Promise((resolve) => {
          box.finish = () => resolve({ answer: "完成", citations: [] });
        }),
    );
    const queryClient = createTestQueryClient();
    const first = renderAskPanel(queryClient);

    const input = screen.getByLabelText("聊天内容");
    fireEvent.change(input, { target: { value: "问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(mockIpc.ai.ragQueryStream).toHaveBeenCalledTimes(1));
    const requestId = mockIpc.ai.ragQueryStream.mock.calls[0]?.[3] as string;

    first.unmount();
    renderAskPanel(queryClient);
    fireEvent.click(await screen.findByRole("button", { name: "停止生成" }));

    expect(mockIpc.ai.cancelRagQuery).toHaveBeenCalledWith(requestId);
    box.finish?.();
  });

  it("uses a fresh request id when retrying a failed answer", async () => {
    mockIpc.ai.ragQueryStream
      .mockRejectedValueOnce(new Error("网络失败"))
      .mockImplementationOnce(streamResolving("重试成功"));

    renderAskPanel();
    const input = screen.getByLabelText("聊天内容");
    fireEvent.change(input, { target: { value: "问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByText("重试成功")).toBeInTheDocument();

    const firstId = mockIpc.ai.ragQueryStream.mock.calls[0]?.[3];
    const retryId = mockIpc.ai.ragQueryStream.mock.calls[1]?.[3];
    expect(firstId).not.toBe(retryId);
  });

  it("streams reasoning-model thinking into a 思考过程 area", async () => {
    const box: { finish?: () => void } = {};
    mockIpc.ai.ragQueryStream.mockImplementation(
      (
        _v: string,
        _q: string,
        _h: unknown,
        _id: string,
        onEvent: (e: StreamEvent) => void,
      ) =>
        new Promise((resolve) => {
          onEvent({ type: "reasoning", delta: "先分析题目…" });
          box.finish = () => resolve({ answer: "答案", citations: [] });
        }),
    );

    renderAskPanel();
    const input = screen.getByLabelText("聊天内容");
    fireEvent.change(input, { target: { value: "问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    // 思考阶段：显示「思考过程」并流式展示推理内容（此时还没有正式答案）。
    expect(await screen.findByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("先分析题目…")).toBeInTheDocument();
    box.finish?.();
  });

  it("keeps the reasoning with the answer in history after completion", async () => {
    mockIpc.ai.ragQueryStream.mockImplementation(
      async (
        _v: string,
        _q: string,
        _h: unknown,
        _id: string,
        onEvent: (e: StreamEvent) => void,
      ) => {
        onEvent({ type: "reasoning", delta: "推理片段" });
        onEvent({ type: "token", delta: "最终答案" });
        onEvent({ type: "done", answer: "最终答案" });
        return { answer: "最终答案", citations: [] };
      },
    );

    renderAskPanel();
    const input = screen.getByLabelText("聊天内容");
    fireEvent.change(input, { target: { value: "问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    // 完成落库后：答案 + 思考过程都随该轮保留（思考默认折叠但内容在 DOM 里）。
    await waitFor(() => {
      const bubble = screen.getByRole("article", { name: "AI 回复" });
      expect(bubble).toHaveTextContent("思考过程");
    });
    const bubble = screen.getByRole("article", { name: "AI 回复" });
    expect(bubble).toHaveTextContent("推理片段");
    expect(bubble).toHaveTextContent("最终答案");
  });

  it("shows a streaming caret while generating", async () => {
    const box: { finish?: () => void } = {};
    mockIpc.ai.ragQueryStream.mockImplementation(
      (
        _v: string,
        _q: string,
        _h: unknown,
        _id: string,
        onEvent: (e: StreamEvent) => void,
      ) =>
        new Promise((resolve) => {
          onEvent({ type: "token", delta: "生成中" });
          box.finish = () => resolve({ answer: "生成中", citations: [] });
        }),
    );

    renderAskPanel();
    const input = screen.getByLabelText("聊天内容");
    fireEvent.change(input, { target: { value: "问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    // 流式进行中，末尾光标可见。
    expect(await screen.findByTestId("stream-caret")).toBeInTheDocument();
    box.finish?.();
  });

  it("auto-scrolls as tokens stream in", async () => {
    const scrollSpy = vi.fn();
    // jsdom 默认没实现 scrollIntoView；装一个 spy 以断言被调用。
    Element.prototype.scrollIntoView = scrollSpy;

    const box: { on?: (e: StreamEvent) => void; finish?: () => void } = {};
    mockIpc.ai.ragQueryStream.mockImplementation(
      (
        _v: string,
        _q: string,
        _h: unknown,
        _id: string,
        onEvent: (e: StreamEvent) => void,
      ) =>
        new Promise((resolve) => {
          box.on = onEvent;
          box.finish = () => resolve({ answer: "第一段第二段", citations: [] });
          onEvent({ type: "token", delta: "第一段" });
        }),
    );

    renderAskPanel();
    const input = screen.getByLabelText("聊天内容");
    fireEvent.change(input, { target: { value: "问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await screen.findByText("第一段");
    const before = scrollSpy.mock.calls.length;
    // 再来一段 token：文本增长（history/busy 未变）也应再次滚动到底。
    act(() => box.on?.({ type: "token", delta: "第二段" }));
    await waitFor(() =>
      expect(scrollSpy.mock.calls.length).toBeGreaterThan(before),
    );
    box.finish?.();
  });

  it("renders an icon-only copy button that copies the answer (desktop)", async () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    mockIpc.ai.ragQueryStream.mockImplementation(streamResolving("要复制的答案"));

    renderAskPanel();
    const input = screen.getByLabelText("聊天内容");
    fireEvent.change(input, { target: { value: "问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    const copyBtn = await screen.findByRole("button", { name: "复制回答" });
    // 只保留图标：按钮无「复制/已复制」文字。
    expect(copyBtn.textContent).toBe("");
    fireEvent.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith("要复制的答案");
  });

  it("reveals the copy button on long-press on touch devices", async () => {
    platformMock.mobile = true;
    mockIpc.ai.ragQueryStream.mockImplementation(streamResolving("答案"));

    renderAskPanel();
    const input = screen.getByLabelText("聊天内容");
    fireEvent.change(input, { target: { value: "问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    const bubble = await screen.findByRole("article", { name: "AI 回复" });
    const copyBtn = screen.getByRole("button", { name: "复制回答" });
    // 触屏默认隐藏（不可点）。
    expect(copyBtn.className).toContain("opacity-0");

    // 长按气泡 ~0.5s 后显示（用真实计时器，避免 fake timers 全局泄漏）。
    fireEvent.touchStart(bubble);
    await waitFor(() => expect(copyBtn.className).toContain("opacity-100"), {
      timeout: 1500,
    });
  });

  it("streams under React StrictMode (mounted gate must survive double-mount)", async () => {
    // 回归：main.tsx 里 App 包在 <StrictMode>，dev 下组件「挂载→卸载→再挂载」。
    // mountedRef 若只在 cleanup 置 false、不在 body 置回 true，重挂载后永久为
    // false，所有流式事件被静默丢弃——表现为「三个点不动，答案最后一次性蹦出」。
    const box: { finish?: () => void } = {};
    mockIpc.ai.ragQueryStream.mockImplementation(
      (
        _v: string,
        _q: string,
        _h: unknown,
        _id: string,
        onEvent: (e: StreamEvent) => void,
      ) =>
        new Promise((resolve) => {
          onEvent({ type: "reasoning", delta: "先想想…" });
          onEvent({ type: "token", delta: "答案开头" });
          box.finish = () => resolve({ answer: "答案开头", citations: [] });
        }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <div data-theme="light">
            <RagSearchPanel videoId="video-1" mode="ask" />
          </div>
        </QueryClientProvider>
      </StrictMode>,
    );

    const input = screen.getByLabelText("聊天内容");
    fireEvent.change(input, { target: { value: "问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    // 流式进行中：思考过程与已生成的正文都应实时可见。
    expect(await screen.findByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("先想想…")).toBeInTheDocument();
    expect(screen.getByText("答案开头")).toBeInTheDocument();
    box.finish?.();
  });

  it("search mode: labels the results region and offers retry on failure", async () => {
    mockIpc.ai.searchTranscript
      .mockRejectedValueOnce(new Error("索引未就绪"))
      .mockResolvedValueOnce([]);

    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <div data-theme="light">
          <RagSearchPanel videoId="video-1" mode="search" />
        </div>
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText("搜索结果")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索文稿内容"), {
      target: { value: "关键词" },
    });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    const retry = await screen.findByRole("button", { name: "重试" });
    fireEvent.click(retry);

    // 重试用同一 query 再次调用（第一次失败、第二次成功）。
    await waitFor(() =>
      expect(mockIpc.ai.searchTranscript).toHaveBeenCalledTimes(2),
    );
    expect(mockIpc.ai.searchTranscript).toHaveBeenNthCalledWith(2, "video-1", "关键词");
  });
});
