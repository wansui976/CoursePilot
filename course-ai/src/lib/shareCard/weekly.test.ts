import { describe, expect, it } from "vitest";
import { buildWeeklyReport } from "./weekly";
import type { DayTotal, WeakConcept } from "@/lib/ipc";

const day = (d: string, minutes: number, reviews = 0, good = 0): DayTotal => ({
  day: d,
  watched_ms: minutes * 60000,
  reviews,
  good_reviews: good,
});

const weak = (name: string): WeakConcept => ({
  concept_id: name,
  name,
  course_id: "c",
  course_name: "课",
  reviews: 3,
  fails: 2,
  again_rate: 0.6,
});

describe("buildWeeklyReport", () => {
  it("sums the last 7 days including today and labels each weekday", () => {
    const report = buildWeeklyReport(
      [
        day("2026-10-02", 999), // 第 8 天前，不算
        day("2026-10-03", 30),
        day("2026-10-05", 0, 10, 8),
        day("2026-10-09", 95, 10, 7),
      ],
      "2026-10-09",
      4,
      [weak("公文写作"), weak("负增长"), weak("a"), weak("b"), weak("c")],
      "zh-CN",
    );
    expect(report.range).toBe("10/03 – 10/09");
    expect(report.studiedDays).toBe(3);
    expect(report.reviews).toBe(20);
    expect(report.accuracy).toBe(75);
    expect(report.streak).toBe(4);
    expect(report.days.map((d) => d.minutes)).toEqual([30, 0, 0, 0, 0, 0, 95]);
    expect(report.days[6].label).toBe("五"); // 2026-10-09 是周五
    expect(report.weakTopics).toEqual(["公文写作", "负增长", "a", "b"]);
    expect(report.totalTime).toMatch(/2/);
  });

  it("has no accuracy when nothing was reviewed", () => {
    expect(buildWeeklyReport([], "2026-10-09", 0, [], "en").accuracy).toBeNull();
  });
});
