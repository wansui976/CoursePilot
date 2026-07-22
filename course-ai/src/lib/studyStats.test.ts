import { describe, expect, it } from "vitest";
import {
  computeStreak,
  formatDuration,
  heatLevel,
  heatmapGrid,
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

describe("heatLevel", () => {
  it("buckets watched time into 0–4", () => {
    expect(heatLevel(0)).toBe(0);
    expect(heatLevel(5 * 60_000)).toBe(1);
    expect(heatLevel(20 * 60_000)).toBe(2);
    expect(heatLevel(45 * 60_000)).toBe(3);
    expect(heatLevel(90 * 60_000)).toBe(4);
  });
});

describe("heatmapGrid", () => {
  // 2026-07-20 是周一（getDay()===1）。
  const today = "2026-07-20";

  it("returns `weeks` columns of 7 cells aligned so today is the last real cell", () => {
    const grid = heatmapGrid([], today, 4);
    expect(grid).toHaveLength(4);
    expect(grid.every((col) => col.length === 7)).toBe(true);
    // 今天是周一 → 在最后一列的第 1 行（index 1，周日在 index 0）。
    const lastCol = grid[3];
    expect(lastCol[1]).not.toBeNull();
    expect(lastCol[1]!.day).toBe(today);
    // 今天之后（本列周二起）是未来，补 null。
    expect(lastCol[2]).toBeNull();
    expect(lastCol[6]).toBeNull();
  });

  it("maps a day's watched time to its level and leaves gaps at level 0", () => {
    const grid = heatmapGrid(
      [
        { day: "2026-07-20", watched_ms: 90 * 60_000 }, // 今天：4 级
        { day: "2026-07-18", watched_ms: 10 * 60_000 }, // 周六：1 级
      ],
      today,
      4,
    );
    const cells = grid.flat().filter((c): c is NonNullable<typeof c> => c !== null);
    expect(cells.find((c) => c.day === "2026-07-20")!.level).toBe(4);
    expect(cells.find((c) => c.day === "2026-07-18")!.level).toBe(1);
    // 有记录的天数就这两天，其余在范围内的都是 0 级（不是 null）。
    expect(cells.filter((c) => c.level === 0).length).toBeGreaterThan(0);
  });
});
