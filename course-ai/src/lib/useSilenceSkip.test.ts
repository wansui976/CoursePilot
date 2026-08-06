import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, StrictMode, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSilenceSkip } from "./useSilenceSkip";
import { silenceSkipQueryKey } from "./silenceSkip";

const { mockIpc, mockIsMobile } = vi.hoisted(() => ({
  mockIpc: { videos: { skips: vi.fn() } },
  mockIsMobile: vi.fn(() => false),
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/lib/platform", () => ({ isMobile: mockIsMobile }));

function renderSkipHook(videoId = "v1", strict = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client },
      strict ? createElement(StrictMode, null, children) : children,
    );
  return { ...renderHook(() => useSilenceSkip(videoId), { wrapper }), client };
}

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
    mockIsMobile.mockReturnValue(false);
    mockIpc.videos.skips.mockReset().mockResolvedValue([
      { start_ms: 10_000, end_ms: 20_000 },
    ]);
  });

  it("does not scan the audio track until the feature is switched on", async () => {
    const { result } = renderSkipHook();

    expect(result.current.enabled).toBe(false);
    expect(mockIpc.videos.skips).not.toHaveBeenCalled();
    // 关着的时候连区间都没有，自然什么也不跳。
    expect(result.current.handleTimeUpdate(fakeVideo(12))).toBe(false);

    act(() => result.current.toggle());
    await waitFor(() => expect(mockIpc.videos.skips).toHaveBeenCalledWith("v1"));
  });

  it("acknowledges the click right away and reports what it found", async () => {
    const { result } = renderSkipHook();

    act(() => result.current.toggle());
    // 分析要好几秒，点下去必须立刻有回执，否则看着像按钮没反应。
    expect(result.current.notice).toBe("正在找可跳的停顿…");

    await waitFor(() =>
      expect(result.current.notice).toBe("跳停顿已开启，可跳过 1 处停顿"),
    );

    act(() => result.current.toggle());
    expect(result.current.notice).toBe("已关闭跳停顿");
  });

  it("says so when a video has nothing worth skipping", async () => {
    mockIpc.videos.skips.mockResolvedValue([]);
    const { result } = renderSkipHook();

    act(() => result.current.toggle());
    await waitFor(() =>
      expect(result.current.notice).toBe("跳停顿已开启，这个视频没有可跳的停顿"),
    );
  });

  it("stays quiet when the switch was already on from a previous session", async () => {
    localStorage.setItem("skip-silence", "on");
    const { result } = renderSkipHook();

    await waitFor(() => expect(result.current.loading).toBe(false));
    // 每打开一个视频都弹一句「已开启」只会烦人；只有用户亲手点开时才播报。
    expect(result.current.notice).toBeNull();
    expect(result.current.ranges).toHaveLength(1);
  });

  it("jumps past a silence while playing and says how much it skipped", async () => {
    const { result } = renderSkipHook();
    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.ranges).toHaveLength(1));

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
    const { result } = renderSkipHook();
    act(() => result.current.toggle());
    await waitFor(() => expect(mockIpc.videos.skips).toHaveBeenCalled());

    const paused = { ...fakeVideo(12), paused: true } as HTMLVideoElement;
    expect(result.current.handleTimeUpdate(paused)).toBe(false);
    // 用户正在拖进度条时抢着改 currentTime，会把拖动打断。
    const seeking = { ...fakeVideo(12), seeking: true } as HTMLVideoElement;
    expect(result.current.handleTimeUpdate(seeking)).toBe(false);
  });

  it("turns itself off after a failed scan", async () => {
    mockIpc.videos.skips.mockRejectedValue(new Error("no ffmpeg"));
    const { result } = renderSkipHook();

    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.notice).toBe("停顿分析失败，已关闭跳停顿"));
    expect(result.current.enabled).toBe(false);
    expect(localStorage.getItem("skip-silence")).toBe("off");
    expect(result.current.handleTimeUpdate(fakeVideo(12))).toBe(false);
  });

  it("deduplicates the initial request when StrictMode remounts effects", async () => {
    localStorage.setItem("skip-silence", "on");
    const { result } = renderSkipHook("v1", true);

    await waitFor(() => expect(result.current.ranges).toHaveLength(1));
    expect(mockIpc.videos.skips).toHaveBeenCalledTimes(1);
  });

  it("reloads planned ranges when slide extraction invalidates the query", async () => {
    localStorage.setItem("skip-silence", "on");
    const { result, client } = renderSkipHook();
    await waitFor(() => expect(result.current.ranges[0]?.end_ms).toBe(20_000));

    mockIpc.videos.skips.mockResolvedValue([{ start_ms: 30_000, end_ms: 35_000 }]);
    await act(async () => {
      await client.invalidateQueries({ queryKey: silenceSkipQueryKey("v1") });
    });

    await waitFor(() => expect(result.current.ranges[0]?.end_ms).toBe(35_000));
    expect(mockIpc.videos.skips).toHaveBeenCalledTimes(2);
  });

  it("keeps the persisted switch off on unsupported mobile platforms", async () => {
    localStorage.setItem("skip-silence", "on");
    mockIsMobile.mockReturnValue(true);
    const { result } = renderSkipHook();

    expect(result.current.available).toBe(false);
    expect(result.current.enabled).toBe(false);
    await waitFor(() => expect(localStorage.getItem("skip-silence")).toBe("off"));
    expect(mockIpc.videos.skips).not.toHaveBeenCalled();
  });
});
