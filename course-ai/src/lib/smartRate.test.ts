import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SMART_RATE_OPTIONS,
  formatRateNotice,
  isSmartRateEnabled,
  multiplierAt,
  planSmartRates,
  setSmartRateEnabled,
} from "./smartRate";
import type { TranscriptSegment } from "./types";

let nextId = 1;
function seg(startMs: number, endMs: number, text: string): TranscriptSegment {
  return {
    id: nextId++,
    video_id: "v1",
    segment_idx: nextId,
    start_ms: startMs,
    end_ms: endMs,
    text,
  };
}

/** 每段 10 秒；字数决定语速。20 字/10 秒 = 2 字/秒。 */
function segsOf(...counts: number[]): TranscriptSegment[] {
  return counts.map((chars, i) => seg(i * 10_000, (i + 1) * 10_000, "字".repeat(chars)));
}

describe("planSmartRates", () => {
  it("speeds up the slow stretches and keeps the dense ones at base", () => {
    // 中位语速 2 字/秒。中间连着三句只有 0.8 字/秒（老师在写板书、边写边说）→ 该加速；
    // 前后正常语速 → 原速。单句的快慢是噪声，只有成片的慢才算慢。
    const spans = planSmartRates(segsOf(20, 20, 20, 8, 8, 8, 20, 20, 20));
    const at = (ms: number) => multiplierAt(spans, ms);
    expect(at(5_000)).toBe(1);
    expect(at(45_000)).toBeGreaterThan(1);
    expect(at(85_000)).toBe(1);
  });

  it("never drops below the rate the user picked", () => {
    // 整段都比平时快也不该低于 1：用户选了 1.25x 就是要 1.25x 起步。
    const spans = planSmartRates(segsOf(20, 60, 20, 60));
    expect(spans.every((span) => span.multiplier >= 1)).toBe(true);
  });

  it("caps how fast it will go", () => {
    // 某段几乎不说话（语速极低），倍率也不能突破上限，否则根本听不清。
    const spans = planSmartRates(segsOf(40, 40, 1, 40));
    expect(Math.max(...spans.map((span) => span.multiplier))).toBeLessThanOrEqual(
      DEFAULT_SMART_RATE_OPTIONS.maxMultiplier,
    );
  });

  it("merges short runs so the speed does not flap", () => {
    // 快慢逐段交替：如果照单全收，每 10 秒变一次速，听着像卡带。
    const spans = planSmartRates(segsOf(20, 10, 20, 10, 20, 10, 20, 10));
    // 每 10 秒一句、快慢交替：变速间隔下限 15 秒，所以最多也就分成 4 段。
    expect(spans.length).toBeLessThanOrEqual(4);
    expect(spans.every((span) => span.end_ms - span.start_ms >= 15_000)).toBe(true);
  });

  it("returns nothing to act on without usable subtitles", () => {
    expect(planSmartRates([])).toEqual([]);
    // 时长为 0 或空文本的段算不出语速，不该拿它当基准。
    expect(planSmartRates([seg(0, 0, "字"), seg(1_000, 2_000, "   ")])).toEqual([]);
  });

  it("falls back to base rate outside the planned spans", () => {
    const spans = planSmartRates(segsOf(20, 10, 10, 20));
    // 片头、没有字幕的地方不猜，按用户选的倍速播。
    expect(multiplierAt(spans, -1)).toBe(1);
    expect(multiplierAt(spans, 10 * 60_000)).toBe(1);
  });
});

describe("smart rate switch and notice", () => {
  beforeEach(() => localStorage.clear());

  it("stays off until turned on, then remembers", () => {
    expect(isSmartRateEnabled()).toBe(false);
    setSmartRateEnabled(true);
    expect(isSmartRateEnabled()).toBe(true);
    setSmartRateEnabled(false);
    expect(isSmartRateEnabled()).toBe(false);
  });

  it("says the effective rate and why it changed", () => {
    expect(formatRateNotice(1, 1.25)).toBe("1.25x（这段讲得慢）");
    // 倍速是相对用户选的倍速叠加的，提示里要给最终速度。
    expect(formatRateNotice(1.5, 1.25)).toBe("1.88x（这段讲得慢）");
    expect(formatRateNotice(1.25, 1)).toBe("回到 1.25x（这段讲得密）");
  });
});
