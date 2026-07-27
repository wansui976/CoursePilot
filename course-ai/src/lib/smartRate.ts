/** 智能倍速：按信息密度动态调播放速度——讲得稀的段落自动加速，密集推导处回到原速。
 *
 * 密度 = 一段时间窗里的字数 ÷ 窗长，**空档也算进分母**。这一点是关键：ASR 切出来的
 * 句子内部几乎不含停顿，老师写板书、翻页、等学生记笔记的空档落在句子**之间**，
 * 所以「一句话的字数 ÷ 这句话的时长」几乎处处相同，量化之后全是 1 倍，等于没效果。
 * 按时间窗算才能反映「这一分钟到底讲了多少内容」。
 *
 * 基准取这个视频自己的中位密度：老师之间快慢差别很大，用绝对阈值会对某些人全程
 * 加速、对某些人全程无效。倍率只在「不慢于用户自己选的倍速」的范围内浮动：
 * 用户选了 1.25x 就说明他要 1.25x 起步，智能档不该偷偷把他拖慢。
 *
 * 判定全是纯函数，可单测。 */

import type { TranscriptSegment } from "@/lib/types";

const ENABLED_KEY = "smart-rate";

export interface SmartRateOptions {
  /** 最高倍率（相对用户选的倍速）。再高就听不清了。 */
  maxMultiplier: number;
  /** 倍率量化步长。太粗（如 0.25）会让大半个视频都落回 1 倍，等于没效果。 */
  step: number;
  /** 变速间隔下限：一段倍率至少撑这么久才允许再变，否则并入前一段。 */
  minRunMs: number;
  /** 算密度的时间窗长度：看的是「这二十秒讲了多少内容」，而不是某一句多快。 */
  windowMs: number;
  /** 时间窗每次前移多少。 */
  stepMs: number;
}

export const DEFAULT_SMART_RATE_OPTIONS: SmartRateOptions = {
  maxMultiplier: 1.5,
  step: 0.1,
  minRunMs: 15_000,
  windowMs: 20_000,
  stepMs: 5_000,
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

/** 去掉空白后的字数。 */
function charCount(text: string): number {
  return text.replace(/\s+/g, "").length;
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
 * 一个时间窗里的字密度（字/秒）。窗内每句按**重叠比例**折算字数，
 * 句子之间的空档自然落进分母——那正是「这段讲得稀」的来源。
 */
function windowDensity(
  segments: TranscriptSegment[],
  from: number,
  to: number,
): number {
  const seconds = (to - from) / 1000;
  if (seconds <= 0) return 0;
  let chars = 0;
  for (const segment of segments) {
    const overlap =
      Math.min(to, segment.end_ms) - Math.max(from, segment.start_ms);
    if (overlap <= 0) continue;
    const duration = segment.end_ms - segment.start_ms;
    const share = duration > 0 ? overlap / duration : 1;
    chars += charCount(segment.text) * share;
  }
  return chars / seconds;
}

/**
 * 把字幕排成「哪段该用几倍速」。
 *
 * 按 windowMs 的时间窗扫过整段视频算字密度（空档计入分母），倍率 = 中位密度 /
 * 本窗密度，夹在 [1, maxMultiplier] 内并按 step 量化：比平时讲得稀就加速，
 * 讲得密（推导、定义）就回到 1 倍，永远不会低于用户自己选的倍速。
 * 相邻同倍率合并；仍不够 minRunMs 的碎段并入前一段，免得刚变速又变回来。
 */
export function planSmartRates(
  segments: TranscriptSegment[],
  options: SmartRateOptions = DEFAULT_SMART_RATE_OPTIONS,
): RateSpan[] {
  const usable = segments
    .filter((segment) => segment.end_ms > segment.start_ms && charCount(segment.text) > 0)
    .sort((a, b) => a.start_ms - b.start_ms);
  if (usable.length === 0) return [];
  const first = usable[0].start_ms;
  const last = Math.max(...usable.map((segment) => segment.end_ms));
  if (last - first < options.windowMs) return [];

  const windows: { start: number; end: number; density: number }[] = [];
  for (let from = first; from < last; from += options.stepMs) {
    const to = Math.min(from + options.windowMs, last);
    windows.push({ start: from, end: to, density: windowDensity(usable, from, to) });
  }
  const baseline = median(windows.map((w) => w.density).filter((d) => d > 0));
  if (baseline == null || baseline <= 0) return [];

  const spans: RateSpan[] = [];
  for (const window of windows) {
    // 完全没有人说话的窗（密度 0）交给跳停顿处理，这里不用倍速去糊它。
    const raw =
      window.density > 0
        ? Math.min(options.maxMultiplier, Math.max(1, baseline / window.density))
        : 1;
    const multiplier = Math.min(
      options.maxMultiplier,
      Math.max(1, Number(quantize(raw, options.step).toFixed(2))),
    );
    const previous = spans[spans.length - 1];
    const tooShort = previous && previous.end_ms - previous.start_ms < options.minRunMs;
    if (previous && (previous.multiplier === multiplier || tooShort)) {
      previous.end_ms = Math.max(previous.end_ms, window.start + options.stepMs);
      continue;
    }
    spans.push({
      start_ms: window.start,
      end_ms: window.start + options.stepMs,
      multiplier,
    });
  }
  const tail = spans[spans.length - 1];
  if (tail) tail.end_ms = Math.max(tail.end_ms, last);
  return spans.filter((span) => span.end_ms > span.start_ms);
}

/** 会被加速的总时长（毫秒）。用来告诉用户「这节课到底有多少能省」。 */
export function speedUpCoverageMs(spans: RateSpan[]): number {
  return spans
    .filter((span) => span.multiplier > 1)
    .reduce((sum, span) => sum + (span.end_ms - span.start_ms), 0);
}

/** 播到 positionMs 时该用几倍速；落在任何段之外（片头、无字幕处）为 1。 */
export function multiplierAt(spans: RateSpan[], positionMs: number): number {
  const hit = spans.find(
    (span) => positionMs >= span.start_ms && positionMs < span.end_ms,
  );
  return hit ? hit.multiplier : 1;
}

/** 打开时的回执：这节课到底有多少能省。全程都不变速时明说，免得以为坏了。 */
export function formatSmartRateSummary(spans: RateSpan[]): string {
  const coverage = speedUpCoverageMs(spans);
  if (spans.length === 0) return "还没有字幕，智能倍速排不出来";
  if (coverage < 30_000) return "智能倍速已开启：这节课讲得很匀，几乎不会变速";
  const minutes = Math.round(coverage / 60_000);
  return minutes >= 1
    ? `智能倍速已开启：约 ${minutes} 分钟会加速`
    : "智能倍速已开启";
}

/** 变速时给的提示。用户得知道速度为什么变了。 */
export function formatRateNotice(base: number, multiplier: number): string {
  const effective = Math.round(base * multiplier * 100) / 100;
  if (multiplier <= 1) return `回到 ${effective}x（这段讲得密）`;
  return `${effective}x（这段讲得慢）`;
}
