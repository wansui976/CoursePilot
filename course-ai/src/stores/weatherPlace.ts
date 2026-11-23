import { create } from "zustand";
import type { WeatherPlace } from "@/lib/ipc/system";

/**
 * 课桌窗外天气用的地点：在设置里搜城市或用当前位置选定。没选就不查天气（窗外只按时辰画天色）。
 * 存在本机，不同步：不同设备可能在不同城市。
 */
const KEY = "course-ai-weather-place";

function readPlace(): WeatherPlace | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const place = JSON.parse(raw) as WeatherPlace;
    return Number.isFinite(place.latitude) && Number.isFinite(place.longitude) ? place : null;
  } catch {
    return null;
  }
}

export const useWeatherPlace = create<{ place: WeatherPlace | null; setPlace: (place: WeatherPlace | null) => void }>(
  (set) => ({
    place: typeof window === "undefined" ? null : readPlace(),
    setPlace: (place) => {
      try {
        if (place) window.localStorage.setItem(KEY, JSON.stringify(place));
        else window.localStorage.removeItem(KEY);
      } catch {
        // 存不下就只在这次会话里生效。
      }
      set({ place });
    },
  }),
);

/** 坐标只留两位小数（约 1 公里）：够看天气，不多暴露位置。 */
export function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}
