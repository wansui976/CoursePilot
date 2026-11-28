import { create } from "zustand";

/**
 * 两处可换的「实物」样式，按设备记住（设置 → 外观）：
 * - 进度条：直尺（默认，章节长刻度、分钟短刻度、笔记处铅笔记号、摘录处荧光黄）或素色；
 * - 复习：单张卡（默认）或卡片盒（按下次到期分格，评完分卡片飞进对应的格子）。
 */
export type ProgressStyle = "ruler" | "plain";
export type ReviewStyle = "card" | "box";

const PROGRESS_KEY = "course-ai-progress-style";
const REVIEW_KEY = "course-ai-review-style";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 存储不可用时只在本次会话里生效。
  }
}

interface LookPrefsState {
  progressStyle: ProgressStyle;
  reviewStyle: ReviewStyle;
  setProgressStyle: (style: ProgressStyle) => void;
  setReviewStyle: (style: ReviewStyle) => void;
}

export const useLookPrefs = create<LookPrefsState>((set) => ({
  progressStyle: typeof window !== "undefined" && read(PROGRESS_KEY) === "plain" ? "plain" : "ruler",
  reviewStyle: typeof window !== "undefined" && read(REVIEW_KEY) === "box" ? "box" : "card",
  setProgressStyle: (progressStyle) => {
    write(PROGRESS_KEY, progressStyle);
    set({ progressStyle });
  },
  setReviewStyle: (reviewStyle) => {
    write(REVIEW_KEY, reviewStyle);
    set({ reviewStyle });
  },
}));
