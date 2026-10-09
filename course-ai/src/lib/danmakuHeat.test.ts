import { describe, expect, it } from "vitest";
import { MIN_DANMAKU_FOR_HEAT, danmakuHeat, heatAreaPath, heatPeaks } from "./danmakuHeat";
import type { DanmakuEntry } from "./types";

function at(ms: number): DanmakuEntry {
  return { mode: "scroll", start_ms: ms, text: "哈哈", color: null, font_size: null };
}

/** 均匀铺一层底噪，再在给定时刻堆一批弹幕。 */
function withBursts(durationMs: number, bursts: Array<[ms: number, n: number]>) {
  const entries: DanmakuEntry[] = [];
  for (let ms = 0; ms < durationMs; ms += durationMs / 40) entries.push(at(ms));
  for (const [ms, n] of bursts) for (let i = 0; i < n; i++) entries.push(at(ms + i));
  return entries;
}

describe("danmakuHeat", () => {
  it("returns null when there are too few danmaku or no duration", () => {
    const few = Array.from({ length: MIN_DANMAKU_FOR_HEAT - 1 }, (_, i) => at(i * 1000));
    expect(danmakuHeat(few, 60_000)).toBeNull();
    expect(danmakuHeat(withBursts(60_000, []), 0)).toBeNull();
  });

  it("counts raw danmaku per bin and normalizes smoothed levels to a max of 1", () => {
    const heat = danmakuHeat(withBursts(120_000, [[60_000, 50]]), 120_000, 12)!;
    expect(heat.binMs).toBe(10_000);
    expect(heat.counts.reduce((a, b) => a + b, 0)).toBe(40 + 50);
    expect(heat.counts[6]).toBeGreaterThanOrEqual(50);
    expect(Math.max(...heat.levels)).toBe(1);
    expect(heat.levels.every((l) => l >= 0 && l <= 1)).toBe(true);
  });

  it("ignores danmaku outside the video duration", () => {
    const entries = [...withBursts(60_000, []), at(-5), at(90_000)];
    const heat = danmakuHeat(entries, 60_000, 6)!;
    expect(heat.counts.reduce((a, b) => a + b, 0)).toBe(40);
  });
});

describe("heatPeaks", () => {
  it("picks the busiest moments in time order, spaced apart", () => {
    const heat = danmakuHeat(
      withBursts(600_000, [
        [100_000, 80],
        [102_000, 70],
        [400_000, 120],
      ]),
      600_000,
    )!;
    const peaks = heatPeaks(heat);
    expect(peaks).toHaveLength(2);
    expect(peaks[0].ms).toBeGreaterThan(95_000);
    expect(peaks[0].ms).toBeLessThan(110_000);
    expect(peaks[1].ms).toBeGreaterThan(395_000);
    expect(peaks[1].ms).toBeLessThan(410_000);
    expect(peaks[0].level).toBe(1);
  });

  it("ignores bursts at the very start and end of the video", () => {
    const heat = danmakuHeat(
      withBursts(600_000, [
        [599_000, 300],
        [300_000, 120],
      ]),
      600_000,
    )!;
    const peaks = heatPeaks(heat);
    expect(peaks).toHaveLength(1);
    expect(peaks[0].ms).toBeGreaterThan(295_000);
    expect(peaks[0].ms).toBeLessThan(310_000);
  });

  it("scales to the lecture body so a sign-off burst doesn't flatten the curve", () => {
    const heat = danmakuHeat(
      withBursts(600_000, [
        [599_000, 400],
        [300_000, 100],
      ]),
      600_000,
    )!;
    expect(heat.levels[Math.floor(300_000 / heat.binMs)]).toBeGreaterThan(0.95);
    expect(heat.levels[heat.levels.length - 1]).toBe(1);
  });

  it("returns nothing when the curve is flat", () => {
    const heat = danmakuHeat(withBursts(600_000, []), 600_000)!;
    expect(heatPeaks(heat, { minLevel: 1.01 })).toEqual([]);
  });
});

describe("heatAreaPath", () => {
  it("draws a closed area anchored to the bottom edge", () => {
    expect(heatAreaPath([0, 1, 0.5], 100, 10)).toBe("M0,10 L0.0,10.0 L50.0,0.0 L100.0,5.0 L100,10 Z");
    expect(heatAreaPath([])).toBe("");
  });
});
