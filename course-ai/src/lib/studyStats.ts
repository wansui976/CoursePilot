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

/** 热力图一格：某天的日期、观看毫秒与强度等级 0–4；null 表示补位（今天之后的未来格）。 */
export type HeatCell = { day: string; ms: number; level: 0 | 1 | 2 | 3 | 4 } | null;

/** 按观看时长把一天分到 0–4 级：0=无、<15分、<30分、<60分、≥60分。 */
export function heatLevel(ms: number): 0 | 1 | 2 | 3 | 4 {
  if (ms <= 0) return 0;
  if (ms < 15 * 60_000) return 1;
  if (ms < 30 * 60_000) return 2;
  if (ms < 60 * 60_000) return 3;
  return 4;
}

/**
 * GitHub 风格贡献热力图网格：返回 `weeks` 列，每列 7 格（周日在上）。
 * 最后一列的今天所在格对齐今天，之后的未来格为 null；范围内无记录的日子按 0 级。
 */
export function heatmapGrid(rows: DayTotal[], today: string, weeks: number): HeatCell[][] {
  const msByDay = new Map(rows.map((r) => [r.day, r.watched_ms]));
  const todayDate = new Date(`${today}T00:00:00`);
  const dow = todayDate.getDay(); // 0=周日 … 6=周六
  // 网格起点 = 今天所在周的周日，再往前推 (weeks-1) 周。
  const start = new Date(todayDate);
  start.setDate(start.getDate() - dow - (weeks - 1) * 7);

  const columns: HeatCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: HeatCell[] = [];
    for (let d = 0; d < 7; d++) {
      const cell = new Date(start);
      cell.setDate(start.getDate() + w * 7 + d);
      const key = localDay(cell);
      if (key > today) {
        col.push(null); // 今天之后：补位
        continue;
      }
      const ms = msByDay.get(key) ?? 0;
      col.push({ day: key, ms, level: heatLevel(ms) });
    }
    columns.push(col);
  }
  return columns;
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
