import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CourseChatPanel } from "./CourseChatPanel";

const { chat, cancelChat } = vi.hoisted(() => ({
  chat: vi.fn(),
  cancelChat: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({
  ipc: { concepts: { chat, cancelChat } },
}));

function renderPanel(courseId = "c1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onJump = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <CourseChatPanel courseId={courseId} onJump={onJump} />
    </QueryClientProvider>,
  );
  return { onJump };
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
  });

  it("shows a stop button and cancels the running answer", async () => {
    let capturedRequestId = "";
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
        return new Promise<string>(() => {}); // 一直挂起，保持流式态
      },
    );
    renderPanel();

    fireEvent.change(screen.getByRole("textbox", { name: "课程问答输入" }), {
      target: { value: "帮我复习" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    const stop = await screen.findByRole("button", { name: "停止生成" });
    fireEvent.click(stop);
    await waitFor(() => expect(cancelChat).toHaveBeenCalledWith(capturedRequestId));
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

    const source = await screen.findByRole("button", { name: "回看 第三讲 01:05" });
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
