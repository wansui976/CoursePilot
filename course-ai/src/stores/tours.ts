import { create } from "zustand";

/**
 * 新手引导：每组引导（课程库、课程页、工作台……）只出现一次，看过的记在 localStorage。
 * 同一时刻只让一组引导露面：先挂载、先找到锚点的那组占住 active，别的等它结束。
 */
export type TourId = "library" | "course" | "workbench";

export const TOUR_IDS: TourId[] = ["library", "course", "workbench"];
const STORAGE_KEY = "course-ai-tours-seen";

function readSeen(): Set<TourId> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is TourId => TOUR_IDS.includes(id as TourId)));
  } catch {
    return new Set();
  }
}

function writeSeen(seen: Set<TourId>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...seen]));
  } catch {
    // 存不进去（隐私模式等）就只在本次会话里记住。
  }
}

type ToursState = {
  seen: Set<TourId>;
  active: TourId | null;
  /** 想露面时先占位；已有别的引导在显示、或这组已看过，返回 false。 */
  claim: (id: TourId) => boolean;
  /** 看完或点了关闭：记为已看过并让出位置。 */
  finish: (id: TourId) => void;
  /** 只让出位置、不记为看过（例如锚点在中途消失了）。 */
  release: (id: TourId) => void;
  /** 设置里的「重新显示新手引导」。 */
  resetAll: () => void;
};

export const useTours = create<ToursState>((set, get) => ({
  seen: readSeen(),
  active: null,
  claim: (id) => {
    const { seen, active } = get();
    if (seen.has(id)) return false;
    if (active && active !== id) return false;
    if (active !== id) set({ active: id });
    return true;
  },
  finish: (id) => {
    const seen = new Set(get().seen);
    seen.add(id);
    writeSeen(seen);
    set({ seen, active: get().active === id ? null : get().active });
  },
  release: (id) => {
    if (get().active === id) set({ active: null });
  },
  resetAll: () => {
    writeSeen(new Set());
    set({ seen: new Set(), active: null });
  },
}));

/** 测试和截图工具用：把所有引导记为看过，免得气泡挡住别的断言。 */
export function markAllToursSeen() {
  const seen = new Set<TourId>(TOUR_IDS);
  writeSeen(seen);
  useTours.setState({ seen, active: null });
}
