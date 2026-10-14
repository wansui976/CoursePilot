/** 字幕字号拟合：先按框高给出上限，再按框宽估算折行，放不下就逐步缩小。 */

export const CAPTION_SAFE_LINES = 2;
export const CAPTION_LINE_HEIGHT = 1.375; // Tailwind `leading-snug`
export const CAPTION_SAFE_HEIGHT_RATIO = 0.9;
/** 双语时译文行按原文的 0.82 倍字号排。 */
export const TRANSLATION_SCALE = 0.82;
/** 字幕按钮左右内边距（px-3 × 2）。 */
const PADDING_X = 24;
const MAX_FONT = 120;

// 全角范围：谚文字母、中日韩部首至彝文、谚文音节、兼容汉字、竖排标点、全角形式。
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** 一段文字以 1em 为单位的估算宽度：中日韩全角字约 1em，其余（拉丁、数字、空格）约 0.55em。 */
function emWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += WIDE_CHAR.test(ch) ? 1 : 0.55;
  return width;
}

function estimatedLines(text: string, fontSize: number, widthPx: number): number {
  return Math.max(1, Math.ceil((emWidth(text) * fontSize) / widthPx));
}

/**
 * 给定字幕框的像素尺寸与文字，返回字号。
 *
 * 上限沿用原先的高度公式（原文预留两行、双语再加一行 0.82 倍的译文），正常长度的
 * 字幕结果不变；只有按宽度估算会折成更多行、超出框高时才继续缩小——窄屏（手机竖屏）
 * 上的长译文原先会被字幕框裁掉。量不到宽度（jsdom、首帧）时跳过宽度这一步。
 */
export function fitCaptionFontSize({
  boxWidthPx,
  boxHeightPx,
  primary,
  translation,
}: {
  boxWidthPx: number;
  boxHeightPx: number;
  primary: string;
  /** 双语模式下的译文；单语传 undefined。 */
  translation?: string;
}): number {
  const available = boxHeightPx * CAPTION_SAFE_HEIGHT_RATIO;
  const min = translation ? 10 : 12;
  const safeLines = CAPTION_SAFE_LINES + (translation ? TRANSLATION_SCALE : 0);
  let fontSize = Math.min(MAX_FONT, Math.max(min, available / (safeLines * CAPTION_LINE_HEIGHT)));

  const textWidth = boxWidthPx - PADDING_X;
  if (textWidth <= 0) return fontSize;
  while (fontSize > min) {
    const lines =
      estimatedLines(primary, fontSize, textWidth) +
      (translation
        ? TRANSLATION_SCALE * estimatedLines(translation, fontSize * TRANSLATION_SCALE, textWidth)
        : 0);
    if (lines * fontSize * CAPTION_LINE_HEIGHT <= available) break;
    fontSize -= 0.5;
  }
  return Math.max(min, fontSize);
}

/**
 * 按给定字号估算字幕内容需要的框高（像素，含安全余量）。字号已到下限仍放不下时
 * （手机竖屏的矮舞台），字幕框据此向上长高，而不是把字裁掉。量不到宽度时返回 0。
 */
export function captionRequiredHeight({
  fontSize,
  boxWidthPx,
  primary,
  translation,
}: {
  fontSize: number;
  boxWidthPx: number;
  primary: string;
  translation?: string;
}): number {
  const textWidth = boxWidthPx - PADDING_X;
  if (textWidth <= 0) return 0;
  const lines =
    estimatedLines(primary, fontSize, textWidth) +
    (translation
      ? TRANSLATION_SCALE * estimatedLines(translation, fontSize * TRANSLATION_SCALE, textWidth)
      : 0);
  return (lines * fontSize * CAPTION_LINE_HEIGHT) / CAPTION_SAFE_HEIGHT_RATIO;
}
