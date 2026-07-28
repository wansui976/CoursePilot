import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SummaryPanel } from "./SummaryPanel";

const { mockIpc, player } = vi.hoisted(() => ({
  mockIpc: {
    ai: {
      getSummary: vi.fn(),
      generate: vi.fn(),
      staleArtifacts: vi.fn(),
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
    mockIpc.ai.staleArtifacts.mockReset().mockResolvedValue([]);
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

  it("marks the summary stale when it was written from an older transcript", async () => {
    // 改过字幕之后，这份摘要讲的还是旧稿的内容，界面上却看不出任何区别。
    // 只标记不自动重跑：重跑要花钱，跑不跑由用户决定。
    mockIpc.ai.getSummary.mockResolvedValue("旧稿写出来的摘要");
    mockIpc.ai.staleArtifacts.mockResolvedValue(["summary"]);

    renderSummaryPanel();

    expect(await screen.findByText("已过期")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重新生成" }),
    ).toHaveAttribute("title", "字幕已更新：用新稿重新生成");
  });

  it("says nothing when the summary still matches the transcript", async () => {
    mockIpc.ai.getSummary.mockResolvedValue("最新的摘要");
    mockIpc.ai.staleArtifacts.mockResolvedValue([]);

    renderSummaryPanel();

    await screen.findByText("最新的摘要");
    expect(screen.queryByText("已过期")).not.toBeInTheDocument();
  });
});
