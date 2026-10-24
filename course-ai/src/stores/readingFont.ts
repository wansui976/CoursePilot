import { create } from "zustand";

/**
 * 阅读字体：笔记、摘要、复习卡片等「读」的内容（.ca-reading）用哪款字体。界面文字不受影响。
 *
 * 各平台自带的中文字体不同：楷体、仿宋 macOS 与 Windows 自带，iOS / Android 通常没有；
 * Windows 没有像样的宋体。所以每个选项都先检测本机是否有，没有就在设置里置灰。
 */
export type ReadingFont = "serif" | "sans" | "kai" | "fangsong";

const STORAGE_KEY = "course-ai-reading-font";
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

/** 写到 <html> 上：浮层（对话框、复习会话）经 Portal 挂在 body，也要拿到同一个值。 */
function apply(font: ReadingFont) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--font-reading", readingFontStack(font));
}

interface ReadingFontState {
  font: ReadingFont;
  setFont: (font: ReadingFont) => void;
}

export const useReadingFont = create<ReadingFontState>((set) => {
  const initial = readFont();
  apply(initial);
  return {
    font: initial,
    setFont: (font) => {
      try {
        localStorage.setItem(STORAGE_KEY, font);
      } catch {
        // 存不下只是下次启动回到默认，不影响这次切换。
      }
      apply(font);
      set({ font });
    },
  };
});
