import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProgressBar } from "./ProgressBar";
import i18n from "@/i18n";
import { usePlayer } from "@/stores/player";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    ai: { getChapters: vi.fn() },
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

function renderProgressBar(props: Partial<Parameters<typeof ProgressBar>[0]> = {}) {
  const base = {
    videoId: "video-1",
    skipRanges: [],
    onSeek: vi.fn(),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProgressBar {...base} {...props} />
    </QueryClientProvider>,
  );
}

describe("ProgressBar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    usePlayer.setState({ currentMs: 0, durationMs: 60_000 });
    mockIpc.ai.getChapters.mockReset().mockResolvedValue([]);
  });

  it("exposes a keyboard-accessible seek slider", () => {
    const onSeek = vi.fn();
    renderProgressBar({ onSeek });
    const slider = screen.getByRole("slider", { name: "播放进度" });
    expect(slider).toHaveAttribute("max", "60000");
    expect(slider).toHaveValue("0");
  });

  it("seeks via the native range input", () => {
    const onSeek = vi.fn();
    usePlayer.setState({ currentMs: 30_000, durationMs: 60_000 });
    renderProgressBar({ onSeek });

    fireEvent.change(screen.getByRole("slider", { name: "播放进度" }), {
      target: { value: "45" },
    });
    expect(onSeek).toHaveBeenCalledWith(45);
  });

  it("renders chapter tick marks from the shared chapters query", async () => {
    mockIpc.ai.getChapters.mockResolvedValue([
      { id: 1, video_id: "v1", title: "开场", summary: null, start_ms: 0, end_ms: 10_000, order_index: 0 },
      { id: 2, video_id: "v1", title: "主体", summary: null, start_ms: 10_000, end_ms: 60_000, order_index: 1 },
    ]);
    const { container } = renderProgressBar();
    // 章节刻度是绝对定位的 w-px 竖线，位于视觉轨 overlay 内；等章节查询解析。
    await waitFor(() => {
      expect(container.querySelectorAll(".w-px")).toHaveLength(2);
    });
  });
});
