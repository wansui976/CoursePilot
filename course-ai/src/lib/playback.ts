import { create } from "zustand";
import { ipc, type VideoProgress } from "./ipc";

/** 库里存的那份进度（仅用到位置与时长两列）。 */
type StoredProgress = Pick<VideoProgress, "position_ms" | "duration_ms">;

// 播放进度持久化在 localStorage（与断点续播共用一份数据）：
// - video-pos:<id>  上次离开的位置（秒）
// - video-dur:<id>  视频总时长（秒，加载元数据时写入）
// 首页据此在封面上显示「看到哪了」的进度条，并补全 DB 里缺失的时长。
const POS_PREFIX = "video-pos:";
const DUR_PREFIX = "video-dur:";
// - video-at:<id>   本地这份位置最后写入的时刻（毫秒）。和库里的 updated_at 比新旧：
//   别的设备同步来的更新，库里时刻更晚，就以库为准覆盖本地缓存。
const AT_PREFIX = "video-at:";
// - course-ai-last-video:<courseId>  该课程最近打开的视频（「继续上次」横幅的依据）
const LAST_VIDEO_PREFIX = "course-ai-last-video:";

export const posKey = (id: string) => POS_PREFIX + id;
export const durKey = (id: string) => DUR_PREFIX + id;
export const atKey = (id: string) => AT_PREFIX + id;
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

// ---------------------------------------------------------------------------
// 写入：播放器只经这里写本地缓存。
// 本地存储可能被别的数据写满（WKWebView 约 5MB 配额），setItem 会抛错；这里吞掉，
// 播放照常，下一次把进度同步进库时那份仍然完整。

function stampedWrite(videoId: string, key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
    localStorage.setItem(atKey(videoId), String(Date.now()));
  } catch {
    // 配额满或不可用：放弃本地缓存，不打断播放。
  }
}

/** 记本地播放位置（秒）。 */
export function writePlaybackPosition(videoId: string, positionSec: number): void {
  stampedWrite(videoId, posKey(videoId), positionSec);
}

/** 记本地视频总时长（秒）。 */
export function writePlaybackDuration(videoId: string, durationSec: number): void {
  try {
    localStorage.setItem(durKey(videoId), String(durationSec));
  } catch {
    // 同上。
  }
}

function readStamp(videoId: string): number | null {
  try {
    const raw = localStorage.getItem(atKey(videoId));
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 回填：库是准的，本地是缓存。
// 课程页、续播、「继续学习」都在渲染期同步读本地；库里的进度（含别的设备同步来的）
// 只有回填进本地才看得见。

/** 本地缓存被库里的进度改过一次就 +1；读进度的视图订阅它来重新渲染。 */
export const usePlaybackRevision = create<{ revision: number }>(() => ({ revision: 0 }));

/**
 * 按「谁新听谁」把库里的进度合进本地缓存，返回是否改动了什么。
 *
 * - 本地没有这条：直接用库里的。
 * - 本地有、带写入时刻：库里的 updated_at 更晚才覆盖（别的设备看过，或本机已同步过同一份）。
 * - 本地有、但没有写入时刻（升级前留下的）：保留本地，把时刻记成库里那份——两者当作同时，
 *   之后别的设备再有更新就能盖过来。不能反过来让库赢：升级前本地常常比库新
 *   （库只在暂停和离开时同步，直接退出应用时最后一段只在本地）。
 *
 * 被库覆盖的那条若比这门课当前「最近打开的视频」更新，顺带把它记成最近打开的视频，
 * 换台设备也能接着上次看。
 */
export function mergePlaybackProgress(rows: VideoProgress[]): boolean {
  let changed = false;
  const newestByCourse = new Map<string, VideoProgress>();
  try {
    for (const row of rows) {
      const stamp = readStamp(row.video_id);
      const hasLocal = localStorage.getItem(posKey(row.video_id)) != null;
      if (hasLocal && stamp == null) {
        localStorage.setItem(atKey(row.video_id), String(row.updated_at));
        continue;
      }
      if (hasLocal && stamp != null && stamp >= row.updated_at) continue;

      localStorage.setItem(posKey(row.video_id), String(row.position_ms / 1000));
      if (row.duration_ms && row.duration_ms > 0) {
        localStorage.setItem(durKey(row.video_id), String(row.duration_ms / 1000));
      }
      localStorage.setItem(atKey(row.video_id), String(row.updated_at));
      changed = true;
      const newest = newestByCourse.get(row.course_id);
      if (!newest || row.updated_at > newest.updated_at) newestByCourse.set(row.course_id, row);
    }
    for (const [courseId, row] of newestByCourse) {
      const current = readLastVideoId(courseId);
      if (current === row.video_id) continue;
      const currentStamp = current ? (readStamp(current) ?? 0) : 0;
      // 刚覆盖的那条时刻等于 row.updated_at；当前那条若就是刚覆盖的另一条，它更旧。
      if (row.updated_at >= currentStamp) writeLastVideoId(courseId, row.video_id);
    }
  } catch {
    // 本地存储不可用或写满：这次回填作罢，下次再试。已写进去的部分仍然有效。
  }
  return changed;
}

/** 从库里取一遍进度合进本地；有改动就通知视图重渲染。失败静默，下次再来。 */
export async function hydratePlaybackProgress(): Promise<boolean> {
  try {
    const rows = await ipc.stats.videoProgress();
    const changed = mergePlaybackProgress(rows);
    if (changed) usePlaybackRevision.setState((state) => ({ revision: state.revision + 1 }));
    return changed;
  } catch {
    return false;
  }
}

/** 两次回填的最短间隔：切窗口很频繁，没必要每次都查库。 */
const HYDRATE_MIN_INTERVAL_MS = 10_000;

/**
 * 启动时回填一次；之后窗口回到前台时再回填（别的设备上看过、同步刚下来）。
 * 返回停止监听的函数（测试用）。
 */
export function startPlaybackHydration(): () => void {
  let last = 0;
  const run = () => {
    const now = Date.now();
    if (now - last < HYDRATE_MIN_INTERVAL_MS) return;
    last = now;
    void hydratePlaybackProgress();
  };
  run();
  if (typeof document === "undefined") return () => {};
  const onVisible = () => {
    if (document.visibilityState === "visible") run();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", run);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", run);
  };
}
