import { describe, expect, it } from "vitest";
import type { HighlightSegment } from "@/lib/types";
import { activeSegments, savedMs, segmentAt } from "./highlights";

const seg = (start: number, end: number, level: 1 | 2 | 3): HighlightSegment => ({
  start_ms: start,
  end_ms: end,
  kind: "chitchat",
  level,
  reason: "闲聊",
});
const segments = [seg(0, 60_000, 1), seg(120_000, 180_000, 2), seg(300_000, 360_000, 3)];

describe("highlights", () => {
  it("按力度筛选，并去掉用户标过有用的段", () => {
    expect(activeSegments(segments, 1, [])).toHaveLength(1);
    expect(activeSegments(segments, 3, [])).toHaveLength(3);
    expect(activeSegments(segments, 3, [120_000]).map((s) => s.start_ms)).toEqual([0, 300_000]);
  });

  it("找当前所在段（左闭右开）", () => {
    expect(segmentAt(segments, 59_999)?.start_ms).toBe(0);
    expect(segmentAt(segments, 60_000)).toBeNull();
  });

  it("算省下的真实时间：跳过省全部，快放省差额，快放不比基础倍速快就不省", () => {
    const two = activeSegments(segments, 2, []); // 共 120 秒
    expect(savedMs(two, "skip", 1, 2.5)).toBe(120_000);
    expect(savedMs(two, "skip", 2, 2.5)).toBe(60_000);
    expect(savedMs(two, "fast", 1, 2.5)).toBeCloseTo(72_000);
    expect(savedMs(two, "fast", 2, 2)).toBe(0);
    expect(savedMs(two, "off", 1, 2.5)).toBe(0);
  });
});
