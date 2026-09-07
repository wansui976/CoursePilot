import { create } from "zustand";

export type DockSide = "left" | "right";

/** 浮动还是停靠成侧栏。停靠时面板贴边全高、内容让位，不再盖在阅读物上。 */
export type AssistantMode = "float" | "docked";

/** 存哪边、收没收起、多宽、浮/停靠。存起来是因为这是个常驻控件，每次打开都要重新摆一遍很烦人。 */
const SIDE_KEY = "assistant_dock_side";
const OPEN_KEY = "assistant_open";
const WIDTH_KEY = "assistant_panel_width";
const MODE_KEY = "assistant_mode";

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

/**
 * 没有历史偏好时的初始形态。默认停靠成侧栏——这是 IDE 式助手的主形态：
 * 全高、不挡内容、随手可用；浮球是收起后的入口，不是第一印象。
 */
export const DEFAULT_ASSISTANT_MODE: AssistantMode = "docked";

function readMode(): AssistantMode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    return stored === "float" || stored === "docked" ? stored : DEFAULT_ASSISTANT_MODE;
  } catch {
    return DEFAULT_ASSISTANT_MODE;
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
  /** 浮动（覆盖内容、可拖）还是停靠成侧栏（贴边全高、推开内容）。 */
  mode: AssistantMode;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** 吸附到某一边。 */
  dock: (side: DockSide) => void;
  setWidth: (width: number) => void;
  setMode: (mode: AssistantMode) => void;
}

export const useAssistantUi = create<AssistantUiState>((set, get) => ({
  open: readOpen(),
  side: readSide(),
  width: readWidth(),
  mode: readMode(),
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
  setMode: (mode) => {
    persist(MODE_KEY, mode);
    set({ mode });
  },
}));
