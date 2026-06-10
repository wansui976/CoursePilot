import { create } from "zustand";

// 可重映射的播放快捷键动作。J/L 默认是「上/下一句字幕」（无字幕回退到 ±10s）。
export type ShortcutAction =
  | "playPause"
  | "seekBack"
  | "seekForward"
  | "prevSubtitle"
  | "nextSubtitle"
  | "volumeUp"
  | "volumeDown"
  | "mute"
  | "fullscreen"
  | "captions";

export type ShortcutBindings = Record<ShortcutAction, string>;

export const SHORTCUT_ACTIONS: {
  action: ShortcutAction;
  label: string;
  hint?: string;
}[] = [
  { action: "playPause", label: "播放 / 暂停" },
  { action: "prevSubtitle", label: "上一句字幕", hint: "无字幕时回退到快退 10 秒" },
  { action: "nextSubtitle", label: "下一句字幕", hint: "无字幕时回退到快进 10 秒" },
  { action: "seekBack", label: "快退 5 秒" },
  { action: "seekForward", label: "快进 5 秒" },
  { action: "volumeUp", label: "音量 +" },
  { action: "volumeDown", label: "音量 -" },
  { action: "mute", label: "静音" },
  { action: "fullscreen", label: "全屏" },
  { action: "captions", label: "字幕开关" },
];

export const DEFAULT_BINDINGS: ShortcutBindings = {
  playPause: "k",
  prevSubtitle: "j",
  nextSubtitle: "l",
  seekBack: "ArrowLeft",
  seekForward: "ArrowRight",
  volumeUp: "ArrowUp",
  volumeDown: "ArrowDown",
  mute: "m",
  fullscreen: "f",
  captions: "c",
};

const STORAGE_KEY = "course-ai-shortcuts";

/** 归一化 KeyboardEvent.key：字母统一小写，其余（Arrow*、空格等）原样。 */
export function normalizeKey(key: string): string {
  if (key === " " || key === "Spacebar") return " ";
  return key.length === 1 ? key.toLowerCase() : key;
}

/** 给定按键，反查它绑定到的动作（无则 null）。 */
export function actionForKey(
  bindings: ShortcutBindings,
  key: string,
): ShortcutAction | null {
  const k = normalizeKey(key);
  for (const action of Object.keys(bindings) as ShortcutAction[]) {
    if (bindings[action] && normalizeKey(bindings[action]) === k) return action;
  }
  return null;
}

/** 人类可读的按键名（设置里显示用）。 */
export function keyLabel(key: string): string {
  if (!key) return "未设置";
  const named: Record<string, string> = {
    " ": "空格",
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Escape: "Esc",
  };
  if (named[key]) return named[key];
  return key.length === 1 ? key.toUpperCase() : key;
}

function loadBindings(): ShortcutBindings {
  if (typeof window === "undefined") return { ...DEFAULT_BINDINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_BINDINGS };
    const saved = JSON.parse(raw) as Partial<ShortcutBindings>;
    return { ...DEFAULT_BINDINGS, ...saved };
  } catch {
    return { ...DEFAULT_BINDINGS };
  }
}

function persist(bindings: ShortcutBindings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

interface ShortcutsState {
  bindings: ShortcutBindings;
  setBinding: (action: ShortcutAction, key: string) => void;
  resetBindings: () => void;
}

export const useShortcuts = create<ShortcutsState>((set) => ({
  bindings: loadBindings(),
  setBinding: (action, key) =>
    set((state) => {
      const norm = normalizeKey(key);
      const next: ShortcutBindings = { ...state.bindings };
      // 抢占：同一个键若已绑别的动作，先清掉那个，避免一键触发两件事。
      for (const other of Object.keys(next) as ShortcutAction[]) {
        if (other !== action && normalizeKey(next[other]) === norm) next[other] = "";
      }
      next[action] = norm;
      persist(next);
      return { bindings: next };
    }),
  resetBindings: () =>
    set(() => {
      const next = { ...DEFAULT_BINDINGS };
      persist(next);
      return { bindings: next };
    }),
}));
