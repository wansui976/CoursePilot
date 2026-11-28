/**
 * 区间复读（A-B 循环）与定时停止的纯逻辑：播放器每次 timeupdate 问一下该不该跳回起点、
 * 该不该停。状态放在 stores/playbackTools 里，这里只管算。
 */

export interface AbLoop {
  videoId: string;
  startMs: number;
  /** null = 只定了起点，还在等终点。 */
  endMs: number | null;
}

/** 区间至少这么长：太短的话一次 timeupdate（约 250ms）就越过去了，听不出在复读。 */
export const MIN_LOOP_MS = 1_000;
/**
 * 越过终点多少以内算「自然播到了终点」。拖进度条跳到终点后面远处时不把人拽回去——
 * 那是用户自己想往后看。
 */
export const LOOP_CATCH_MS = 1_500;

/**
 * 快捷键一键三步：没有区间 → 定起点；只有起点 → 定终点（比起点还早就两头互换）；
 * 已有完整区间 → 清掉。返回 null 表示清掉了。
 */
export function stepLoop(loop: AbLoop | null, videoId: string, nowMs: number): AbLoop | null {
  const now = Math.max(0, Math.round(nowMs));
  if (!loop || loop.videoId !== videoId) return { videoId, startMs: now, endMs: null };
  if (loop.endMs == null) return closeLoop(loop, now);
  return null;
}

/** 给只有起点的区间定终点；离起点太近就往后补到最短长度。 */
export function closeLoop(loop: AbLoop, nowMs: number): AbLoop {
  const now = Math.max(0, Math.round(nowMs));
  let start = loop.startMs;
  let end = now;
  if (end < start) [start, end] = [end, start];
  if (end - start < MIN_LOOP_MS) end = start + MIN_LOOP_MS;
  return { videoId: loop.videoId, startMs: start, endMs: end };
}

/**
 * 播到这里该跳回哪：越过终点不久 → 起点；其余（还没到终点、区间不完整、
 * 用户自己跳到很后面）→ null。
 */
export function loopSeekTarget(loop: AbLoop | null, videoId: string, nowMs: number): number | null {
  if (!loop || loop.videoId !== videoId || loop.endMs == null) return null;
  if (nowMs >= loop.endMs && nowMs < loop.endMs + LOOP_CATCH_MS) return loop.startMs;
  return null;
}

/** 视频播完（ended）时：终点贴着片尾的区间也要能循环。 */
export function loopRestartOnEnd(loop: AbLoop | null, videoId: string, durationMs: number): number | null {
  if (!loop || loop.videoId !== videoId || loop.endMs == null) return null;
  return loop.endMs >= durationMs - LOOP_CATCH_MS ? loop.startMs : null;
}

/** 当前这一句的区间（复读这句）：找不到句子时 null。 */
export function sentenceLoop(
  segments: readonly { start_ms: number; end_ms: number }[],
  videoId: string,
  nowMs: number,
): AbLoop | null {
  let found: { start_ms: number; end_ms: number } | undefined;
  for (const segment of segments) {
    if (segment.start_ms <= nowMs) found = segment;
    else break;
  }
  if (!found) found = segments[0];
  if (!found) return null;
  const end = Math.max(found.end_ms, found.start_ms + MIN_LOOP_MS);
  return { videoId, startMs: found.start_ms, endMs: end };
}

// ── 定时停止 ────────────────────────────────────────────────

export type SleepTimer =
  | { kind: "minutes"; minutes: number; deadline: number }
  | { kind: "chapter"; videoId: string; endMs: number };

export const SLEEP_MINUTES = [15, 30, 60] as const;

export function minutesTimer(minutes: number, now = Date.now()): SleepTimer {
  return { kind: "minutes", minutes, deadline: now + minutes * 60_000 };
}

/** 本章结束：当前所在章节的结束时间。没有章节时退化成整段视频结束。 */
export function chapterTimer(
  chapters: readonly { start_ms: number; end_ms: number }[],
  videoId: string,
  nowMs: number,
  durationMs: number,
): SleepTimer {
  const chapter = chapters.find((c) => c.start_ms <= nowMs && nowMs < c.end_ms);
  const endMs = chapter ? chapter.end_ms : durationMs;
  return { kind: "chapter", videoId, endMs };
}

/** 该不该停了。分钟数按墙钟算（暂停着也在走，和手机上的「定时关闭」一样）。 */
export function sleepDue(
  timer: SleepTimer | null,
  videoId: string,
  nowMs: number,
  wallNow = Date.now(),
): boolean {
  if (!timer) return false;
  if (timer.kind === "minutes") return wallNow >= timer.deadline;
  return timer.videoId === videoId && timer.endMs > 0 && nowMs >= timer.endMs - 250;
}

/** 还剩多少毫秒（分钟定时用），给菜单里显示「还剩 12 分钟」。 */
export function sleepRemainingMs(timer: SleepTimer | null, wallNow = Date.now()): number | null {
  if (!timer || timer.kind !== "minutes") return null;
  return Math.max(0, timer.deadline - wallNow);
}
