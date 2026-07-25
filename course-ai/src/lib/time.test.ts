import { describe, expect, it } from "vitest";
import { formatCountdown, formatMs, formatRelativeTime } from "./time";

describe("formatMs", () => {
  it("formats zero", () => {
    expect(formatMs(0)).toBe("00:00");
  });

  it("formats mm:ss", () => {
    expect(formatMs(83_000)).toBe("01:23");
  });

  it("formats hh:mm:ss when at least one hour", () => {
    expect(formatMs(3_725_000)).toBe("01:02:05");
  });

  it("clamps negative values to zero", () => {
    expect(formatMs(-500)).toBe("00:00");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-07-25T12:00:00").getTime();
  const ago = (ms: number) => formatRelativeTime(now - ms, now);

  it("uses 刚刚 within the first minute", () => {
    expect(ago(0)).toBe("刚刚");
    expect(ago(59_000)).toBe("刚刚");
  });

  it("counts minutes, hours and days", () => {
    expect(ago(60_000)).toBe("1 分钟前");
    expect(ago(59 * 60_000)).toBe("59 分钟前");
    expect(ago(3 * 3600_000)).toBe("3 小时前");
    expect(ago(26 * 3600_000)).toBe("1 天前");
    expect(ago(6 * 24 * 3600_000)).toBe("6 天前");
  });

  it("falls back to a date past a week, adding the year only when it differs", () => {
    expect(ago(8 * 24 * 3600_000)).toBe("7 月 17 日");
    expect(formatRelativeTime(new Date("2025-12-30T09:00:00").getTime(), now)).toBe(
      "2025 年 12 月 30 日",
    );
  });

  it("treats future timestamps as 刚刚 instead of showing negatives", () => {
    expect(formatRelativeTime(now + 5 * 60_000, now)).toBe("刚刚");
  });
});

describe("formatCountdown", () => {
  const now = new Date("2026-07-25T12:00:00").getTime();
  const ahead = (ms: number) => formatCountdown(now + ms, now);

  it("counts minutes, hours and days ahead, rounding up", () => {
    expect(ahead(30_000)).toBe("1 分钟后");
    expect(ahead(90_000)).toBe("2 分钟后");
    expect(ahead(3 * 3600_000 - 1000)).toBe("3 小时后");
    expect(ahead(45 * 60_000)).toBe("45 分钟后");
    expect(ahead(5 * 3600_000)).toBe("5 小时后");
    expect(ahead(50 * 3600_000)).toBe("2 天后");
  });

  it("says 马上 for anything already due", () => {
    expect(ahead(0)).toBe("马上");
    expect(ahead(-3600_000)).toBe("马上");
  });
});
