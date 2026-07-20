import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChaptersPanel } from "./ChaptersPanel";

const { mockIpc, player } = vi.hoisted(() => ({
  mockIpc: {
    ai: {
      getChapters: vi.fn(),
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

    expect(await screen.findByText(/还没有章节/)).toBeInTheDocument();
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
});
