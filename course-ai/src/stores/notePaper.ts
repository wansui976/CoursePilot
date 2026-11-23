import { create } from "zustand";

/** 笔记页的纸：空白、横线、方格、点阵、米字格。按设备记住。 */
export type NotePaper = "plain" | "lined" | "grid" | "dots" | "mi";
export const NOTE_PAPERS: NotePaper[] = ["plain", "lined", "grid", "dots", "mi"];

const KEY = "course-ai-note-paper";
const TABS_KEY = "course-ai-note-tabs";

/** 长笔记侧边索引标签的样子：单色（纸色，只有当前那张用主题色）或彩色（每张一个标签色）。 */
export type NoteTabStyle = "plain" | "color";

function readPaper(): NotePaper {
  try {
    const saved = window.localStorage.getItem(KEY) as NotePaper | null;
    return saved && NOTE_PAPERS.includes(saved) ? saved : "plain";
  } catch {
    return "plain";
  }
}

function readTabStyle(): NoteTabStyle {
  try {
    return window.localStorage.getItem(TABS_KEY) === "color" ? "color" : "plain";
  } catch {
    return "plain";
  }
}

export const useNotePaper = create<{
  paper: NotePaper;
  tabStyle: NoteTabStyle;
  setPaper: (paper: NotePaper) => void;
  setTabStyle: (style: NoteTabStyle) => void;
}>((set) => ({
  paper: typeof window === "undefined" ? "plain" : readPaper(),
  tabStyle: typeof window === "undefined" ? "plain" : readTabStyle(),
  setTabStyle: (tabStyle) => {
    try {
      window.localStorage.setItem(TABS_KEY, tabStyle);
    } catch {
      // 存不下就只在这次会话里生效。
    }
    set({ tabStyle });
  },
  setPaper: (paper) => {
    try {
      window.localStorage.setItem(KEY, paper);
    } catch {
      // 存不下就只在这次会话里生效。
    }
    set({ paper });
  },
}));
