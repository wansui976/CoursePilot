import { ipc, type VideoProgress } from "./ipc";

/** 库里存的那份进度（仅用到位置与时长两列）。 */
type StoredProgress = Pick<VideoProgress, "position_ms" | "duration_ms">;

// 播放进度持久化在 localStorage（与断点续播共用一份数据）：
// - video-pos:<id>  上次离开的位置（秒）
// - video-dur:<id>  视频总时长（秒，加载元数据时写入）
// 首页据此在封面上显示「看到哪了」的进度条，并补全 DB 里缺失的时长。
const POS_PREFIX = "video-pos:";
const DUR_PREFIX = "video-dur:";
// - course-ai-last-video:<courseId>  该课程最近打开的视频（「继续上次」横幅的依据）
const LAST_VIDEO_PREFIX = "course-ai-last-video:";

export const posKey = (id: string) => POS_PREFIX + id;
export const durKey = (id: string) => DUR_PREFIX + id;
export const lastVideoKey = (courseId: string) => LAST_VIDEO_PREFIX + courseId;

export function readLastVideoId(courseId: string): string | null {
  try {
    return localStorage.getItem(lastVideoKey(courseId));
  } catch {
    return null;
  }
}

export function writeLastVideoId(courseId: string, videoId: string) {
  try {
    localStorage.setItem(lastVideoKey(courseId), videoId);
  } catch {
    // localStorage 不可用时静默放弃（只是少个横幅）。
  }
}

// 看到这个比例即视为「已看完」：进度条隐藏、改显示看完标记，仪表盘完成度按此计数。
export const WATCHED_RATIO = 0.995;

export interface PlaybackProgress {
  /** 上次离开位置（秒），无记录为 0 */
  positionSec: number;
  /** 总时长（秒），无记录为 0 */
  durationSec: number;
  /** 进度比例 0..1，时长未知为 0 */
  ratio: number;
}

/**
 * 把本地记的进度同步进库：完成度以库里那份为准，本地记录退化为热路径缓存。
 * 时机是「暂停」与「离开这个视频」，不跟着 timeupdate 走，避免每 5 秒一次 IPC。
 * 失败静默——本地记录仍在，下次同步会带上。
 */
export function syncPlaybackProgress(videoId: string): void {
  const { positionSec, durationSec } = readPlaybackProgress(videoId);
  if (positionSec <= 0) return;
  try {
    // 同步是「顺手」的事：无论 IPC 不可用还是写库失败，都不该影响播放与卸载。
    void ipc.stats
      .saveVideoProgress(
        videoId,
        Math.round(positionSec * 1000),
        durationSec > 0 ? Math.round(durationSec * 1000) : null,
      )
      .catch(() => {
        // 忽略：完成度会在下一次同步补上，本地续播不受影响。
      });
  } catch {
    // 同上。
  }
}

/**
 * 「已看完」判定：库里的进度优先，没有（老数据或还没同步过）才回落到本地记录。
 * 两条路用的是同一个规则，所以完成度不会因为清缓存就和「已学时长」互相打脸。
 */
export function isWatchedThrough(videoId: string, stored?: StoredProgress): boolean {
  if (stored) {
    // 库里没存到时长（元数据没读到）时借用本地那份，两者来自同一个播放器。
    const durationMs = stored.duration_ms ?? readPlaybackProgress(videoId).durationSec * 1000;
    if (durationMs > 0) return stored.position_ms / durationMs >= WATCHED_RATIO;
  }
  return readPlaybackProgress(videoId).ratio >= WATCHED_RATIO;
}

export function readPlaybackProgress(videoId: string): PlaybackProgress {
  let positionSec = 0;
  let durationSec = 0;
  try {
    const p = Number(localStorage.getItem(posKey(videoId)));
    const d = Number(localStorage.getItem(durKey(videoId)));
    if (Number.isFinite(p) && p > 0) positionSec = p;
    if (Number.isFinite(d) && d > 0) durationSec = d;
  } catch {
    // localStorage 不可用（隐私模式等）时静默返回空进度。
  }
  const ratio =
    durationSec > 0 ? Math.min(1, Math.max(0, positionSec / durationSec)) : 0;
  return { positionSec, durationSec, ratio };
}
