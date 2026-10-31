import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChaptersPanel } from "./ChaptersPanel";

const { mockIpc, player, feynman } = vi.hoisted(() => ({
  mockIpc: {
    ai: {
      getChapters: vi.fn(),
      generate: vi.fn(),
    },
  },
  player: { requestSeek: vi.fn() },
  feynman: { open: vi.fn() },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/stores/feynman", () => ({
  useFeynman: { getState: () => feynman },
}));
vi.mock("@/stores/player", () => {
  const usePlayer = (selector: (s: typeof player) => unknown) => selector(player);
  usePlayer.getState = () => player;
  return { usePlayer };
});

function renderChaptersPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChaptersPanel videoId="video-1" />
    </QueryClientProvider>,
  );
}

describe("ChaptersPanel", () => {
  beforeEach(() => {
    mockIpc.ai.getChapters.mockReset();
    mockIpc.ai.generate.mockReset();
    player.requestSeek.mockReset();
    feynman.open.mockReset();
    localStorage.clear();
  });

  it("shows a loading skeleton instead of the empty state while chapters load", () => {
    // 查询挂起：加载中不应闪现「还没有章节」（该文案会误导已有章节的视频）。
    mockIpc.ai.getChapters.mockReturnValue(new Promise(() => {}));
    const { container } = renderChaptersPanel();

    expect(screen.queryByText(/还没有章节/)).not.toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("shows the empty state only after loading resolves with no chapters", async () => {
    mockIpc.ai.getChapters.mockResolvedValue([]);
    renderChaptersPanel();

    // 走共用的面板空态：会被读屏播报，且各面板的「还什么都没有」长得一样——
    // 此前这里是一段贴在左上角的裸段落，与隔壁页签各写各的。
    const empty = await screen.findByText(/还没有章节/);
    expect(empty.closest('[role="status"]')).toHaveClass("ca-empty-state");
  });

  it("renders chapters and seeks on click", async () => {
    mockIpc.ai.getChapters.mockResolvedValue([
      { id: "c1", start_ms: 5000, title: "开场", summary: "介绍" },
    ]);
    renderChaptersPanel();

    const chapter = await screen.findByText("开场");
    chapter.closest("button")!.click();

    await waitFor(() => {
      expect(player.requestSeek).toHaveBeenCalledWith(5000);
    });
  });

  it("offers one text button to pick a chapter instead of a mic on every chapter", async () => {
    mockIpc.ai.getChapters.mockResolvedValue([
      { id: "c1", start_ms: 0, end_ms: 10_000, title: "开场", summary: "介绍" },
      { id: "c2", start_ms: 10_000, end_ms: 20_000, title: "第二讲", summary: "继续" },
    ]);
    renderChaptersPanel();

    const entry = await screen.findByRole("button", { name: "费曼复述" });
    expect(screen.getAllByRole("button", { name: "费曼复述" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /讲给我听/ })).not.toBeInTheDocument();

    fireEvent.click(entry);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /第二讲/ }));

    expect(feynman.open).toHaveBeenCalledWith(
      { kind: "range", video_id: "video-1", start_ms: 10_000, end_ms: 20_000, title: "第二讲" },
      "第二讲",
      "video-1",
    );
  });

  it("shows a retryable read error instead of the empty state or generation entry", async () => {
    mockIpc.ai.getChapters
      .mockRejectedValueOnce(new Error("章节读取失败"))
      .mockResolvedValueOnce([]);

    renderChaptersPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent("章节读取失败");
    expect(screen.queryByText(/还没有章节/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(mockIpc.ai.getChapters).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/还没有章节/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成" })).toBeInTheDocument();
  });
});
