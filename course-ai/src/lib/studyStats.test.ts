import { describe, expect, it } from "vitest";
import {
  computeStreak,
  formatDuration,
  relativeDay,
  weeklyMs,
} from "./studyStats";

describe("computeStreak", () => {
  it("counts consecutive days back from today", () => {
    const days = new Set(["2026-07-20", "2026-07-19", "2026-07-18"]);
    expect(computeStreak(days, "2026-07-20")).toBe(3);
  });

  it("does not reset when today has no activity yet (counts from yesterday)", () => {
    const days = new Set(["2026-07-19", "2026-07-18"]);
    expect(computeStreak(days, "2026-07-20")).toBe(2);
  });

  it("stops at the first gap", () => {
    const days = new Set(["2026-07-20", "2026-07-18", "2026-07-17"]);
    expect(computeStreak(days, "2026-07-20")).toBe(1);
  });

  it("is zero with no activity", () => {
    expect(computeStreak(new Set(), "2026-07-20")).toBe(0);
  });
});

describe("weeklyMs", () => {
  it("sums only the last 7 days including today", () => {
    const rows = [
      { day: "2026-07-20", watched_ms: 1000 },
      { day: "2026-07-14", watched_ms: 2000 }, // 恰好 7 天前（含）
      { day: "2026-07-13", watched_ms: 4000 }, // 8 天前（不含）
    ];
    expect(weeklyMs(rows, "2026-07-20")).toBe(3000);
  });
});

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatDuration(0)).toBe("0 分钟");
    expect(formatDuration(90_000)).toBe("2 分钟");
    expect(formatDuration(3_600_000)).toBe("1 小时");
    expect(formatDuration(3_600_000 + 15 * 60_000)).toBe("1 小时 15 分");
  });
});

describe("relativeDay", () => {
  const today = "2026-07-20";
  it("labels today/yesterday/N days ago", () => {
    expect(relativeDay(new Date("2026-07-20T09:00:00").getTime(), today)).toBe("今天");
    expect(relativeDay(new Date("2026-07-19T23:00:00").getTime(), today)).toBe("昨天");
    expect(relativeDay(new Date("2026-07-16T10:00:00").getTime(), today)).toBe("4 天前");
  });
});
