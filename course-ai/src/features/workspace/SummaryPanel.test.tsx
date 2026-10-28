import "@/i18n";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SummaryPanel } from "./SummaryPanel";

const { mockIpc, player } = vi.hoisted(() => ({
  mockIpc: {
    ai: {
      getSummary: vi.fn(),
      generate: vi.fn(),
    },
  },
  player: { requestSeek: vi.fn() },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/stores/player", () => {
  const usePlayer = (selector: (s: typeof player) => unknown) => selector(player);
  usePlayer.getState = () => player;
  return { usePlayer };
});

function renderSummaryPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SummaryPanel videoId="video-1" />
    </QueryClientProvider>,
  );
}

describe("SummaryPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    mockIpc.ai.getSummary.mockReset();
    mockIpc.ai.generate.mockReset();
    mockIpc.ai.getSummary.mockResolvedValue("这是整体摘要正文。");
  });

  it("collapses the summary body so chapters can take the height, and persists the choice", async () => {
    renderSummaryPanel();
    expect(await screen.findByText("这是整体摘要正文。")).toBeInTheDocument();

    const header = screen.getByRole("button", { name: /整体摘要/ });
    expect(header).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(header);

    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("这是整体摘要正文。")).not.toBeInTheDocument();
    // 折叠是全局偏好，写入 localStorage 以便下次保持。
    expect(localStorage.getItem("course-ai-summary-collapsed")).toBe("1");
  });

  it("starts collapsed when the stored preference says so", () => {
    localStorage.setItem("course-ai-summary-collapsed", "1");
    renderSummaryPanel();

    expect(screen.getByRole("button", { name: /整体摘要/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("shows a retryable read error instead of the empty state or generation entry", async () => {
    mockIpc.ai.getSummary
      .mockRejectedValueOnce(new Error("摘要读取失败"))
      .mockResolvedValueOnce(null);

    renderSummaryPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent("摘要读取失败");
    expect(screen.queryByText(/还没有摘要/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(mockIpc.ai.getSummary).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/还没有摘要/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成" })).toBeInTheDocument();
  });

  it("keeps a read error visible while the summary is collapsed", async () => {
    localStorage.setItem("course-ai-summary-collapsed", "1");
    mockIpc.ai.getSummary.mockRejectedValueOnce(new Error("折叠时读取失败"));

    renderSummaryPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent("折叠时读取失败");
    expect(screen.queryByRole("button", { name: "生成" })).not.toBeInTheDocument();
  });
});
