// 播放进度持久化在 localStorage（与断点续播共用一份数据）：
// - video-pos:<id>  上次离开的位置（秒）
// - video-dur:<id>  视频总时长（秒，加载元数据时写入）
// 首页据此在封面上显示「看到哪了」的进度条，并补全 DB 里缺失的时长。
const POS_PREFIX = "video-pos:";
const DUR_PREFIX = "video-dur:";

export const posKey = (id: string) => POS_PREFIX + id;
export const durKey = (id: string) => DUR_PREFIX + id;

export interface PlaybackProgress {
  /** 上次离开位置（秒），无记录为 0 */
  positionSec: number;
  /** 总时长（秒），无记录为 0 */
  durationSec: number;
  /** 进度比例 0..1，时长未知为 0 */
  ratio: number;
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
