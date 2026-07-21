import type { DayTotal } from "./ipc";

/** 本地日期 'YYYY-MM-DD'（与后端 daily_totals 的 date(...,'localtime') 对齐）。 */
export function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 连续学习天数：从今天往回数连续「有学习」的天数。
 * 今天还没学不归零——从昨天算起（当天进度未完不该打断连续记录）。
 */
export function computeStreak(activeDays: Set<string>, today: string): number {
  const d = new Date(`${today}T00:00:00`);
  if (!activeDays.has(localDay(d))) d.setDate(d.getDate() - 1);
  let count = 0;
  while (activeDays.has(localDay(d))) {
    count += 1;
    d.setDate(d.getDate() - 1);
  }
  return count;
}

/** 最近 7 天（含今天）的观看毫秒合计。 */
export function weeklyMs(rows: DayTotal[], today: string): number {
  const start = new Date(`${today}T00:00:00`);
  start.setDate(start.getDate() - 6);
  const from = localDay(start);
  // 'YYYY-MM-DD' 字典序即日期序，可直接比较。
  return rows
    .filter((r) => r.day >= from && r.day <= today)
    .reduce((sum, r) => sum + r.watched_ms, 0);
}

/** 人类可读时长：分钟 / 小时+分。 */
export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min <= 0) return "0 分钟";
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** 相对某天的「今天 / 昨天 / N 天前」。 */
export function relativeDay(ts: number, today: string): string {
  const then = localDay(new Date(ts));
  if (then === today) return "今天";
  const t = new Date(`${today}T00:00:00`);
  t.setDate(t.getDate() - 1);
  if (then === localDay(t)) return "昨天";
  const diffDays = Math.round(
    (new Date(`${today}T00:00:00`).getTime() - new Date(`${then}T00:00:00`).getTime()) /
      86_400_000,
  );
  return `${diffDays} 天前`;
}
