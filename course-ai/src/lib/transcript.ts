import type { TranscriptSegment } from "./types";

type TimedSegment = Pick<TranscriptSegment, "start_ms" | "end_ms">;

/**
 * Find the active item in a start-time-sorted, non-overlapping transcript.
 * Playback calls this several times per second, so keep lookup logarithmic.
 */
export function findActiveSegmentIndex(
  segments: readonly TimedSegment[],
  currentMs: number,
): number {
  let low = 0;
  let high = segments.length - 1;

  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    if (segments[middle].start_ms <= currentMs) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (high < 0) return -1;
  const candidate = segments[high];
  return currentMs < candidate.end_ms ? high : -1;
}
