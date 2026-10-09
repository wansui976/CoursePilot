import type { DayTotal, WeakConcept } from "@/lib/ipc";
import { formatDuration, isStudiedDay, localDay } from "@/lib/studyStats";
import type { WeeklyReport } from "./render";

/** 汇总最近 7 天（含今天）的学习数据，供学习周报分享图使用。 */
export function buildWeeklyReport(
  daily: DayTotal[],
  today: string,
  streak: number,
  weak: WeakConcept[],
  language: string,
): WeeklyReport {
  const days: string[] = [];
  const cursor = new Date(`${today}T00:00:00`);
  cursor.setDate(cursor.getDate() - 6);
  for (let i = 0; i < 7; i++) {
    days.push(localDay(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  const rows = days.map((day) => daily.find((r) => r.day === day));
  const watched = rows.reduce((sum, r) => sum + (r?.watched_ms ?? 0), 0);
  const reviews = rows.reduce((sum, r) => sum + (r?.reviews ?? 0), 0);
  const good = rows.reduce((sum, r) => sum + (r?.good_reviews ?? 0), 0);
  const md = (day: string) => `${day.slice(5, 7)}/${day.slice(8, 10)}`;
  const weekday = new Intl.DateTimeFormat(language, { weekday: "narrow" });
  return {
    range: `${md(days[0])} – ${md(days[6])}`,
    totalTime: formatDuration(watched, language),
    studiedDays: rows.filter((r) => r && isStudiedDay(r)).length,
    reviews,
    accuracy: reviews > 0 ? (good / reviews) * 100 : null,
    streak,
    days: days.map((day, i) => ({
      label: weekday.format(new Date(`${day}T12:00:00`)),
      minutes: Math.round((rows[i]?.watched_ms ?? 0) / 60000),
    })),
    weakTopics: weak.slice(0, 4).map((w) => w.name),
  };
}
