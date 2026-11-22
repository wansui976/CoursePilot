/**
 * 进度条上的学习痕迹：笔记里的时间戳、做成复习卡的时刻、答错过的时刻。
 * 笔记可能是 TipTap JSON、HTML 或 Markdown（[mm:ss]），三种都认。
 */
import type { CardMark } from "@/lib/ipc";

/** [mm:ss] / [h:mm:ss] → 毫秒。 */
function clockToMs(clock: string): number | null {
  const parts = clock.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((total, n) => total * 60 + n, 0) * 1000;
}

/** 笔记里出现的所有时刻（毫秒，升序去重）。 */
export function noteMoments(notes: string | null | undefined): number[] {
  if (!notes) return [];
  const found = new Set<number>();
  for (const match of notes.matchAll(/"ms"\s*:\s*(\d+)/g)) found.add(Number(match[1]));
  for (const match of notes.matchAll(/data-ms="(\d+)"/g)) found.add(Number(match[1]));
  for (const match of notes.matchAll(/\[(\d{1,2}(?::\d{2}){1,2})(?:\s*[-–]\s*\d{1,2}(?::\d{2}){1,2})?\]/g)) {
    const ms = clockToMs(match[1]);
    if (ms !== null) found.add(ms);
  }
  return [...found].sort((a, b) => a - b);
}

export interface TimelineMarks {
  /** 记过笔记的时刻：白点。 */
  notes: number[];
  /** 做成复习卡的时刻（你标出的重点）：荧光黄短条。 */
  cards: number[];
  /** 复习时答错过的时刻：红色刻度。 */
  mistakes: number[];
}

export function timelineMarks(notes: string | null | undefined, cards: CardMark[] | undefined): TimelineMarks {
  const list = cards ?? [];
  return {
    notes: noteMoments(notes),
    cards: list.map((card) => card.source_ms),
    mistakes: list.filter((card) => card.lapses > 0).map((card) => card.source_ms),
  };
}
