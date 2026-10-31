import "@/i18n";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHighlightPrefs } from "@/stores/highlightPrefs";
import { useHighlights } from "./useHighlights";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: { ai: { getHighlights: vi.fn(), generate: vi.fn() } },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

const segments = [
  { start_ms: 60_000, end_ms: 120_000, kind: "chitchat", level: 1, reason: "聊周末" },
  { start_ms: 300_000, end_ms: 330_000, kind: "repeat", level: 3, reason: "" },
];

function setup(maxRate?: number, baseRate?: number) {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useHighlights("v1", { maxRate, baseRate }), { wrapper });
}

function fakeVideo(currentTime: number) {
  return { currentTime, paused: false, seeking: false } as HTMLVideoElement;
}

describe("useHighlights", () => {
  beforeEach(() => {
    localStorage.clear();
    useHighlightPrefs.setState({ mode: "off", strength: 2, kept: {} });
    mockIpc.ai.getHighlights.mockResolvedValue(segments);
  });

  it("跳过档：落进水分段跳到段尾、给出带撤回的提示；撤回回到段首并记住这段有用", async () => {
    useHighlightPrefs.setState({ mode: "skip" });
    const { result } = setup();
    await waitFor(() => expect(result.current.available).toBe(true));
    // 力度「中」：把握 3 的那段不算。
    expect(result.current.segments).toHaveLength(1);

    const video = fakeVideo(65);
    let jumped = false;
    act(() => {
      jumped = result.current.handleTimeUpdate(video);
    });
    expect(jumped).toBe(true);
    expect(video.currentTime).toBe(120);
    expect(result.current.notice?.text).toBe("已跳过 55 秒 · 聊周末");

    act(() => result.current.notice!.onAction());
    expect(video.currentTime).toBe(60);
    expect(useHighlightPrefs.getState().kept.v1).toEqual([60_000]);
    expect(result.current.segments).toHaveLength(0);
    expect(result.current.handleTimeUpdate(fakeVideo(65))).toBe(false);
  });

  it("快放档：段内给快放倍速（Apple 内核封顶 2x），段外为 null；省下的时间按基础倍速算", async () => {
    useHighlightPrefs.setState({ mode: "fast", strength: 3 });
    const { result } = setup(2);
    await waitFor(() => expect(result.current.available).toBe(true));
    let rate: number | null = null;
    act(() => {
      rate = result.current.rateFor(70_000);
    });
    expect(rate).toBe(2);
    expect(result.current.notice?.text).toBe("快放中 · 聊周末");
    expect(result.current.rateFor(200_000)).toBeNull();
    // 没写理由的段落用类型名。
    act(() => {
      result.current.rateFor(310_000);
    });
    expect(result.current.notice?.text).toBe("快放中 · 重复讲解");
    // 基础 1x、快放 2x：90 秒水分省下 45 秒。
    expect(result.current.savedMs(1)).toBe(45_000);
  });

  it("关着时什么都不做", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.handleTimeUpdate(fakeVideo(65))).toBe(false);
    expect(result.current.rateFor(70_000)).toBeNull();
  });

  it("跳过档：手动拖进水分段时放过这一整段，别把「后退」弹回去", async () => {
    useHighlightPrefs.setState({ mode: "skip" });
    const { result } = setup();
    await waitFor(() => expect(result.current.available).toBe(true));

    // 用户拖进度条 / 按 ← 落到 65s：播放器在 onSeeking 里 noteSeek。
    act(() => result.current.noteSeek());
    const seeked = fakeVideo(65);
    expect(result.current.handleTimeUpdate(seeked)).toBe(false);
    expect(seeked.currentTime).toBe(65);
    // 继续在这一段里播：仍然放行，直到段尾。
    expect(result.current.handleTimeUpdate(fakeVideo(70))).toBe(false);
    // 离开这一段之后恢复跳过：下一次自然播进新的水分段照跳。
    expect(result.current.handleTimeUpdate(fakeVideo(200))).toBe(false);
  });

  it("快放档：基础倍速已经比快放档快时不降速，也不冒充「快放中」", async () => {
    useHighlightPrefs.setState({ mode: "fast", strength: 3 });
    // 用户本来就开着 2x + 智能倍速 1.5 → 有效 3x，快放档只有 2.5x。
    const { result } = setup(undefined, 3);
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.rateFor(70_000)).toBeNull();
    expect(result.current.notice).toBeNull();
  });
});
