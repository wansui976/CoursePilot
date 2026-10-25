import { create } from "zustand";

/** 字幕显示：只看原文、原文+译文、只看译文。 */
export type CaptionMode = "original" | "bilingual" | "translation";
/** 可选的翻译目标语言。 */
export const TRANSLATION_LANGS = ["zh", "en", "ja", "ko"] as const;
export type TranslationLang = (typeof TRANSLATION_LANGS)[number];
/** 字幕字号档位：在按字幕框自适应出的字号上再乘一个系数。 */
export const CAPTION_SIZES = ["small", "medium", "large", "xlarge"] as const;
export type CaptionSize = (typeof CAPTION_SIZES)[number];
export const CAPTION_SIZE_SCALE: Record<CaptionSize, number> = {
  small: 0.8,
  medium: 1,
  large: 1.2,
  xlarge: 1.4,
};
/** 字幕底：无底只描边（B 站默认）、半透明逐行底（YouTube 默认）、深色逐行底。 */
export const CAPTION_BACKGROUNDS = ["none", "translucent", "solid"] as const;
export type CaptionBackground = (typeof CAPTION_BACKGROUNDS)[number];

const MODE_KEY = "course-ai-caption-mode";
const LANG_KEY = "course-ai-translation-lang";
const SIZE_KEY = "course-ai-caption-size";
const BACKGROUND_KEY = "course-ai-caption-background";
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
  size: CaptionSize;
  background: CaptionBackground;
  /** 原文 → 双语 → 译文 → 原文。 */
  cycleMode: () => void;
  setMode: (mode: CaptionMode) => void;
  setLang: (lang: TranslationLang) => void;
  setSize: (size: CaptionSize) => void;
  setBackground: (background: CaptionBackground) => void;
}

export const useCaptionPrefs = create<CaptionPrefsState>((set, get) => ({
  mode: read(MODE_KEY, MODES, "original"),
  lang: read(LANG_KEY, TRANSLATION_LANGS, "zh"),
  size: read(SIZE_KEY, CAPTION_SIZES, "medium"),
  background: read(BACKGROUND_KEY, CAPTION_BACKGROUNDS, "translucent"),
  cycleMode: () => get().setMode(MODES[(MODES.indexOf(get().mode) + 1) % MODES.length]),
  setMode: (mode) => {
    write(MODE_KEY, mode);
    set({ mode });
  },
  setLang: (lang) => {
    write(LANG_KEY, lang);
    set({ lang });
  },
  setSize: (size) => {
    write(SIZE_KEY, size);
    set({ size });
  },
  setBackground: (background) => {
    write(BACKGROUND_KEY, background);
    set({ background });
  },
}));
