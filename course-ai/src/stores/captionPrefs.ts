import { create } from "zustand";

/** 字幕显示：只看原文、原文+译文、只看译文。 */
export type CaptionMode = "original" | "bilingual" | "translation";
/** 可选的翻译目标语言。 */
export const TRANSLATION_LANGS = ["zh", "en", "ja", "ko"] as const;
export type TranslationLang = (typeof TRANSLATION_LANGS)[number];

const MODE_KEY = "course-ai-caption-mode";
const LANG_KEY = "course-ai-translation-lang";
const MODES: CaptionMode[] = ["original", "bilingual", "translation"];

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const value = window.localStorage.getItem(key);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function write(key: string, value: string) {
  if (typeof window !== "undefined") window.localStorage.setItem(key, value);
}

interface CaptionPrefsState {
  /** 全局、持久：外语课一般整门课都要看双语。 */
  mode: CaptionMode;
  lang: TranslationLang;
  /** 原文 → 双语 → 译文 → 原文。 */
  cycleMode: () => void;
  setMode: (mode: CaptionMode) => void;
  setLang: (lang: TranslationLang) => void;
}

export const useCaptionPrefs = create<CaptionPrefsState>((set, get) => ({
  mode: read(MODE_KEY, MODES, "original"),
  lang: read(LANG_KEY, TRANSLATION_LANGS, "zh"),
  cycleMode: () => get().setMode(MODES[(MODES.indexOf(get().mode) + 1) % MODES.length]),
  setMode: (mode) => {
    write(MODE_KEY, mode);
    set({ mode });
  },
  setLang: (lang) => {
    write(LANG_KEY, lang);
    set({ lang });
  },
}));
