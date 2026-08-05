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
  i18nKey: string;
  i18nHint?: string;
}[] = [
  { action: "playPause", i18nKey: "settings.shortcuts.playPause" },
  { action: "prevSubtitle", i18nKey: "settings.shortcuts.prevSubtitle", i18nHint: "settings.shortcuts.prevSubtitleHint" },
  { action: "nextSubtitle", i18nKey: "settings.shortcuts.nextSubtitle", i18nHint: "settings.shortcuts.nextSubtitleHint" },
  { action: "seekBack", i18nKey: "settings.shortcuts.seekBack", i18nHint: "settings.shortcuts.seekBackHint" },
  { action: "seekForward", i18nKey: "settings.shortcuts.seekForward", i18nHint: "settings.shortcuts.seekForwardHint" },
  { action: "volumeUp", i18nKey: "settings.shortcuts.volumeUp" },
  { action: "volumeDown", i18nKey: "settings.shortcuts.volumeDown" },
  { action: "mute", i18nKey: "settings.shortcuts.mute" },
  { action: "fullscreen", i18nKey: "settings.shortcuts.fullscreen" },
  { action: "captions", i18nKey: "settings.shortcuts.captions" },
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

/** 人类可读的按键名（设置里显示用）。接收 t 函数以翻译 "未设置" / "空格"。 */
export function keyLabel(key: string, t: (k: string) => string): string {
  if (!key) return t("settings.shortcuts.notSet");
  const named: Record<string, string> = {
    " ": t("settings.shortcuts.space"),
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
