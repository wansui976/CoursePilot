import "@/i18n";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CourseChatPanel } from "./CourseChatPanel";

const { chat, cancelChat } = vi.hoisted(() => ({
  chat: vi.fn(),
  cancelChat: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({
  ipc: { concepts: { chat, cancelChat } },
}));

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderPanel(courseId = "c1", queryClient = createTestQueryClient()) {
  const onJump = vi.fn();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CourseChatPanel courseId={courseId} onJump={onJump} />
    </QueryClientProvider>,
  );
  return { onJump, queryClient, ...view };
}

describe("CourseChatPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    chat.mockReset();
    cancelChat.mockReset().mockResolvedValue(undefined);
  });

  it("streams a grounded answer and keeps it in history", async () => {
    chat.mockImplementation(
      async (
        _courseId: string,
        _query: string,
        _history: unknown,
        _requestId: string,
        onEvent: (e: { type: string; delta?: string }) => void,
      ) => {
        onEvent({ type: "token", delta: "本课程" });
        onEvent({ type: "token", delta: "讲了概率判断。" });
        return "本课程讲了概率判断。";
      },
    );
    renderPanel();

    fireEvent.change(screen.getByRole("textbox", { name: "课程问答输入" }), {
      target: { value: "这门课讲了什么？" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(chat).toHaveBeenCalledWith(
        "c1",
        "这门课讲了什么？",
        [],
        expect.any(String),
        expect.any(Function),
      ),
    );
    // 问题与流式答案都进入对话。
    expect(await screen.findByText("这门课讲了什么？")).toBeInTheDocument();
    expect(await screen.findByText(/本课程讲了概率判断/)).toBeInTheDocument();
    const log = screen.getByRole("log", { name: "课程问答记录" });
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(log).toHaveAttribute("aria-relevant", "additions");
    expect(log).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("status")).toHaveTextContent("回答已生成");
  });

  it("shows a stop button and cancels the running answer", async () => {
    let capturedRequestId = "";
    let finish: (() => void) | undefined;
    chat.mockImplementation(
      (
        _courseId: string,
        _query: string,
        _history: unknown,
        requestId: string,
        onEvent: (e: { type: string; delta?: string }) => void,
      ) => {
        capturedRequestId = requestId;
        onEvent({ type: "token", delta: "正在整理…" });
        return new Promise<string>((resolve) => {
          finish = () => resolve("正在整理…");
        });
      },
    );
    renderPanel();

    fireEvent.change(screen.getByRole("textbox", { name: "课程问答输入" }), {
      target: { value: "帮我复习" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    const stop = await screen.findByRole("button", { name: "停止生成" });
    expect(screen.getByRole("log", { name: "课程问答记录" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在生成回答");
    fireEvent.click(stop);
    await waitFor(() => expect(cancelChat).toHaveBeenCalledWith(capturedRequestId));
    await act(async () => finish?.());
  });

  it("restores one pending stream after remount, prevents duplicates, then shows its result", async () => {
    let emit: ((event: { type: string; delta?: string }) => void) | undefined;
    let finish: (() => void) | undefined;
    let requestId = "";
    chat.mockImplementation(
      (
        _courseId: string,
        _query: string,
        _history: unknown,
        activeRequestId: string,
        onEvent: (event: { type: string; delta?: string }) => void,
      ) => {
        requestId = activeRequestId;
        return new Promise<string>((resolve) => {
          emit = onEvent;
          finish = () => resolve("抽屉关闭期间仍在生成，最终完成。");
        });
      },
    );
    const queryClient = createTestQueryClient();
    const first = renderPanel("c1", queryClient);

    fireEvent.change(screen.getByRole("textbox", { name: "课程问答输入" }), {
      target: { value: "跨抽屉问题" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    act(() => emit?.({ type: "token", delta: "抽屉关闭期间" }));
    expect(await screen.findByText(/抽屉关闭期间/)).toBeInTheDocument();

    first.unmount();
    act(() => emit?.({ type: "token", delta: "仍在生成" }));
    const second = renderPanel("c1", queryClient);

    expect(await screen.findByText("跨抽屉问题")).toBeInTheDocument();
    expect(await screen.findByText(/抽屉关闭期间仍在生成/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
    await waitFor(() => expect(cancelChat).toHaveBeenCalledWith(requestId));
    expect(screen.getByRole("log", { name: "课程问答记录" })).toHaveAttribute(
      "aria-busy",
      "true",
    );

    const input = screen.getByRole("textbox", { name: "课程问答输入" });
    // 聚焦提示走柔和的 border-strong，不再用整圈 focus-ring 蓝。
    expect(input.parentElement).toHaveClass("focus-within:border-[var(--border-strong)]");
    fireEvent.change(input, { target: { value: "不能重复提交" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(chat).toHaveBeenCalledTimes(1);

    second.unmount();
    await act(async () => finish?.());
    await waitFor(() =>
      expect(localStorage.getItem("course-ai-course-chat:c1")).toContain("最终完成"),
    );
    renderPanel("c1", queryClient);

    expect(await screen.findByText("抽屉关闭期间仍在生成，最终完成。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止生成" })).not.toBeInTheDocument();
    expect(screen.getByRole("log", { name: "课程问答记录" })).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("restores an error after remount and retries it with a fresh request id", async () => {
    let fail: ((error: Error) => void) | undefined;
    chat
      .mockImplementationOnce(
        () =>
          new Promise<string>((_resolve, reject) => {
            fail = reject;
          }),
      )
      .mockImplementationOnce(
        async (
          _courseId: string,
          _query: string,
          _history: unknown,
          _requestId: string,
          onEvent: (event: { type: string; delta?: string }) => void,
        ) => {
          onEvent({ type: "token", delta: "重试后的答案" });
          return "重试后的答案";
        },
      );
    const queryClient = createTestQueryClient();
    const first = renderPanel("c1", queryClient);

    fireEvent.change(screen.getByRole("textbox", { name: "课程问答输入" }), {
      target: { value: "失败后恢复" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    const firstRequestId = chat.mock.calls[0]?.[3];
    first.unmount();
    await act(async () => fail?.(new Error("网络失败")));

    renderPanel("c1", queryClient);
    expect(await screen.findByText("失败后恢复")).toBeInTheDocument();
    expect(await screen.findByText("网络失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() =>
      expect(localStorage.getItem("course-ai-course-chat:c1")).toContain("重试后的答案"),
    );
    await waitFor(() =>
      expect(screen.getByRole("log", { name: "课程问答记录" })).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );
    expect(screen.getByText("重试后的答案")).toBeInTheDocument();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1]?.[3]).not.toBe(firstRequestId);
  });

  it("lists the sources behind an answer and jumps to that lecture moment", async () => {
    chat.mockImplementation(
      async (
        _courseId: string,
        _query: string,
        _history: unknown,
        _requestId: string,
        onEvent: (e: unknown) => void,
      ) => {
        onEvent({
          type: "citations",
          citations: [
            {
              index: 1,
              text: "先验概率会随着新的证据被更新。",
              start_ms: 65000,
              end_ms: 70000,
              video_id: "v1",
              video_title: "第三讲.mp4",
            },
          ],
        });
        onEvent({ type: "token", delta: "先验会被证据更新。" });
        return "先验会被证据更新。";
      },
    );
    const { onJump } = renderPanel();

    fireEvent.change(screen.getByRole("textbox", { name: "课程问答输入" }), {
      target: { value: "贝叶斯定理是什么" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(screen.getByRole("log", { name: "课程问答记录" })).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );
    const source = screen.getByRole("button", { name: "回看 第三讲 01:05" });
    // 标题去掉扩展名后展示，摘录带上，才能判断这条出处值不值得点。
    expect(source).toHaveTextContent("第三讲");
    expect(source).toHaveTextContent("先验概率会随着新的证据被更新。");
    fireEvent.click(source);
    expect(onJump).toHaveBeenCalledWith("v1", 65000);
  });

  it("keeps the sources with the answer in history", async () => {
    localStorage.setItem(
      "course-ai-course-chat:c1",
      JSON.stringify([
        {
          id: "t1",
          query: "旧问题",
          answer: "旧答案",
          citations: [
            {
              index: 1,
              text: "旧摘录",
              start_ms: 1000,
              end_ms: 2000,
              video_id: "v9",
              video_title: "第一讲",
            },
          ],
        },
        // 来源字段形状不对的坏记录：按「没有来源」渲染，不能拖垮整段历史。
        { id: "t2", query: "另一个问题", answer: "另一个答案", citations: "坏数据" },
      ]),
    );
    const { onJump } = renderPanel();

    expect(await screen.findByText("旧答案")).toBeInTheDocument();
    expect(await screen.findByText("另一个答案")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回看 第一讲 00:01" }));
    expect(onJump).toHaveBeenCalledWith("v9", 1000);
  });

  it("suggests starter questions when there is no history", async () => {
    renderPanel();
    expect(await screen.findByText("向这门课程提问")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "这门课主要讲了什么？" })).toBeInTheDocument();
  });
});
