import { atKey, readLastVideoId } from "@/lib/playback";
import { lectureNumberOf } from "@/lib/lectureOrder";

/** 多少天没碰，书签上就落一层灰。 */
export const DUSTY_AFTER_DAYS = 14;
const DAY_MS = 86_400_000;

export interface CourseBookmark {
  /** 停在第几讲（标题里读得到讲次就用它，否则按列表位置）。 */
  lecture: number;
  /** 最后一次在这门课里看视频的时刻（毫秒）；读不到为 null。 */
  lastAt: number | null;
  /** 距今几天没碰（读不到时刻为 0）。 */
  idleDays: number;
  dusty: boolean;
}

function readAt(videoId: string): number {
  try {
    const value = Number(window.localStorage.getItem(atKey(videoId)));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** 一门课的书签：夹在最近打开的那一讲；没打开过就没有书签。 */
export function courseBookmark(
  courseId: string,
  videos: { id: string; title: string }[],
  now: number = Date.now(),
): CourseBookmark | null {
  const lastId = readLastVideoId(courseId);
  const index = lastId ? videos.findIndex((video) => video.id === lastId) : -1;
  if (index < 0) return null;
  const lastAt = videos.reduce((latest, video) => Math.max(latest, readAt(video.id)), 0) || null;
  const idleDays = lastAt ? Math.max(0, Math.floor((now - lastAt) / DAY_MS)) : 0;
  return {
    lecture: lectureNumberOf(videos[index].title) ?? index + 1,
    lastAt,
    idleDays,
    dusty: idleDays >= DUSTY_AFTER_DAYS,
  };
}
