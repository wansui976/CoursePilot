import type { DanmakuEntry } from "./types";

// 弹幕热度的纯逻辑：把弹幕按时间分桶、平滑、归一化，再挑出几个高峰。
// 进度条（features/player/ProgressBar.tsx）据此画热度曲线和高峰标记。

/** 进度条上的热度分桶数：够看出起伏，又不至于锯齿太碎。 */
export const HEAT_BINS = 120;
/** 平滑窗口半径（桶）：左右各取这么多桶做滑动平均。 */
const SMOOTH_RADIUS = 2;
/** 开头 / 结尾这一比例的时长多是「来了」「打卡」「下课」，不代表内容热度。 */
const EDGE_FRACTION = 0.02;
/** 弹幕太少时曲线只是噪声，不画。 */
export const MIN_DANMAKU_FOR_HEAT = 20;

export interface DanmakuHeat {
  /** 每桶的原始弹幕条数（悬停时显示）。 */
  counts: number[];
  /** 平滑后按正文段最大值归一化到 0..1 的热度（画曲线用；片头片尾超出的截到 1）。 */
  levels: number[];
  /** 每桶对应的时长（ms）。 */
  binMs: number;
}

export interface HeatPeak {
  /** 高峰所在桶的中点时间（ms），点击跳到这里。 */
  ms: number;
  /** 0..1 热度。 */
  level: number;
  /** 该桶原始弹幕条数。 */
  count: number;
}

/** 弹幕数不足或时长未知时返回 null，调用方不画曲线。 */
export function danmakuHeat(
  entries: DanmakuEntry[],
  durationMs: number,
  bins = HEAT_BINS,
): DanmakuHeat | null {
  if (durationMs <= 0 || bins <= 0 || entries.length < MIN_DANMAKU_FOR_HEAT) return null;
  const binMs = durationMs / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const entry of entries) {
    if (entry.start_ms < 0 || entry.start_ms > durationMs) continue;
    counts[Math.min(bins - 1, Math.floor(entry.start_ms / binMs))] += 1;
  }
  const smoothed = counts.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = i - SMOOTH_RADIUS; j <= i + SMOOTH_RADIUS; j++) {
      if (j < 0 || j >= bins) continue;
      sum += counts[j];
      n += 1;
    }
    return sum / n;
  });
  // 按正文段（去掉片头片尾）的最大值归一：片尾「打卡 / 下课」常有一次远高于正文的
  // 弹幕潮，按全片最大值归一会把正文的起伏压平。
  const edge = edgeBins(bins);
  const interior = smoothed.slice(edge, bins - edge);
  const max = Math.max(...(interior.length > 0 ? interior : smoothed));
  if (max <= 0) return null;
  return { counts, levels: smoothed.map((v) => Math.min(1, v / max)), binMs };
}

/**
 * 挑出最多 `count` 个高峰：局部极大、热度不低于 `minLevel`，
 * 且彼此至少相隔 `minGapBins` 个桶（避免一个高峰被拆成好几个点）。
 * 片头片尾（EDGE_FRACTION）不算：那里多是「来了」「打卡」，不是内容上的高能。
 */
export function heatPeaks(
  heat: DanmakuHeat,
  { count = 3, minLevel = 0.6, minGapBins = 8 } = {},
): HeatPeak[] {
  const { levels, counts, binMs } = heat;
  const edge = edgeBins(levels.length);
  const candidates: number[] = [];
  for (let i = edge; i < levels.length - edge; i++) {
    const prev = i > 0 ? levels[i - 1] : -1;
    const next = i < levels.length - 1 ? levels[i + 1] : -1;
    if (levels[i] >= minLevel && levels[i] >= prev && levels[i] > next) candidates.push(i);
  }
  candidates.sort((a, b) => levels[b] - levels[a] || a - b);
  const picked: number[] = [];
  for (const i of candidates) {
    if (picked.length >= count) break;
    if (picked.every((p) => Math.abs(p - i) >= minGapBins)) picked.push(i);
  }
  return picked
    .map((i) => rawPeakNear(counts, i))
    .sort((a, b) => a - b)
    .map((i) => ({ ms: Math.round((i + 0.5) * binMs), level: levels[i], count: counts[i] }));
}

function edgeBins(bins: number) {
  return Math.ceil(bins * EDGE_FRACTION);
}

/** 平滑会把一次尖峰摊成平台；回到原始计数，在平滑窗口内找真正最密的那个桶。 */
function rawPeakNear(counts: number[], i: number) {
  let best = i;
  for (let j = Math.max(0, i - SMOOTH_RADIUS); j <= Math.min(counts.length - 1, i + SMOOTH_RADIUS); j++) {
    if (counts[j] > counts[best]) best = j;
  }
  return best;
}

/** 把热度画成填充面积的 SVG path（viewBox 0 0 width height，底边贴 height）。 */
export function heatAreaPath(levels: number[], width = 1000, height = 100): string {
  if (levels.length === 0) return "";
  const step = levels.length > 1 ? width / (levels.length - 1) : width;
  const y = (level: number) => (height - level * height).toFixed(1);
  const points = levels.map((level, i) => `L${(i * step).toFixed(1)},${y(level)}`);
  return `M0,${height} ${points.join(" ")} L${width},${height} Z`;
}
