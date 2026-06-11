import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RagSearchPanel } from "./RagSearchPanel";

const { mockIpc, mockConfirm } = vi.hoisted(() => ({
  mockIpc: {
    ai: {
      ragQuery: vi.fn(),
      searchTranscript: vi.fn(),
    },
  },
  mockConfirm: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: mockConfirm }));

function renderAskPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

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
    mockIpc.ai.ragQuery.mockReset();
    mockIpc.ai.searchTranscript.mockReset();
    mockConfirm.mockReset();
  });

  it("renders ask turns as chat bubbles and sends the previous turn as context", async () => {
    mockIpc.ai.ragQuery
      .mockResolvedValueOnce({ answer: "第一轮回复", citations: [] })
      .mockResolvedValueOnce({ answer: "第二轮回复", citations: [] });

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

    await waitFor(() => expect(mockIpc.ai.ragQuery).toHaveBeenCalledTimes(2));
    expect(mockIpc.ai.ragQuery).toHaveBeenNthCalledWith(2, "video-1", "第二轮问题", [
      { role: "user", content: "第一轮问题" },
      { role: "assistant", content: "第一轮回复" },
    ]);
  });

  it("offers suggested questions on empty state and sends one on tap", async () => {
    mockIpc.ai.ragQuery.mockResolvedValueOnce({ answer: "概要", citations: [] });

    renderAskPanel();

    fireEvent.click(screen.getByRole("button", { name: "帮我总结重点" }));

    await waitFor(() =>
      expect(mockIpc.ai.ragQuery).toHaveBeenCalledWith("video-1", "帮我总结重点", []),
    );
    expect(await screen.findByText("概要")).toBeInTheDocument();
  });

  it("clears the conversation after confirming the dialog", async () => {
    mockIpc.ai.ragQuery.mockResolvedValueOnce({ answer: "答复", citations: [] });
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
    mockIpc.ai.ragQuery.mockResolvedValueOnce({ answer: "答复", citations: [] });
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
});
