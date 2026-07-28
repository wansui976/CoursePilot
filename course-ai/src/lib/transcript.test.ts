import { describe, expect, it } from "vitest";
import { findActiveSegmentIndex } from "./transcript";

const segments = [
  { start_ms: 1_000, end_ms: 1_900 },
  { start_ms: 2_000, end_ms: 2_900 },
  { start_ms: 3_000, end_ms: 3_900 },
];

describe("findActiveSegmentIndex", () => {
  it("honors segment boundaries and transcript gaps", () => {
    expect(findActiveSegmentIndex(segments, 999)).toBe(-1);
    expect(findActiveSegmentIndex(segments, 1_000)).toBe(0);
    expect(findActiveSegmentIndex(segments, 1_899)).toBe(0);
    expect(findActiveSegmentIndex(segments, 1_900)).toBe(-1);
    expect(findActiveSegmentIndex(segments, 2_000)).toBe(1);
    expect(findActiveSegmentIndex(segments, 3_900)).toBe(-1);
  });

  it("finds a late segment in a long transcript", () => {
    const longTranscript = Array.from({ length: 100_000 }, (_, index) => ({
      start_ms: index * 1_000,
      end_ms: index * 1_000 + 900,
    }));
    let indexedReads = 0;
    const measuredTranscript = new Proxy(longTranscript, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) indexedReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    expect(findActiveSegmentIndex(measuredTranscript, 99_998_500)).toBe(99_998);
    expect(indexedReads).toBeLessThan(40);
  });
});
