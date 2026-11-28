import { beforeEach, describe, expect, it } from "vitest";
import { daysUntil, examPlan, toLocalDate, upcomingExams, useCourseExams } from "./exams";

const NOW = new Date(2026, 10, 28, 23, 30).getTime();

describe("daysUntil", () => {
  it("counts calendar days, not 24-hour blocks", () => {
    expect(daysUntil("2026-11-28", NOW)).toBe(0);
    // 晚上 11 点半：明天就是 1 天后。
    expect(daysUntil("2026-11-29", NOW)).toBe(1);
    expect(daysUntil("2026-12-25", NOW)).toBe(27);
    expect(daysUntil("2026-11-20", NOW)).toBe(-8);
  });

  it("round-trips local dates", () => {
    expect(toLocalDate(NOW)).toBe("2026-11-28");
  });
});

describe("examPlan", () => {
  it("spreads remaining lectures and keeps the last day for review", () => {
    expect(examPlan(11, 30, 10)).toEqual({ daysLeft: 11, remaining: 20, perDay: 2, reviewDays: 1 });
    // 7 讲 / 4 天 = 1.75 → 2。
    expect(examPlan(5, 10, 3).perDay).toBe(2);
    // 5 讲 / 4 天 = 1.25 → 1.5。
    expect(examPlan(5, 5, 0).perDay).toBe(1.5);
  });

  it("does not reserve a review day when the exam is close", () => {
    expect(examPlan(2, 6, 0)).toMatchObject({ perDay: 3, reviewDays: 0 });
    expect(examPlan(0, 6, 2)).toMatchObject({ perDay: 4, remaining: 4 });
  });

  it("is zero once everything is watched", () => {
    expect(examPlan(10, 5, 5)).toMatchObject({ perDay: 0, remaining: 0 });
  });
});

describe("course exams store", () => {
  beforeEach(() => {
    localStorage.clear();
    useCourseExams.setState({ exams: {} });
  });

  it("persists, lists upcoming exams in order and clears", () => {
    const store = useCourseExams.getState();
    store.setExam("a", { name: " 期末考试 ", date: "2026-12-25" });
    store.setExam("b", { name: "期中", date: "2026-12-01" });
    store.setExam("c", { name: "旧的", date: "2026-11-01" });
    expect(JSON.parse(localStorage.getItem("course-ai-course-exams")!).a).toEqual({
      name: "期末考试",
      date: "2026-12-25",
    });
    expect(upcomingExams(useCourseExams.getState().exams, NOW).map((x) => x.courseId)).toEqual(["b", "a"]);
    useCourseExams.getState().setExam("a", null);
    expect(useCourseExams.getState().exams.a).toBeUndefined();
  });

  it("rejects malformed dates", () => {
    useCourseExams.getState().setExam("a", { name: "x", date: "12/25" });
    expect(useCourseExams.getState().exams.a).toBeUndefined();
  });
});
