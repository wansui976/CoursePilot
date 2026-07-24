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
  render(
    <QueryClientProvider client={queryClient}>
      <CourseChatPanel courseId={courseId} />
    </QueryClientProvider>,
  );
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

  it("suggests starter questions when there is no history", async () => {
    renderPanel();
    expect(await screen.findByText("向这门课程提问")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "这门课主要讲了什么？" })).toBeInTheDocument();
  });
});
