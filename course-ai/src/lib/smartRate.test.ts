import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SMART_RATE_OPTIONS,
  formatRateNotice,
  isSmartRateEnabled,
  multiplierAt,
  planSmartRates,
  setSmartRateEnabled,
  speedUpCoverageMs,
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

describe("planSmartRates", () => {
  /** 每 5 秒一句、每句 12 字的正常讲授段。 */
  function talking(fromMs: number, count: number): TranscriptSegment[] {
    return Array.from({ length: count }, (_, i) =>
      seg(fromMs + i * 5_000, fromMs + i * 5_000 + 4_000, "字".repeat(12)),
    );
  }
  /** 板书段：每 20 秒才蹦一句，字也少——句子内部语速正常，空档全在句子之间。 */
  function writing(fromMs: number, count: number): TranscriptSegment[] {
    return Array.from({ length: count }, (_, i) =>
      seg(fromMs + i * 20_000, fromMs + i * 20_000 + 4_000, "字".repeat(10)),
    );
  }

  it("speeds up the sparse stretches, where the pauses live between sentences", () => {
    // 关键点：板书段每句的语速和正常段几乎一样，只是句子之间空档大。
    // 按「一句话的字数 ÷ 这句话的时长」算根本看不出区别，按时间窗算才看得出。
    const spans = planSmartRates([
      ...talking(0, 12),
      ...writing(60_000, 5),
      ...talking(160_000, 12),
    ]);
    expect(multiplierAt(spans, 20_000)).toBe(1);
    expect(multiplierAt(spans, 100_000)).toBeGreaterThan(1);
    expect(multiplierAt(spans, 180_000)).toBe(1);
  });

  it("actually covers a meaningful chunk of the video", () => {
    // 「效果不明显」就是这里出的问题：如果绝大多数时间都落回 1 倍，等于没开。
    const spans = planSmartRates([
      ...talking(0, 12),
      ...writing(60_000, 5),
      ...talking(160_000, 12),
    ]);
    expect(speedUpCoverageMs(spans)).toBeGreaterThan(60_000);
  });

  it("never drops below the rate the user picked", () => {
    const spans = planSmartRates([...talking(0, 12), ...talking(60_000, 24)]);
    expect(spans.every((span) => span.multiplier >= 1)).toBe(true);
  });

  it("caps how fast it will go", () => {
    // 一分钟只说一句：倍率也不能突破上限，否则根本听不清。
    const spans = planSmartRates([
      ...talking(0, 12),
      seg(60_000, 62_000, "字"),
      seg(180_000, 182_000, "字"),
      ...talking(240_000, 12),
    ]);
    expect(Math.max(...spans.map((span) => span.multiplier))).toBeLessThanOrEqual(
      DEFAULT_SMART_RATE_OPTIONS.maxMultiplier,
    );
  });

  it("keeps a minimum gap between speed changes", () => {
    const spans = planSmartRates([
      ...talking(0, 6),
      ...writing(30_000, 2),
      ...talking(70_000, 6),
      ...writing(100_000, 2),
      ...talking(140_000, 6),
    ]);
    // 变速间隔下限 15 秒：不满足就并进前一段，免得速度来回抖。
    expect(
      spans.slice(0, -1).every((span) => span.end_ms - span.start_ms >= 15_000),
    ).toBe(true);
  });

  it("returns nothing to act on without usable subtitles", () => {
    expect(planSmartRates([])).toEqual([]);
    // 时长为 0 或空文本的段算不出密度。
    expect(planSmartRates([seg(0, 0, "字"), seg(1_000, 2_000, "   ")])).toEqual([]);
    // 比一个时间窗还短的视频不值得排倍率表。
    expect(planSmartRates(talking(0, 2))).toEqual([]);
  });

  it("falls back to base rate outside the planned spans", () => {
    const spans = planSmartRates([...talking(0, 12), ...writing(60_000, 5)]);
    // 片头、没有字幕的地方不猜，按用户选的倍速播。
    expect(multiplierAt(spans, -1)).toBe(1);
    expect(multiplierAt(spans, 60 * 60_000)).toBe(1);
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
