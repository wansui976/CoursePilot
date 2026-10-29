import type { HighlightSegment } from "@/lib/types";

/**
 * 精华压缩版的纯逻辑：按力度筛段落、找当前所在段、算能省多少时间。
 *
 * 三档：off 关；fast 水分段倍速快放（默认，判断错了也不会漏内容）；skip 直接跳过。
 * 力度（strength）= 收进来的最大把握级别：1 只动最确定的，3 连「可能」也算上。
 */
export type HighlightMode = "off" | "fast" | "skip";
export type HighlightStrength = 1 | 2 | 3;

/** 快放倍速。Apple 内核另由调用方封顶。 */
export const HIGHLIGHT_FAST_RATE = 2.5;

/** 用户标过「这段有用」的段落（按起点识别），不再快放 / 跳过。 */
export function activeSegments(
  segments: HighlightSegment[],
  strength: HighlightStrength,
  kept: readonly number[],
): HighlightSegment[] {
  return segments.filter((segment) => segment.level <= strength && !kept.includes(segment.start_ms));
}

export function segmentAt(segments: HighlightSegment[], ms: number): HighlightSegment | null {
  return segments.find((segment) => segment.start_ms <= ms && ms < segment.end_ms) ?? null;
}

/**
 * 能省下的时间（真实时间，毫秒）。基础倍速 baseRate 下看完一段要 dur / baseRate；
 * 跳过省掉全部，快放省掉 dur / baseRate − dur / fastRate（快放不比基础倍速快就不省）。
 */
export function savedMs(
  segments: HighlightSegment[],
  mode: HighlightMode,
  baseRate: number,
  fastRate: number,
): number {
  if (mode === "off" || baseRate <= 0) return 0;
  const total = segments.reduce((sum, segment) => sum + (segment.end_ms - segment.start_ms), 0);
  if (mode === "skip") return total / baseRate;
  return fastRate > baseRate ? total / baseRate - total / fastRate : 0;
}
