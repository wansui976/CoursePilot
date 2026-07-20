import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWatchLogger } from "./useWatchLogger";

const { logWatch } = vi.hoisted(() => ({ logWatch: vi.fn() }));
vi.mock("./ipc", () => ({ ipc: { stats: { logWatch } } }));

describe("useWatchLogger", () => {
  beforeEach(() => {
    logWatch.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes accumulated watch time on the 30s interval", () => {
    renderHook(() => useWatchLogger("v1", true));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(logWatch).toHaveBeenCalledWith("v1", 30_000);
  });

  it("flushes the remaining time to the current video on unmount", () => {
    const { unmount } = renderHook(() => useWatchLogger("v1", true));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    act(() => {
      unmount();
    });
    expect(logWatch).toHaveBeenCalledWith("v1", 5_000);
  });

  it("does not log sub-second fragments", () => {
    const { unmount } = renderHook(() => useWatchLogger("v1", true));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    act(() => {
      unmount();
    });
    expect(logWatch).not.toHaveBeenCalled();
  });

  it("does not accumulate while paused", () => {
    renderHook(() => useWatchLogger("v1", false));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(logWatch).not.toHaveBeenCalled();
  });

  it("attributes time to the video that was playing before a switch", () => {
    const { rerender } = renderHook(
      ({ id }: { id: string }) => useWatchLogger(id, true),
      { initialProps: { id: "v1" } },
    );
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    // 切到 v2：切走前的 4s 应记到 v1。
    act(() => {
      rerender({ id: "v2" });
    });
    expect(logWatch).toHaveBeenCalledWith("v1", 4_000);
  });
});
