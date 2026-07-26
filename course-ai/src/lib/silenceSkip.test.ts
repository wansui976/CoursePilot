import { beforeEach, describe, expect, it } from "vitest";
import {
  formatSkipNotice,
  isSkipSilenceEnabled,
  setSkipSilenceEnabled,
  skipTargetMs,
  type SkipRange,
} from "./silenceSkip";

const ranges: SkipRange[] = [
  { start_ms: 10_000, end_ms: 20_000 },
  { start_ms: 40_000, end_ms: 45_000 },
];

describe("silenceSkip", () => {
  beforeEach(() => localStorage.clear());

  it("only fires inside a range and lands past its end", () => {
    expect(skipTargetMs(ranges, 9_999)).toBeNull();
    expect(skipTargetMs(ranges, 10_000)).toBe(20_000);
    expect(skipTargetMs(ranges, 19_999)).toBe(20_000);
    // 终点算开区间：跳到位后不该被同一段再次抓住，否则会原地反复跳。
    expect(skipTargetMs(ranges, 20_000)).toBeNull();
    expect(skipTargetMs(ranges, 41_000)).toBe(45_000);
  });

  it("describes the jump in whole seconds", () => {
    expect(formatSkipNotice(10_000, 20_000)).toBe("跳过 10 秒静音");
    // 不足一秒也说「1 秒」，写「跳过 0 秒」等于没解释。
    expect(formatSkipNotice(10_000, 10_400)).toBe("跳过 1 秒静音");
  });

  it("remembers the switch and stays off until turned on", () => {
    expect(isSkipSilenceEnabled()).toBe(false);
    setSkipSilenceEnabled(true);
    expect(isSkipSilenceEnabled()).toBe(true);
    setSkipSilenceEnabled(false);
    expect(isSkipSilenceEnabled()).toBe(false);
  });
});
