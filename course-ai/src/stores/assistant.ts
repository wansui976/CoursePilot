import { create } from "zustand";

export type DockSide = "left" | "right";

/** 存哪边、收没收起、多宽。存起来是因为这是个常驻控件，每次打开都要重新摆一遍很烦人。
 *  助手只有浮动一种形态：停靠侧栏会挤压播放器和学习面板的空间，已移除。 */
const SIDE_KEY = "assistant_dock_side";
const OPEN_KEY = "assistant_open";
const WIDTH_KEY = "assistant_panel_width";
/** 助手页面里选的模型（LLM profile id）。不存 = 跟随设置里的默认模型。 */
const MODEL_KEY = "assistant_model_profile";

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

function readModel(): string | null {
  try {
    return localStorage.getItem(MODEL_KEY) || null;
  } catch {
    return null;
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
  /** 面板关着时来了新回复：左侧工具栏与移动端入口都据此亮一个小圆点。 */
  unread: boolean;
  setUnread: (unread: boolean) => void;
  /**
   * 助手用哪个模型。null 跟随设置（任务路由里的 assistant）。
   * 只影响助手，不改设置里的路由——在这里换个模型试一句，不该连带把笔记、出题也换掉。
   */
  modelProfileId: string | null;
  setModelProfileId: (id: string | null) => void;
}

export const useAssistantUi = create<AssistantUiState>((set, get) => ({
  open: readOpen(),
  side: readSide(),
  width: readWidth(),
  unread: false,
  setUnread: (unread) => set({ unread }),
  modelProfileId: readModel(),
  setModelProfileId: (id) => {
    try {
      if (id) localStorage.setItem(MODEL_KEY, id);
      else localStorage.removeItem(MODEL_KEY);
    } catch {
      // 记不住就只在本次运行里生效。
    }
    set({ modelProfileId: id });
  },
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
