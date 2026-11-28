import { create } from "zustand";

/** 笔记页的纸：空白、横线、方格、点阵、米字格。按设备记住。 */
export type NotePaper = "plain" | "lined" | "grid" | "dots" | "mi";
export const NOTE_PAPERS: NotePaper[] = ["plain", "lined", "grid", "dots", "mi"];

const KEY = "course-ai-note-paper";
const TABS_KEY = "course-ai-note-tabs";

const FONT_KEY = "course-ai-note-font";

/** 笔记正文的字：衬线（默认，和全应用的阅读字一致）或手写（霞鹜文楷，像真的写在本子上）。 */
export type NoteFont = "serif" | "hand";

/** 手写体约 4.6MB、按字切成小块，只在第一次选了手写时才加载，之后浏览器按需取用到的字。 */
let handFontLoad: Promise<unknown> | null = null;
export function loadHandFont(): Promise<unknown> {
  handFontLoad ??= import("lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css").catch(() => {
    handFontLoad = null;
  });
  return handFontLoad;
}

function readFont(): NoteFont {
  try {
    return window.localStorage.getItem(FONT_KEY) === "hand" ? "hand" : "serif";
  } catch {
    return "serif";
  }
}

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
  font: NoteFont;
  setFont: (font: NoteFont) => void;
  setPaper: (paper: NotePaper) => void;
  setTabStyle: (style: NoteTabStyle) => void;
}>((set) => ({
  paper: typeof window === "undefined" ? "plain" : readPaper(),
  tabStyle: typeof window === "undefined" ? "plain" : readTabStyle(),
  font: typeof window === "undefined" ? "serif" : readFont(),
  setFont: (font) => {
    try {
      window.localStorage.setItem(FONT_KEY, font);
    } catch {
      // 存不下就只在这次会话里生效。
    }
    if (font === "hand") void loadHandFont();
    set({ font });
  },
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
