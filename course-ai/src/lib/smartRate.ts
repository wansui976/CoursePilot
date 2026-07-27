/** 智能倍速：按语速动态调播放速度——讲得慢的段落自动加速，密集推导处回到原速。
 *
 * 语速直接从字幕算（每秒多少字），不必再分析音轨。基准取这个视频自己的中位语速：
 * 老师之间快慢差别很大，用绝对阈值对某些人全程加速、对某些人全程无效。
 *
 * 倍率只在「不慢于用户自己选的倍速」的范围内浮动：用户选了 1.25x 就说明他要
 * 1.25x 起步，智能档不该偷偷把他拖慢。判定全是纯函数，可单测。 */

import type { TranscriptSegment } from "@/lib/types";

const ENABLED_KEY = "smart-rate";

export interface SmartRateOptions {
  /** 最高倍率（相对用户选的倍速）。再高就听不清了。 */
  maxMultiplier: number;
  /** 倍率量化步长：不量化的话每两秒变一下速，听着像卡带。 */
  step: number;
  /** 变速间隔下限：一段倍率至少撑这么久才允许再变，否则并入前一段。 */
  minRunMs: number;
  /** 求语速时的平滑窗口：单句的快慢是噪声，要看这前后一段话的整体语速。 */
  smoothMs: number;
}

export const DEFAULT_SMART_RATE_OPTIONS: SmartRateOptions = {
  maxMultiplier: 1.5,
  step: 0.25,
  minRunMs: 15_000,
  smoothMs: 20_000,
};

/** 一段时间用一个倍率。 */
export interface RateSpan {
  start_ms: number;
  end_ms: number;
  multiplier: number;
}

export function isSmartRateEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "on";
  } catch {
    return false;
  }
}

export function setSmartRateEnabled(enabled: boolean) {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? "on" : "off");
  } catch {
    // 隐私模式下写不了 localStorage，本次会话内照常工作即可。
  }
}

/** 一段字幕的语速（字/秒）。时长异常（0 或负）的段落算不出语速，返回 null。 */
function charsPerSecond(segment: TranscriptSegment): number | null {
  const seconds = (segment.end_ms - segment.start_ms) / 1000;
  const chars = segment.text.replace(/\s+/g, "").length;
  if (seconds <= 0 || chars === 0) return null;
  return chars / seconds;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantize(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * 把字幕排成「哪段该用几倍速」。
 *
 * 语速先按 smoothMs 的窗口平滑——单句的长短是噪声，逐句变速听着像卡带，要看的是
 * 这前后一整段话讲得快还是慢。倍率 = 中位语速 / 平滑语速，夹在 [1, maxMultiplier]
 * 内并按 step 量化：比平时讲得慢就加速，讲得快（密集推导）就回到 1 倍，永远不会
 * 低于用户自己选的倍速。相邻同倍率合并；仍不够 minRunMs 的碎段并入前一段。
 */
export function planSmartRates(
  segments: TranscriptSegment[],
  options: SmartRateOptions = DEFAULT_SMART_RATE_OPTIONS,
): RateSpan[] {
  const usable = segments
    .filter((segment) => charsPerSecond(segment) != null)
    .sort((a, b) => a.start_ms - b.start_ms);
  const speeds = usable.map((segment) => charsPerSecond(segment)!);
  const baseline = median(speeds);
  if (baseline == null || baseline <= 0) return [];

  const mids = usable.map((segment) => (segment.start_ms + segment.end_ms) / 2);
  const half = options.smoothMs / 2;
  const smoothed = mids.map((mid, i) => {
    let sum = 0;
    let count = 0;
    for (let j = 0; j < mids.length; j += 1) {
      if (Math.abs(mids[j] - mid) <= half) {
        sum += speeds[j];
        count += 1;
      }
    }
    return count > 0 ? sum / count : speeds[i];
  });

  const spans: RateSpan[] = [];
  usable.forEach((segment, i) => {
    const raw = Math.min(options.maxMultiplier, Math.max(1, baseline / smoothed[i]));
    const multiplier = Math.min(
      options.maxMultiplier,
      Math.max(1, quantize(raw, options.step)),
    );
    const previous = spans[spans.length - 1];
    // 相邻同倍率直接接上；前一段还没撑到 minRunMs 就先并进去，免得刚变速又变回来。
    const tooShort = previous && previous.end_ms - previous.start_ms < options.minRunMs;
    if (previous && (previous.multiplier === multiplier || tooShort)) {
      previous.end_ms = segment.end_ms;
      return;
    }
    spans.push({ start_ms: segment.start_ms, end_ms: segment.end_ms, multiplier });
  });
  return spans.filter((span) => span.end_ms > span.start_ms);
}

/** 播到 positionMs 时该用几倍速；落在任何段之外（片头、无字幕处）为 1。 */
export function multiplierAt(spans: RateSpan[], positionMs: number): number {
  const hit = spans.find(
    (span) => positionMs >= span.start_ms && positionMs < span.end_ms,
  );
  return hit ? hit.multiplier : 1;
}

/** 变速时给的提示。用户得知道速度为什么变了。 */
export function formatRateNotice(base: number, multiplier: number): string {
  const effective = Math.round(base * multiplier * 100) / 100;
  if (multiplier <= 1) return `回到 ${effective}x（这段讲得密）`;
  return `${effective}x（这段讲得慢）`;
}
