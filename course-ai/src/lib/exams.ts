import { create } from "zustand";

/**
 * 课程的考试日期：在课程菜单「考试日期…」里设，课程页标题下、学习面板里倒数天数，
 * 并按还没看完的讲数和剩下的天数算出「每天看几讲」。
 *
 * 只存本机（和每日目标一样），按课程 id 存一份 `{ name, date }`；date 是本地日期 YYYY-MM-DD。
 */
export interface CourseExam {
  name: string;
  /** 本地日期，YYYY-MM-DD。 */
  date: string;
}

const STORAGE_KEY = "course-ai-course-exams";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isExam(value: unknown): value is CourseExam {
  if (!value || typeof value !== "object") return false;
  const exam = value as Record<string, unknown>;
  return typeof exam.name === "string" && typeof exam.date === "string" && DATE_RE.test(exam.date);
}

function load(): Record<string, CourseExam> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, CourseExam> = {};
    for (const [courseId, exam] of Object.entries(parsed)) if (isExam(exam)) out[courseId] = exam;
    return out;
  } catch {
    return {};
  }
}

function persist(exams: Record<string, CourseExam>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(exams));
  } catch {
    // 存不下就只在这次运行里有效。
  }
}

interface ExamState {
  exams: Record<string, CourseExam>;
  setExam: (courseId: string, exam: CourseExam | null) => void;
}

export const useCourseExams = create<ExamState>((set, get) => ({
  exams: load(),
  setExam: (courseId, exam) => {
    const next = { ...get().exams };
    if (exam && isExam(exam)) next[courseId] = { name: exam.name.trim(), date: exam.date };
    else delete next[courseId];
    persist(next);
    set({ exams: next });
  },
}));

/** 本地日期字符串（YYYY-MM-DD）。 */
export function toLocalDate(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 距考试还有几天：今天考 = 0，明天 = 1，已经过了是负数。按本地日历日算，不按 24 小时。 */
export function daysUntil(date: string, now = Date.now()): number {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(y, m - 1, d).getTime();
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Math.round((target - start) / 86_400_000);
}

export interface ExamPlan {
  daysLeft: number;
  /** 还没看完的讲数。 */
  remaining: number;
  /** 每天要看几讲（向上取到 0.5）；已经看完或没有天数时为 0。 */
  perDay: number;
  /** 留出考前最后一天（或几天）只复习：天数够时最后 1 天不排新课。 */
  reviewDays: number;
}

/**
 * 复习计划：剩下的讲平摊到考前的天数里，考前留一天只复习（还剩不到 3 天就不留）。
 * 今天也算一天，所以考试在 3 天后 = 今天、明天、后天三天可用。
 */
export function examPlan(daysLeft: number, total: number, watched: number): ExamPlan {
  const remaining = Math.max(0, total - watched);
  const reviewDays = daysLeft >= 3 ? 1 : 0;
  const studyDays = Math.max(0, daysLeft - reviewDays);
  const perDay =
    remaining === 0 ? 0 : studyDays === 0 ? remaining : Math.ceil((remaining / studyDays) * 2) / 2;
  return { daysLeft, remaining, perDay, reviewDays };
}

/** 即将到来的考试（含今天），按日期排；过了的不列。 */
export function upcomingExams(
  exams: Record<string, CourseExam>,
  now = Date.now(),
): { courseId: string; exam: CourseExam; daysLeft: number }[] {
  return Object.entries(exams)
    .map(([courseId, exam]) => ({ courseId, exam, daysLeft: daysUntil(exam.date, now) }))
    .filter((item) => item.daysLeft >= 0)
    .sort((a, b) => a.daysLeft - b.daysLeft || a.exam.name.localeCompare(b.exam.name));
}
