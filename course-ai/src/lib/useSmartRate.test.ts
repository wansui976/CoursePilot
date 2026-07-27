import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSmartRate } from "./useSmartRate";
import type { TranscriptSegment } from "./types";

function segsOf(...counts: number[]): TranscriptSegment[] {
  return counts.map((chars, i) => ({
    id: i + 1,
    video_id: "v1",
    segment_idx: i,
    start_ms: i * 10_000,
    end_ms: (i + 1) * 10_000,
    text: "字".repeat(chars),
  }));
}

// 前后正常语速、中间连着三句讲得慢（老师在写板书）。
const segments = segsOf(20, 20, 20, 8, 8, 8, 20, 20, 20);

describe("useSmartRate", () => {
  beforeEach(() => localStorage.clear());

  it("does nothing until switched on", () => {
    const { result } = renderHook(() => useSmartRate(segments));

    expect(result.current.enabled).toBe(false);
    expect(result.current.available).toBe(true);
    // 关着的时候一律返回 1：播放器按用户自己选的倍速播。
    expect(result.current.update(45_000, 1)).toBe(1);
    expect(result.current.multiplier).toBe(1);
  });

  it("speeds up a slow stretch and explains the change", async () => {
    const { result } = renderHook(() => useSmartRate(segments));
    act(() => result.current.toggle());

    act(() => {
      expect(result.current.update(45_000, 1)).toBeGreaterThan(1);
    });
    await waitFor(() => expect(result.current.multiplier).toBeGreaterThan(1));
    // 速度自己变了必须有交代，否则像播放器出了毛病。
    expect(result.current.notice).toMatch(/这段讲得慢/);
  });

  it("returns to the base rate on dense passages", async () => {
    const { result } = renderHook(() => useSmartRate(segments));
    act(() => result.current.toggle());
    act(() => void result.current.update(45_000, 1.25));
    await waitFor(() => expect(result.current.multiplier).toBeGreaterThan(1));

    act(() => {
      expect(result.current.update(85_000, 1.25)).toBe(1);
    });
    await waitFor(() => expect(result.current.multiplier).toBe(1));
    // 提示里给的是最终速度，而不是倍率——用户关心的是「现在多快」。
    expect(result.current.notice).toContain("1.25x");
  });

  it("drops back to the base rate as soon as it is switched off", async () => {
    const { result } = renderHook(() => useSmartRate(segments));
    act(() => result.current.toggle());
    act(() => void result.current.update(45_000, 1));
    await waitFor(() => expect(result.current.multiplier).toBeGreaterThan(1));

    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.multiplier).toBe(1));
  });

  it("says so when there are no subtitles to measure", async () => {
    const { result } = renderHook(() => useSmartRate([]));
    expect(result.current.available).toBe(false);

    act(() => result.current.toggle());
    // 语速是从字幕算的；没有字幕就明说，别让人以为开了却没反应。
    await waitFor(() =>
      expect(result.current.notice).toBe("还没有字幕，智能倍速排不出来"),
    );
    expect(result.current.update(45_000, 1)).toBe(1);
  });
});
