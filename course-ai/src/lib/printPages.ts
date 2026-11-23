/**
 * 笔记打印成讲义（A4，见后端 notes_print_html）大概分几页、每页在编辑器里断在哪。
 *
 * 只是估算：把编辑器里的高度按「行高之比 × 每行能放几个字之比」换算成打印高度，
 * 再按 A4 的可打印高度切。字号、行宽和打印模板一致时，误差在半页以内。
 */
const PX_PER_MM = 96 / 25.4;
/** A4 297mm，上下页边各 18mm。 */
const PRINT_PAGE_PX = (297 - 36) * PX_PER_MM;
/** 正文栏宽 165mm。 */
const PRINT_TEXT_WIDTH_PX = 165 * PX_PER_MM;
/** 正文 11pt，行高 1.75。 */
const PRINT_FONT_PX = (11 * 96) / 72;
const PRINT_LINE_PX = PRINT_FONT_PX * 1.75;
/** 第一页顶上的课程名、标题和分隔线大约占的高度。 */
const PRINT_HEADER_PX = 30 * PX_PER_MM;

export interface PageEstimate {
  /** 估计共几页。 */
  pages: number;
  /** 第 2、3…页从编辑器里的哪个高度开始（像素，相对编辑器顶部）。 */
  breaks: number[];
}

export function estimatePrintPages({
  contentHeight,
  textWidth,
  fontPx,
  lineHeight = 1.7,
}: {
  /** 编辑器内容的高度（不含内边距）。 */
  contentHeight: number;
  /** 编辑器正文的宽度。 */
  textWidth: number;
  /** 编辑器正文字号。 */
  fontPx: number;
  lineHeight?: number;
}): PageEstimate {
  if (contentHeight <= 0 || textWidth <= 0 || fontPx <= 0) return { pages: 0, breaks: [] };
  const lineRatio = PRINT_LINE_PX / (fontPx * lineHeight);
  const charsHere = textWidth / fontPx;
  const charsPrinted = PRINT_TEXT_WIDTH_PX / PRINT_FONT_PX;
  const factor = lineRatio * (charsHere / charsPrinted);
  const printed = contentHeight * factor + PRINT_HEADER_PX;
  const pages = Math.max(1, Math.ceil(printed / PRINT_PAGE_PX));
  const breaks: number[] = [];
  for (let page = 1; page < pages; page++) {
    breaks.push((page * PRINT_PAGE_PX - PRINT_HEADER_PX) / factor);
  }
  return { pages, breaks };
}
