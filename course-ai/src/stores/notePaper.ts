import { create } from "zustand";

/** 笔记页的纸：空白、横线、方格、点阵、米字格。按设备记住。 */
export type NotePaper = "plain" | "lined" | "grid" | "dots" | "mi";
export const NOTE_PAPERS: NotePaper[] = ["plain", "lined", "grid", "dots", "mi"];

const KEY = "course-ai-note-paper";

function readPaper(): NotePaper {
  try {
    const saved = window.localStorage.getItem(KEY) as NotePaper | null;
    return saved && NOTE_PAPERS.includes(saved) ? saved : "plain";
  } catch {
    return "plain";
  }
}

export const useNotePaper = create<{ paper: NotePaper; setPaper: (paper: NotePaper) => void }>((set) => ({
  paper: typeof window === "undefined" ? "plain" : readPaper(),
  setPaper: (paper) => {
    try {
      window.localStorage.setItem(KEY, paper);
    } catch {
      // 存不下就只在这次会话里生效。
    }
    set({ paper });
  },
}));
