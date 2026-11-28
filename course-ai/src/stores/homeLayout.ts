import { create } from "zustand";

/**
 * 主页样式：仪表盘（默认）或课桌。两种显示同样的内容，只是摆法不同。按设备记住。
 * 课程多于 4 门时仪表盘里的课程叠成牌堆；deckExpanded 记住用户是否点了「全部展开」。
 */
export type HomeLayout = "dashboard" | "desk";

const LAYOUT_KEY = "course-ai-home-layout";
const DECK_KEY = "course-ai-course-deck-expanded";
const WINDOW_KEY = "course-ai-desk-window";
const SHELF_KEY = "course-ai-course-shelf";

/** 课程库里课程怎么摆：封面卡片（默认）或一面书架。 */
export type CourseLibraryStyle = "cards" | "shelf";

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

export function readHomeLayout(): HomeLayout {
  return read(LAYOUT_KEY) === "desk" ? "desk" : "dashboard";
}

interface HomeLayoutState {
  layout: HomeLayout;
  deckExpanded: boolean;
  /** 课桌左上角的窗（纯装饰，可关）。 */
  deskWindow: boolean;
  courseStyle: CourseLibraryStyle;
  setLayout: (layout: HomeLayout) => void;
  setDeckExpanded: (expanded: boolean) => void;
  setDeskWindow: (on: boolean) => void;
  setCourseStyle: (style: CourseLibraryStyle) => void;
}

export const useHomeLayout = create<HomeLayoutState>((set) => ({
  layout: typeof window === "undefined" ? "dashboard" : readHomeLayout(),
  deckExpanded: typeof window === "undefined" ? false : read(DECK_KEY) === "1",
  deskWindow: typeof window === "undefined" ? true : read(WINDOW_KEY) !== "0",
  courseStyle: typeof window !== "undefined" && read(SHELF_KEY) === "shelf" ? "shelf" : "cards",
  setLayout: (layout) => {
    write(LAYOUT_KEY, layout);
    set({ layout });
  },
  setDeckExpanded: (deckExpanded) => {
    write(DECK_KEY, deckExpanded ? "1" : "0");
    set({ deckExpanded });
  },
  setDeskWindow: (deskWindow) => {
    write(WINDOW_KEY, deskWindow ? "1" : "0");
    set({ deskWindow });
  },
  setCourseStyle: (courseStyle) => {
    write(SHELF_KEY, courseStyle);
    set({ courseStyle });
  },
}));

/** 多于这么多门课时，仪表盘里的课程叠成牌堆。 */
export const DECK_THRESHOLD = 4;
