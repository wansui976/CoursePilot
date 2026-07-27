import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSmartRate } from "./useSmartRate";
import type { TranscriptSegment } from "./types";

function span(startMs: number, endMs: number, chars: number): TranscriptSegment {
  return {
    id: startMs,
    video_id: "v1",
    segment_idx: startMs,
    start_ms: startMs,
    end_ms: endMs,
    text: "字".repeat(chars),
  };
}
function talking(fromMs: number, count: number): TranscriptSegment[] {
  return Array.from({ length: count }, (_, i) =>
    span(fromMs + i * 5_000, fromMs + i * 5_000 + 4_000, 12),
  );
}
function writing(fromMs: number, count: number): TranscriptSegment[] {
  return Array.from({ length: count }, (_, i) =>
    span(fromMs + i * 20_000, fromMs + i * 20_000 + 4_000, 10),
  );
}

// 正常讲授 → 板书段（句子之间空档大）→ 正常讲授。
const segments = [...talking(0, 12), ...writing(60_000, 5), ...talking(160_000, 12)];
const SLOW_MS = 100_000;
const DENSE_MS = 180_000;

describe("useSmartRate", () => {
  beforeEach(() => localStorage.clear());

  it("does nothing until switched on", () => {
    const { result } = renderHook(() => useSmartRate(segments));

    expect(result.current.enabled).toBe(false);
    expect(result.current.available).toBe(true);
    // 关着的时候一律返回 1：播放器按用户自己选的倍速播。
    expect(result.current.update(SLOW_MS, 1)).toBe(1);
    expect(result.current.multiplier).toBe(1);
  });

  it("tells you up front how much of the lecture will be sped up", async () => {
    const { result } = renderHook(() => useSmartRate(segments));
    act(() => result.current.toggle());
    // 「有没有生效」不该靠猜：打开时就说清这节课大约有多少会加速。
    await waitFor(() => expect(result.current.notice).toMatch(/约 \d+ 分钟会加速/));
  });

  it("speeds up a slow stretch and explains the change", async () => {
    const { result } = renderHook(() => useSmartRate(segments));
    act(() => result.current.toggle());

    act(() => {
      expect(result.current.update(SLOW_MS, 1)).toBeGreaterThan(1);
    });
    await waitFor(() => expect(result.current.multiplier).toBeGreaterThan(1));
    // 速度自己变了必须有交代，否则像播放器出了毛病。
    expect(result.current.notice).toMatch(/这段讲得慢/);
  });

  it("returns to the base rate on dense passages", async () => {
    const { result } = renderHook(() => useSmartRate(segments));
    act(() => result.current.toggle());
    act(() => void result.current.update(SLOW_MS, 1.25));
    await waitFor(() => expect(result.current.multiplier).toBeGreaterThan(1));

    act(() => {
      expect(result.current.update(DENSE_MS, 1.25)).toBe(1);
    });
    await waitFor(() => expect(result.current.multiplier).toBe(1));
    // 提示里给的是最终速度，而不是倍率——用户关心的是「现在多快」。
    expect(result.current.notice).toContain("1.25x");
  });

  it("drops back to the base rate as soon as it is switched off", async () => {
    const { result } = renderHook(() => useSmartRate(segments));
    act(() => result.current.toggle());
    act(() => void result.current.update(SLOW_MS, 1));
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
    expect(result.current.update(SLOW_MS, 1)).toBe(1);
  });
});
