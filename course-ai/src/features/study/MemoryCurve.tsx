import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { curveOf, DAY_MS, THRESHOLD, type CurvePoint } from "@/lib/memoryCurve";
import { qk } from "@/lib/queryKeys";

const W = 560;
const H = 180;
const PAD = { l: 40, r: 16, t: 12, b: 26 };

/** 一张卡的记忆曲线：墨色实线是已经发生的，虚线是预测；黄点是复习，红圈是答「重来」的那次。 */
export function MemoryCurve({ cardId }: { cardId: string }) {
  const { t } = useTranslation();
  const { data: history, isError } = useQuery({
    queryKey: qk.srs.cardHistory(cardId),
    queryFn: () => ipc.srs.cardHistory(cardId),
    retry: false,
  });
  const nowMs = useMemo(() => Date.now(), []);
  const curve = useMemo(() => (history ? curveOf(history, nowMs) : null), [history, nowMs]);
  if (isError || !history || !curve || curve.past.length === 0) {
    return <p className="ca-curve-empty">{t("memoryCurve.empty")}</p>;
  }
  const span = curve.spanDays * 1.05;
  const x = (d: number) => PAD.l + ((W - PAD.l - PAD.r) * d) / span;
  const y = (r: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (r - 0.5) / 0.5);
  const path = (points: CurvePoint[]) =>
    points.map((p, i) => `${i ? "L" : "M"}${x(p.day).toFixed(1)},${y(Math.max(0.5, p.r)).toFixed(1)}`).join(" ");
  const t0 = history.reviews[0].ts;
  const nowDay = (nowMs - t0) / DAY_MS;
  const nowR = curve.past[curve.past.length - 1].r;
  const dueDay = curve.future[curve.future.length - 1].day;
  const tickStep = span > 60 ? 30 : span > 21 ? 7 : span > 7 ? 2 : 1;
  const ticks: number[] = [];
  for (let d = 0; d <= span; d += tickStep) ticks.push(d);
  const summary = t("memoryCurve.summary", {
    now: Math.round(nowR * 100),
    days: Math.max(0, Math.round(dueDay - nowDay)),
  });

  return (
    <figure className="ca-curve">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
        {[0.5, 0.6, 0.7, 0.8, 0.9, 1].map((r) => (
          <g key={r}>
            <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(r)} y2={y(r)} />
            <text className="axis" x={PAD.l - 6} y={y(r) + 3.5} textAnchor="end">
              {Math.round(r * 100)}%
            </text>
          </g>
        ))}
        {ticks.map((d) => (
          <text key={d} className="axis" x={x(d)} y={H - 8} textAnchor="middle">
            {t("memoryCurve.day", { count: d })}
          </text>
        ))}
        <line className="thr" x1={PAD.l} x2={W - PAD.r} y1={y(THRESHOLD)} y2={y(THRESHOLD)} />
        <path className="line" d={path(curve.past)} />
        <path className="future" d={path(curve.future)} />
        <line className="now" x1={x(nowDay)} x2={x(nowDay)} y1={PAD.t} y2={H - PAD.b} />
        {history.reviews.map((review) => (
          <circle
            key={review.ts}
            className={review.rating === 1 ? "rv lapse" : "rv"}
            cx={x((review.ts - t0) / DAY_MS)}
            cy={y(1)}
            r={4.5}
          >
            <title>{t(`memoryCurve.rating${review.rating}`)}</title>
          </circle>
        ))}
        <circle className="nx" cx={x(dueDay)} cy={y(curve.future[curve.future.length - 1].r)} r={5} />
      </svg>
      <figcaption>{summary}</figcaption>
    </figure>
  );
}
