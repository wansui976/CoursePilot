import { create } from "zustand";

const KEY = "course-ai-show-timestamps";

/** 读初值：无值 / 非 "0" 一律按显示（默认显示，与旧行为一致）。 */
function readShow(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(KEY) !== "0";
}

function persist(show: boolean): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(KEY, show ? "1" : "0");
  }
}

interface TimestampPrefsState {
  /** 笔记 / 提问里可点击时间戳（▶ mm:ss）是否显示。全局、持久。 */
  showTimestamps: boolean;
  toggle: () => void;
  setShow: (show: boolean) => void;
}

export const useTimestampPrefs = create<TimestampPrefsState>((set, get) => ({
  showTimestamps: readShow(),
  toggle: () => {
    const next = !get().showTimestamps;
    persist(next);
    set({ showTimestamps: next });
  },
  setShow: (show) => {
    persist(show);
    set({ showTimestamps: show });
  },
}));
