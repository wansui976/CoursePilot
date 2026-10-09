import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    usePlayer.setState({ currentMs: 30_000, durationMs: 60_000 });
    renderProgressBar({ onSeek });
    const slider = screen.getByRole("slider", { name: "播放进度" });
    expect(slider).toHaveAttribute("max", "60000");
    expect(slider).toHaveAttribute("step", "1");
    expect(slider).toHaveAttribute("aria-valuetext", "00:30 / 01:00");
    expect(slider).toHaveValue("30000");
  });

  it("keeps millisecond precision when seeking via the native range input", () => {
    const onSeek = vi.fn();
    usePlayer.setState({ currentMs: 30_000, durationMs: 60_000 });
    renderProgressBar({ onSeek });

    fireEvent.change(screen.getByRole("slider", { name: "播放进度" }), {
      target: { value: "45123" },
    });
    expect(onSeek).toHaveBeenCalledWith(45_123);
  });

  it("seeks in useful increments without moving focus away from the slider", () => {
    const onSeek = vi.fn();
    usePlayer.setState({ currentMs: 30_000, durationMs: 60_000 });
    renderProgressBar({ onSeek });
    const slider = screen.getByRole("slider", { name: "播放进度" });
    slider.focus();

    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "ArrowDown" });
    fireEvent.keyDown(slider, { key: "ArrowUp" });
    fireEvent.keyDown(slider, { key: "PageDown" });
    fireEvent.keyDown(slider, { key: "PageUp" });
    fireEvent.keyDown(slider, { key: "Home" });
    fireEvent.keyDown(slider, { key: "End" });

    expect(onSeek.mock.calls.map(([ms]) => ms)).toEqual([
      25_000,
      35_000,
      25_000,
      35_000,
      20_000,
      40_000,
      0,
      60_000,
    ]);
    expect(slider).toHaveFocus();
  });

  it("clamps keyboard seeks to the media bounds", () => {
    const onSeek = vi.fn();
    usePlayer.setState({ currentMs: 1_000, durationMs: 60_000 });
    renderProgressBar({ onSeek });
    const slider = screen.getByRole("slider", { name: "播放进度" });

    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    act(() => usePlayer.setState({ currentMs: 59_000 }));
    fireEvent.keyDown(slider, { key: "ArrowRight" });

    expect(onSeek).toHaveBeenNthCalledWith(1, 0);
    expect(onSeek).toHaveBeenNthCalledWith(2, 60_000);
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

  it("draws a danmaku heat curve with clickable peaks when danmaku is passed", () => {
    const onSeek = vi.fn();
    usePlayer.setState({ currentMs: 0, durationMs: 600_000 });
    const danmaku = [
      ...Array.from({ length: 40 }, (_, i) => i * 15_000),
      ...Array.from({ length: 100 }, (_, i) => 300_000 + i),
    ].map((start_ms) => ({
      mode: "scroll" as const,
      start_ms,
      text: "前方高能",
      color: null,
      font_size: null,
    }));
    renderProgressBar({ onSeek, danmaku });

    expect(screen.getByTestId("danmaku-heat")).toBeInTheDocument();
    const peak = screen.getByRole("button", { name: /^弹幕高峰 05:0/ });
    fireEvent.click(peak);
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek.mock.calls[0][0]).toBeGreaterThanOrEqual(300_000);
    expect(onSeek.mock.calls[0][0]).toBeLessThan(305_000);
  });

  it("skips the heat curve when there are too few danmaku", () => {
    renderProgressBar({
      danmaku: [{ mode: "scroll", start_ms: 1000, text: "hi", color: null, font_size: null }],
    });
    expect(screen.queryByTestId("danmaku-heat")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /弹幕高峰/ })).not.toBeInTheDocument();
  });
});
