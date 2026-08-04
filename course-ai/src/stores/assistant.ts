import { create } from "zustand";

export type DockSide = "left" | "right";

/** 存哪边、收没收起、多宽。存起来是因为这是个常驻控件，每次打开都要重新摆一遍很烦人。 */
const SIDE_KEY = "assistant_dock_side";
const OPEN_KEY = "assistant_open";
const WIDTH_KEY = "assistant_panel_width";

/**
 * 面板宽度的上下限。
 *
 * 下限是「一行还能放下十几个汉字」，再窄回答里的列表和公式就开始逐字换行；
 * 上限是长文的舒适阅读宽度——再宽眼睛要横扫一整屏才回得来，而且它是浮在内容
 * 上面的，占掉半个窗口就成了遮挡。
 */
export const MIN_PANEL_WIDTH = 320;
export const MAX_PANEL_WIDTH = 720;
const DEFAULT_PANEL_WIDTH = 380;

function readSide(): DockSide {
  try {
    return localStorage.getItem(SIDE_KEY) === "left" ? "left" : "right";
  } catch {
    // 隐私模式或存储被禁用时 localStorage 会抛错。这只是个偏好，退回默认即可。
    return "right";
  }
}

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function clampPanelWidth(width: number) {
  if (!Number.isFinite(width)) return DEFAULT_PANEL_WIDTH;
  return Math.min(Math.max(Math.round(width), MIN_PANEL_WIDTH), MAX_PANEL_WIDTH);
}

function readWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    return raw === null ? DEFAULT_PANEL_WIDTH : clampPanelWidth(Number(raw));
  } catch {
    return DEFAULT_PANEL_WIDTH;
  }
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 同上：存不下就算了，不该因为记不住位置而让面板打不开。
  }
}

interface AssistantUiState {
  open: boolean;
  side: DockSide;
  /** 桌面端面板宽度，用户拖内侧边框调，越界的值一律夹回区间。 */
  width: number;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** 吸附到某一边。 */
  dock: (side: DockSide) => void;
  setWidth: (width: number) => void;
}

export const useAssistantUi = create<AssistantUiState>((set, get) => ({
  open: readOpen(),
  side: readSide(),
  width: readWidth(),
  setOpen: (open) => {
    persist(OPEN_KEY, open ? "1" : "0");
    set({ open });
  },
  toggle: () => get().setOpen(!get().open),
  dock: (side) => {
    persist(SIDE_KEY, side);
    set({ side });
  },
  setWidth: (width) => {
    const clamped = clampPanelWidth(width);
    persist(WIDTH_KEY, String(clamped));
    set({ width: clamped });
  },
}));
