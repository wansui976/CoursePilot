import { create } from "zustand";

/**
 * 阅读字体与字号：笔记、摘要、复习卡片等「读」的内容（.ca-reading）用哪款字体、多大。
 * 界面文字不受影响。
 *
 * 各平台自带的中文字体不同：楷体、仿宋 macOS 与 Windows 自带，iOS / Android 通常没有；
 * Windows 没有像样的宋体。所以每个选项都先检测本机是否有，没有就在设置里置灰。
 */
export type ReadingFont = "serif" | "sans" | "kai" | "fangsong";
/** 阅读字号档位：缩放阅读区正文（--reading-scale），界面文字不变。 */
export type ReadingSize = "small" | "medium" | "large";

const STORAGE_KEY = "course-ai-reading-font";
const SIZE_STORAGE_KEY = "course-ai-reading-size";
const DEFAULT_SIZE: ReadingSize = "medium";

export const READING_SIZES: { key: ReadingSize; i18nKey: string; scale: number }[] = [
  { key: "small", i18nKey: "settings.appearance.readingSizeSmall", scale: 0.92 },
  { key: "medium", i18nKey: "settings.appearance.readingSizeMedium", scale: 1 },
  { key: "large", i18nKey: "settings.appearance.readingSizeLarge", scale: 1.12 },
];
const DEFAULT_FONT: ReadingFont = "serif";

/** 中文字体候选（按平台常见名排列）；西文部分与兜底随后统一拼上。 */
const CJK_FAMILIES: Record<ReadingFont, string[]> = {
  serif: ["Songti SC", "STSong", "Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", "Source Han Serif CN"],
  sans: [],
  kai: ["Kaiti SC", "STKaiti", "KaiTi", "KaiTi_GB2312", "BiauKai"],
  fangsong: ["STFangsong", "FangSong", "FangSong_GB2312"],
};

/** 西文：衬线类选项配一款衬线西文，黑体沿用界面字体。 */
const LATIN_SERIF = ['"Iowan Old Style"', '"Charter"', '"Georgia"'];

export const READING_FONTS: { key: ReadingFont; i18nKey: string }[] = [
  { key: "serif", i18nKey: "settings.appearance.readingFontSerif" },
  { key: "sans", i18nKey: "settings.appearance.readingFontSans" },
  { key: "kai", i18nKey: "settings.appearance.readingFontKai" },
  { key: "fangsong", i18nKey: "settings.appearance.readingFontFangsong" },
];

/**
 * 某个选项完整的 font-family 值。中文候选都落空时回到界面字体（var(--font-app)），
 * 故意不写 serif 兜底——Windows 上它会落到小字号发虚的 SimSun。
 */
export function readingFontStack(font: ReadingFont): string {
  if (font === "sans") return "var(--font-app)";
  const cjk = CJK_FAMILIES[font].map((name) => `"${name}"`);
  return [...LATIN_SERIF, ...cjk, "var(--font-app)"].join(", ");
}

/**
 * 本机是否装了这个选项的中文字体。用画布量字宽：候选字体排一段样字，宽度和兜底字体完全一样，
 * 就说明候选没生效。document.fonts.check 对本机字体不可靠。
 * 样字用西文字母和数字，不能用汉字——汉字是等宽方块，任何中文字体每个字都正好 1em，
 * 装没装量出来都一样；而各中文字体自带的西文字形宽度互不相同。
 */
export function isReadingFontAvailable(font: ReadingFont): boolean {
  if (font === "sans") return true;
  if (typeof document === "undefined") return true;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return true;
  const sample = "mmmmmmmmmmlli WMwm 0123456789 abcdefghijklmnopqrstuvwxyz";
  const width = (family: string) => {
    context.font = `32px ${family}`;
    return context.measureText(sample).width;
  };
  return CJK_FAMILIES[font].some((name) =>
    ["monospace", "sans-serif"].some((fallback) => width(`"${name}", ${fallback}`) !== width(fallback)),
  );
}

function readFont(): ReadingFont {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return READING_FONTS.some((option) => option.key === value) ? (value as ReadingFont) : DEFAULT_FONT;
  } catch {
    return DEFAULT_FONT;
  }
}

function readSize(): ReadingSize {
  try {
    const value = localStorage.getItem(SIZE_STORAGE_KEY);
    return READING_SIZES.some((option) => option.key === value) ? (value as ReadingSize) : DEFAULT_SIZE;
  } catch {
    return DEFAULT_SIZE;
  }
}

/** 写到 <html> 上：浮层（对话框、复习会话）经 Portal 挂在 body，也要拿到同一个值。 */
function apply(font: ReadingFont) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--font-reading", readingFontStack(font));
}

function applySize(size: ReadingSize) {
  if (typeof document === "undefined") return;
  const scale = READING_SIZES.find((option) => option.key === size)?.scale ?? 1;
  document.documentElement.style.setProperty("--reading-scale", String(scale));
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存不下只是下次启动回到默认，不影响这次切换。
  }
}

interface ReadingFontState {
  font: ReadingFont;
  size: ReadingSize;
  setFont: (font: ReadingFont) => void;
  setSize: (size: ReadingSize) => void;
}

export const useReadingFont = create<ReadingFontState>((set) => {
  const initial = readFont();
  const initialSize = readSize();
  apply(initial);
  applySize(initialSize);
  return {
    font: initial,
    size: initialSize,
    setFont: (font) => {
      persist(STORAGE_KEY, font);
      apply(font);
      set({ font });
    },
    setSize: (size) => {
      persist(SIZE_STORAGE_KEY, size);
      applySize(size);
      set({ size });
    },
  };
});
