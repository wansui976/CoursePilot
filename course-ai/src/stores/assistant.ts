import { create } from "zustand";

export type DockSide = "left" | "right";

/** 存哪边、收没收起。存起来是因为这是个常驻控件，每次打开都要重新摆一遍很烦人。 */
const SIDE_KEY = "assistant_dock_side";
const OPEN_KEY = "assistant_open";

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
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** 吸附到某一边。 */
  dock: (side: DockSide) => void;
}

export const useAssistantUi = create<AssistantUiState>((set, get) => ({
  open: readOpen(),
  side: readSide(),
  setOpen: (open) => {
    persist(OPEN_KEY, open ? "1" : "0");
    set({ open });
  },
  toggle: () => get().setOpen(!get().open),
  dock: (side) => {
    persist(SIDE_KEY, side);
    set({ side });
  },
}));
