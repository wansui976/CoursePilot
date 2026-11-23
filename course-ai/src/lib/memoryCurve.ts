import type { CardHistory } from "@/lib/ipc";

export const DAY_MS = 86_400_000;
/** 排期的目标保持率：记忆跌到这里就该复习了（与后端 TARGET_RETENTION 一致）。 */
export const THRESHOLD = 0.9;


export type CurvePoint = { day: number; r: number };

/** R(t) = (1 + factor·t/S)^decay：后端排期用的同一条遗忘曲线。 */
export function recall(history: Pick<CardHistory, "factor" | "decay">, days: number, stability: number) {
  return Math.pow(1 + (history.factor * Math.max(0, days)) / Math.max(0.1, stability), history.decay);
}

/**
 * 把复习记录展开成曲线：每次复习跳回 100%，之后按当次的稳定度往下滑；最后一次之后到 nowMs 为实线，
 * 再往后到下次复习为预测。返回 [已发生, 预测]，横轴是距第一次复习的天数。
 */
export function curveOf(history: CardHistory, nowMs: number): { past: CurvePoint[]; future: CurvePoint[]; spanDays: number } {
  const reviews = history.reviews;
  if (reviews.length === 0) return { past: [], future: [], spanDays: 0 };
  const t0 = reviews[0].ts;
  const day = (ms: number) => (ms - t0) / DAY_MS;
  const past: CurvePoint[] = [];
  reviews.forEach((review, i) => {
    const start = day(review.ts);
    const end = i + 1 < reviews.length ? day(reviews[i + 1].ts) : day(nowMs);
    const steps = 24;
    for (let k = 0; k <= steps; k++) {
      const d = start + ((end - start) * k) / steps;
      past.push({ day: d, r: recall(history, d - start, review.stability) });
    }
  });
  const last = reviews[reviews.length - 1];
  const nowDay = day(nowMs);
  const dueDay = history.due_at != null ? Math.max(nowDay, day(history.due_at)) : nowDay;
  const future: CurvePoint[] = [];
  for (let k = 0; k <= 24; k++) {
    const d = nowDay + ((dueDay - nowDay) * k) / 24;
    future.push({ day: d, r: recall(history, d - day(last.ts), last.stability) });
  }
  return { past, future, spanDays: Math.max(1, dueDay) };
}
