import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSilenceSkip } from "./useSilenceSkip";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: { videos: { skips: vi.fn() } },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

function fakeVideo(seconds: number) {
  return {
    currentTime: seconds,
    paused: false,
    seeking: false,
  } as HTMLVideoElement;
}

describe("useSilenceSkip", () => {
  beforeEach(() => {
    localStorage.clear();
    mockIpc.videos.skips.mockReset().mockResolvedValue([
      { start_ms: 10_000, end_ms: 20_000 },
    ]);
  });

  it("does not scan the audio track until the feature is switched on", async () => {
    const { result } = renderHook(() => useSilenceSkip("v1"));

    expect(result.current.enabled).toBe(false);
    expect(mockIpc.videos.skips).not.toHaveBeenCalled();
    // 关着的时候连区间都没有，自然什么也不跳。
    expect(result.current.handleTimeUpdate(fakeVideo(12))).toBe(false);

    act(() => result.current.toggle());
    await waitFor(() => expect(mockIpc.videos.skips).toHaveBeenCalledWith("v1"));
  });

  it("jumps past a silence while playing and says how much it skipped", async () => {
    const { result } = renderHook(() => useSilenceSkip("v1"));
    act(() => result.current.toggle());
    await waitFor(() => expect(mockIpc.videos.skips).toHaveBeenCalled());

    const video = fakeVideo(12);
    act(() => {
      expect(result.current.handleTimeUpdate(video)).toBe(true);
    });
    expect(video.currentTime).toBe(20);
    await waitFor(() => expect(result.current.notice).toBe("跳过 8 秒静音"));

    // 跳到位之后不该再被同一段抓住，否则会原地反复跳。
    expect(result.current.handleTimeUpdate(fakeVideo(20))).toBe(false);
  });

  it("leaves a paused or seeking player alone", async () => {
    const { result } = renderHook(() => useSilenceSkip("v1"));
    act(() => result.current.toggle());
    await waitFor(() => expect(mockIpc.videos.skips).toHaveBeenCalled());

    const paused = { ...fakeVideo(12), paused: true } as HTMLVideoElement;
    expect(result.current.handleTimeUpdate(paused)).toBe(false);
    // 用户正在拖进度条时抢着改 currentTime，会把拖动打断。
    const seeking = { ...fakeVideo(12), seeking: true } as HTMLVideoElement;
    expect(result.current.handleTimeUpdate(seeking)).toBe(false);
  });

  it("survives a failed scan by simply not skipping", async () => {
    mockIpc.videos.skips.mockRejectedValue(new Error("no ffmpeg"));
    const { result } = renderHook(() => useSilenceSkip("v1"));

    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.handleTimeUpdate(fakeVideo(12))).toBe(false);
  });
});
