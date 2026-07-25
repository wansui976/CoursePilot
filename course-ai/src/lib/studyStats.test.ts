import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_GOAL_MIN,
  computeStreak,
  dayMs,
  dayReviews,
  formatDuration,
  heatLevel,
  heatmapGrid,
  isStudiedDay,
  readDailyGoalMin,
  relativeDay,
  reviewTotals,
  weeklyMs,
  writeDailyGoalMin,
} from "./studyStats";

/** 造一行按天统计（只写关心的字段）。 */
function row(day: string, over: Partial<Omit<DayTotal, "day">> = {}) {
  return { day, watched_ms: 0, reviews: 0, good_reviews: 0, ...over };
}
type DayTotal = { day: string; watched_ms: number; reviews: number; good_reviews: number };

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

describe("isStudiedDay", () => {
  it("counts a review-only day as studied", () => {
    expect(isStudiedDay(row("2026-07-20", { reviews: 5 }))).toBe(true);
    expect(isStudiedDay(row("2026-07-20", { watched_ms: 1000 }))).toBe(true);
    expect(isStudiedDay(row("2026-07-20"))).toBe(false);
  });
});

describe("reviewTotals", () => {
  it("sums reviews and good answers over the last 7 days only", () => {
    const rows = [
      row("2026-07-20", { reviews: 10, good_reviews: 7 }),
      row("2026-07-14", { reviews: 4, good_reviews: 4 }), // 恰好 7 天前（含）
      row("2026-07-13", { reviews: 99, good_reviews: 99 }), // 8 天前（不含）
    ];
    expect(reviewTotals(rows, "2026-07-20")).toEqual({ reviews: 14, good: 11 });
  });

  it("is zero when nothing was reviewed", () => {
    expect(reviewTotals([row("2026-07-20", { watched_ms: 600_000 })], "2026-07-20")).toEqual({
      reviews: 0,
      good: 0,
    });
  });
});

describe("weeklyMs", () => {
  it("sums only the last 7 days including today", () => {
    const rows = [
      { day: "2026-07-20", watched_ms: 1000, reviews: 0, good_reviews: 0 },
      { day: "2026-07-14", watched_ms: 2000, reviews: 0, good_reviews: 0 }, // 恰好 7 天前（含）
      { day: "2026-07-13", watched_ms: 4000, reviews: 0, good_reviews: 0 }, // 8 天前（不含）
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

describe("daily goal storage", () => {
  it("defaults when unset and round-trips a written value", () => {
    localStorage.clear();
    expect(readDailyGoalMin()).toBe(DEFAULT_DAILY_GOAL_MIN);
    writeDailyGoalMin(45);
    expect(readDailyGoalMin()).toBe(45);
    // 非法值不写入，读回仍为上一个有效值。
    writeDailyGoalMin(0);
    writeDailyGoalMin(-5);
    expect(readDailyGoalMin()).toBe(45);
  });
});

describe("dayMs", () => {
  it("returns a day's watched ms or 0", () => {
    const rows = [{ day: "2026-07-20", watched_ms: 1200, reviews: 0, good_reviews: 0 }];
    expect(dayMs(rows, "2026-07-20")).toBe(1200);
    expect(dayMs(rows, "2026-07-19")).toBe(0);
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
        { day: "2026-07-20", watched_ms: 90 * 60_000, reviews: 0, good_reviews: 0 }, // 今天：4 级
        { day: "2026-07-18", watched_ms: 10 * 60_000, reviews: 0, good_reviews: 0 }, // 周六：1 级
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

  it("keeps a review-only day visible at level 1", () => {
    const grid = heatmapGrid([row("2026-07-19", { reviews: 12 })], today, 4);
    const cell = grid
      .flat()
      .find((c): c is NonNullable<typeof c> => c?.day === "2026-07-19");
    expect(cell).toMatchObject({ ms: 0, reviews: 12, level: 1 });
  });
});

describe("dayReviews", () => {
  it("returns a day's review count or 0", () => {
    const rows = [row("2026-07-20", { reviews: 8 })];
    expect(dayReviews(rows, "2026-07-20")).toBe(8);
    expect(dayReviews(rows, "2026-07-19")).toBe(0);
  });
});
