/** 朔望月长度（天）和一个已知的新月时刻（2000-01-06 18:14 UTC）。 */
const SYNODIC_DAYS = 29.530588853;
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);

/** 月相：0 = 新月，0.25 = 上弦，0.5 = 满月，0.75 = 下弦。 */
export function moonPhase(date: Date): number {
  const days = (date.getTime() - KNOWN_NEW_MOON) / 86_400_000;
  const phase = (days / SYNODIC_DAYS) % 1;
  return phase < 0 ? phase + 1 : phase;
}

/**
 * 画月亮亮的那部分：外侧半圆 + 明暗交界的半个椭圆。
 * 上半月（盈）亮在右边，下半月（亏）亮在左边；北半球看到的样子。
 */
export function moonLitPath(phase: number, cx: number, cy: number, r: number): string {
  const k = Math.cos(phase * 2 * Math.PI);
  const rx = Math.abs(k) * r;
  const waxing = phase < 0.5;
  const top = `${cx} ${cy - r}`;
  const bottom = `${cx} ${cy + r}`;
  // 外侧：上 → 下。盈：顺时针经过右边；亏：逆时针经过左边。
  const outer = `A ${r} ${r} 0 0 ${waxing ? 1 : 0} ${bottom}`;
  // 交界：下 → 上。弯向亮的一侧是月牙（k > 0），弯向暗的一侧是凸月。
  const sweep = waxing ? (k > 0 ? 0 : 1) : k > 0 ? 1 : 0;
  const inner = `A ${rx.toFixed(2)} ${r} 0 0 ${sweep} ${top}`;
  return `M ${top} ${outer} ${inner} Z`;
}
