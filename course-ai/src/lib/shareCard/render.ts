// 分享图绘制：笔记长图、脑图、学习周报。直接用 Canvas 2D 画——WKWebView 里把 DOM
// 转成图片（SVG foreignObject）不可靠，脑图节点本身也是 foreignObject，自己画最稳。
// 排版逻辑（拆块、折行、树布局）在 ./layout.ts，这里只负责坐标和样式。

import {
  layoutTree,
  parseNoteBlocks,
  wrapLines,
  type Measure,
  type NoteBlock,
  type TreeInput,
} from "./layout";

/** 逻辑宽度；按 SCALE 倍输出，成图 1080px 宽，适合手机端分享。 */
const WIDTH = 540;
const SCALE = 2;
const PAD = 32;
const CONTENT = WIDTH - PAD * 2;
/** 长图最高（逻辑像素），再长就截断并提示去 App 里看完整版。 */
const MAX_NOTES_HEIGHT = 5200;

const FONT_STACK = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
const font = (size: number, weight = 400) => `${weight} ${size}px ${FONT_STACK}`;

const INK = "#1d1d1f";
const MUTED = "#6e6e73";
const LINE = "#e5e5ea";
const ACCENT = "#7c4dff";
const ACCENT_SOFT = "#f3efff";
/** 脑图各一级分支的颜色。 */
const BRANCH_COLORS = ["#7c4dff", "#0a84ff", "#30b158", "#ff9f0a", "#ff375f", "#5ac8fa", "#bf5af2", "#a2845e"];

export interface ShareCardLabels {
  /** 页脚标语。 */
  tagline: string;
  /** 截断时的提示。 */
  truncated: string;
}

export interface CardHeader {
  /** 课程名（可空）。 */
  course: string;
  title: string;
  /** 类型标签，如「课堂笔记」「知识脑图」。 */
  kind: string;
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * SCALE);
  canvas.height = Math.ceil(height * SCALE);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = "alphabetic";
  return { canvas, ctx };
}

/** 用离屏 canvas 测宽，供排版阶段（还不知道画布多高）使用。 */
function makeMeasure(): Measure {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  return (text, f) => {
    ctx.font = f;
    return ctx.measureText(text).width;
  };
}

// ---------------------------------------------------------------- 公共：页眉页脚

interface HeaderLayout {
  height: number;
  courseLine: string | null;
  titleLines: string[];
  kind: string;
}

function layoutHeader(header: CardHeader, measure: Measure, width = CONTENT): HeaderLayout {
  const titleLines = wrapLines(header.title, width, font(22, 700), measure).slice(0, 3);
  const courseLine = header.course.trim() ? header.course.trim() : null;
  const height = 6 + 28 + (courseLine ? 22 : 0) + titleLines.length * 31 + 26 + 18;
  return { height, courseLine, titleLines, kind: header.kind };
}

function drawHeader(ctx: CanvasRenderingContext2D, layout: HeaderLayout, x: number, width: number) {
  const band = ctx.createLinearGradient(0, 0, width + x * 2, 0);
  band.addColorStop(0, ACCENT);
  band.addColorStop(1, "#a78bfa");
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, width + x * 2, 6);
  let y = 6 + 28;
  if (layout.courseLine) {
    ctx.font = font(13, 600);
    ctx.fillStyle = ACCENT;
    ctx.fillText(layout.courseLine, x, y);
    y += 22;
  }
  ctx.font = font(22, 700);
  ctx.fillStyle = INK;
  for (const line of layout.titleLines) {
    y += 24;
    ctx.fillText(line, x, y);
    y += 7;
  }
  // 类型标签：圆角色块。
  ctx.font = font(12, 600);
  const tagWidth = ctx.measureText(layout.kind).width + 16;
  y += 8;
  roundRect(ctx, x, y, tagWidth, 20, 10);
  ctx.fillStyle = ACCENT_SOFT;
  ctx.fill();
  ctx.fillStyle = ACCENT;
  ctx.fillText(layout.kind, x + 8, y + 14);
}

const FOOTER_HEIGHT = 84;

function drawFooter(ctx: CanvasRenderingContext2D, top: number, x: number, width: number, labels: ShareCardLabels) {
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, top + 0.5);
  ctx.lineTo(x + width, top + 0.5);
  ctx.stroke();
  // 简化版应用图标：圆角方块 + 播放三角。
  const iconY = top + 22;
  roundRect(ctx, x, iconY, 36, 36, 9);
  ctx.fillStyle = "#2f6bff";
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(x + 14, iconY + 11);
  ctx.lineTo(x + 25, iconY + 18);
  ctx.lineTo(x + 14, iconY + 25);
  ctx.closePath();
  ctx.fill();
  ctx.font = font(15, 700);
  ctx.fillStyle = INK;
  ctx.fillText("CoursePilot", x + 48, iconY + 15);
  ctx.font = font(12);
  ctx.fillStyle = MUTED;
  ctx.fillText(labels.tagline, x + 48, iconY + 33);
  ctx.font = font(11);
  const repo = "github.com/wansui976/CoursePilot";
  ctx.fillText(repo, x + width - ctx.measureText(repo).width, iconY + 33);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fillBackground(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
}

// ---------------------------------------------------------------- 笔记长图

type DrawOp = (ctx: CanvasRenderingContext2D, top: number) => void;
interface PlacedBlock {
  height: number;
  draw: DrawOp;
}

function placeBlock(block: NoteBlock, measure: Measure): PlacedBlock {
  switch (block.kind) {
    case "heading": {
      const size = block.level <= 1 ? 19 : block.level === 2 ? 17 : 15;
      const f = font(size, 700);
      const lines = wrapLines(block.text, CONTENT - 14, f, measure);
      const lineH = size + 9;
      const height = 14 + lines.length * lineH + 4;
      return {
        height,
        draw: (ctx, top) => {
          ctx.fillStyle = ACCENT;
          roundRect(ctx, PAD, top + 14 + 3, 4, lines.length * lineH - 6, 2);
          ctx.fill();
          ctx.font = f;
          ctx.fillStyle = INK;
          lines.forEach((line, i) => ctx.fillText(line, PAD + 14, top + 14 + i * lineH + size));
        },
      };
    }
    case "bullet": {
      const f = font(15);
      const indent = 18 + block.depth * 18;
      const lines = wrapLines(block.text, CONTENT - indent, f, measure);
      const lineH = 24;
      return {
        height: lines.length * lineH + 4,
        draw: (ctx, top) => {
          ctx.font = f;
          ctx.fillStyle = block.depth === 0 ? ACCENT : MUTED;
          const markerX = PAD + indent - 16;
          if (block.marker === "•") {
            ctx.beginPath();
            ctx.arc(markerX + 4, top + 12, block.depth === 0 ? 3 : 2.5, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.font = font(14, 600);
            ctx.fillText(block.marker, markerX - 2, top + 17);
            ctx.font = f;
          }
          ctx.fillStyle = INK;
          lines.forEach((line, i) => ctx.fillText(line, PAD + indent, top + 17 + i * lineH));
        },
      };
    }
    case "paragraph": {
      const f = font(15);
      const lines = wrapLines(block.text, CONTENT, f, measure);
      return {
        height: lines.length * 24 + 8,
        draw: (ctx, top) => {
          ctx.font = f;
          ctx.fillStyle = INK;
          lines.forEach((line, i) => ctx.fillText(line, PAD, top + 17 + i * 24));
        },
      };
    }
    case "quote": {
      const f = font(14);
      const lines = wrapLines(block.text, CONTENT - 28, f, measure);
      const height = lines.length * 22 + 20;
      return {
        height: height + 8,
        draw: (ctx, top) => {
          roundRect(ctx, PAD, top + 4, CONTENT, height, 8);
          ctx.fillStyle = ACCENT_SOFT;
          ctx.fill();
          ctx.fillStyle = ACCENT;
          ctx.fillRect(PAD, top + 4, 3, height);
          ctx.font = f;
          ctx.fillStyle = "#3a3a3c";
          lines.forEach((line, i) => ctx.fillText(line, PAD + 16, top + 4 + 25 + i * 22));
        },
      };
    }
    case "table": {
      const columns = Math.max(block.header.length, ...block.rows.map((r) => r.length));
      const colWidth = CONTENT / Math.max(1, columns);
      const cellPad = 8;
      const lineH = 19;
      const wrapRow = (cells: string[], f: string) =>
        Array.from({ length: columns }, (_, c) =>
          wrapLines(cells[c] ?? "", colWidth - cellPad * 2, f, measure),
        );
      const headerFont = font(13, 700);
      const cellFont = font(13);
      const rows = [wrapRow(block.header, headerFont), ...block.rows.map((r) => wrapRow(r, cellFont))];
      const heights = rows.map((cells) => Math.max(1, ...cells.map((l) => l.length)) * lineH + cellPad * 2);
      const total = heights.reduce((a, b) => a + b, 0);
      return {
        height: total + 16,
        draw: (ctx, top) => {
          let y = top + 8;
          roundRect(ctx, PAD, y, CONTENT, total, 8);
          ctx.save();
          ctx.clip();
          rows.forEach((cells, r) => {
            ctx.fillStyle = r === 0 ? ACCENT_SOFT : r % 2 === 0 ? "#fafafc" : "#ffffff";
            ctx.fillRect(PAD, y, CONTENT, heights[r]);
            ctx.font = r === 0 ? headerFont : cellFont;
            ctx.fillStyle = r === 0 ? ACCENT : INK;
            cells.forEach((lines, c) =>
              lines.forEach((line, i) =>
                ctx.fillText(line, PAD + c * colWidth + cellPad, y + cellPad + 14 + i * lineH),
              ),
            );
            y += heights[r];
            ctx.strokeStyle = LINE;
            ctx.beginPath();
            ctx.moveTo(PAD, y + 0.5);
            ctx.lineTo(PAD + CONTENT, y + 0.5);
            ctx.stroke();
          });
          ctx.restore();
          roundRect(ctx, PAD, top + 8, CONTENT, total, 8);
          ctx.strokeStyle = LINE;
          ctx.stroke();
        },
      };
    }
  }
}

/** 笔记长图：把笔记 Markdown 排成一张竖版长图。 */
export function renderNotesCard(header: CardHeader, markdown: string, labels: ShareCardLabels): HTMLCanvasElement {
  const measure = makeMeasure();
  const head = layoutHeader(header, measure);
  const placed: PlacedBlock[] = [];
  let contentHeight = 0;
  let truncated = false;
  for (const block of parseNoteBlocks(markdown)) {
    const item = placeBlock(block, measure);
    if (head.height + contentHeight + item.height > MAX_NOTES_HEIGHT) {
      truncated = true;
      break;
    }
    placed.push(item);
    contentHeight += item.height;
  }
  const noteHeight = truncated ? 40 : 0;
  const height = head.height + contentHeight + noteHeight + 24 + FOOTER_HEIGHT;
  const { canvas, ctx } = createCanvas(WIDTH, height);
  fillBackground(ctx, WIDTH, height);
  drawHeader(ctx, head, PAD, CONTENT);
  let y = head.height;
  for (const item of placed) {
    item.draw(ctx, y);
    y += item.height;
  }
  if (truncated) {
    ctx.font = font(13);
    ctx.fillStyle = MUTED;
    ctx.fillText(labels.truncated, PAD, y + 26);
    y += noteHeight;
  }
  drawFooter(ctx, y + 24, PAD, CONTENT, labels);
  return canvas;
}

// ---------------------------------------------------------------- 脑图

/** 脑图：横向树，一级分支各一种颜色。宽度随层级自适应。 */
export function renderMindmapCard(header: CardHeader, root: TreeInput, labels: ShareCardLabels): HTMLCanvasElement {
  const measure = makeMeasure();
  const fontForDepth = (depth: number) =>
    depth === 0 ? font(17, 700) : depth === 1 ? font(15, 600) : font(13);
  const tree = layoutTree(root, {
    measure,
    fontForDepth,
    maxTextWidth: 260,
    rowHeight: 30,
    columnGap: 44,
  });
  const width = Math.max(WIDTH, tree.width + PAD * 2);
  const contentWidth = width - PAD * 2;
  const head = layoutHeader(header, measure, Math.min(contentWidth, 640));
  const treeTop = head.height + 8;
  const height = treeTop + tree.height + 24 + FOOTER_HEIGHT;
  const { canvas, ctx } = createCanvas(width, height);
  fillBackground(ctx, width, height);
  drawHeader(ctx, head, PAD, contentWidth);

  const colorOf = (branch: number) => (branch < 0 ? INK : BRANCH_COLORS[branch % BRANCH_COLORS.length]);
  const ox = PAD;
  const oy = treeTop;
  ctx.lineWidth = 1.6;
  for (const node of tree.nodes) {
    if (!node.parent) continue;
    const parent = node.parent;
    const x1 = ox + parent.x + parent.width + 6;
    const y1 = oy + parent.y;
    const x2 = ox + node.x - 6;
    const y2 = oy + node.y;
    ctx.strokeStyle = colorOf(node.branch);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo((x1 + x2) / 2, y1, (x1 + x2) / 2, y2, x2, y2);
    ctx.stroke();
  }
  for (const node of tree.nodes) {
    const x = ox + node.x;
    const y = oy + node.y;
    const color = colorOf(node.branch);
    if (node.depth === 0) {
      roundRect(ctx, x - 8, y - 16, node.width + 16, 32, 10);
      ctx.fillStyle = ACCENT_SOFT;
      ctx.fill();
    }
    ctx.font = fontForDepth(node.depth);
    ctx.fillStyle = node.depth <= 1 ? color : INK;
    ctx.fillText(node.text, x, y + 5);
    if (node.depth > 0) {
      // markmap 风格：文字下方一道同色细线。
      ctx.strokeStyle = color;
      ctx.lineWidth = node.depth === 1 ? 2 : 1.2;
      ctx.beginPath();
      ctx.moveTo(x - 6, y + 10);
      ctx.lineTo(x + node.width + 6, y + 10);
      ctx.stroke();
      ctx.lineWidth = 1.6;
    }
  }
  drawFooter(ctx, oy + tree.height + 24, PAD, contentWidth, labels);
  return canvas;
}

// ---------------------------------------------------------------- 学习周报

export interface WeeklyReport {
  /** 例如「10/03 – 10/09」。 */
  range: string;
  /** 本周学习总时长（已格式化）。 */
  totalTime: string;
  studiedDays: number;
  reviews: number;
  /** 0..100；没有复习时为 null。 */
  accuracy: number | null;
  streak: number;
  /** 最近 7 天，从早到晚。 */
  days: { label: string; minutes: number }[];
  weakTopics: string[];
}

export interface WeeklyLabels extends ShareCardLabels {
  title: string;
  totalTime: string;
  studiedDays: string;
  reviews: string;
  accuracy: string;
  /** 带 {{days}} 占位的连续学习文案，如「连续学习 {{days}} 天」。 */
  streak: string;
  minutesChart: string;
  weakTopics: string;
  noWeakTopics: string;
}

/** 学习周报：四个数字 + 七天柱状图 + 薄弱主题。 */
export function renderWeeklyCard(report: WeeklyReport, labels: WeeklyLabels): HTMLCanvasElement {
  const measure = makeMeasure();
  const head = layoutHeader(
    { course: report.range, title: labels.title, kind: labels.streak.replace("{{days}}", String(report.streak)) },
    measure,
  );
  const statsTop = head.height + 4;
  const statH = 84;
  const chartTop = statsTop + statH * 2 + 12 + 44;
  const chartH = 170;
  const weakTop = chartTop + chartH + 36;
  const weakLines = report.weakTopics.length > 0 ? report.weakTopics.slice(0, 4) : [labels.noWeakTopics];
  const height = weakTop + 26 + weakLines.length * 30 + 24 + FOOTER_HEIGHT;
  const { canvas, ctx } = createCanvas(WIDTH, height);
  fillBackground(ctx, WIDTH, height);
  drawHeader(ctx, head, PAD, CONTENT);

  const stats: [string, string][] = [
    [labels.totalTime, report.totalTime],
    [labels.studiedDays, `${report.studiedDays} / 7`],
    [labels.reviews, String(report.reviews)],
    [labels.accuracy, report.accuracy == null ? "—" : `${Math.round(report.accuracy)}%`],
  ];
  const cellW = (CONTENT - 12) / 2;
  stats.forEach(([label, value], i) => {
    const x = PAD + (i % 2) * (cellW + 12);
    const y = statsTop + Math.floor(i / 2) * (statH + 12);
    roundRect(ctx, x, y, cellW, statH, 12);
    ctx.fillStyle = i === 0 ? ACCENT_SOFT : "#f5f5f7";
    ctx.fill();
    ctx.font = font(12);
    ctx.fillStyle = MUTED;
    ctx.fillText(label, x + 16, y + 26);
    ctx.font = font(26, 700);
    ctx.fillStyle = i === 0 ? ACCENT : INK;
    ctx.fillText(value, x + 16, y + 62);
  });

  ctx.font = font(15, 700);
  ctx.fillStyle = INK;
  ctx.fillText(labels.minutesChart, PAD, chartTop - 8);
  const maxMin = Math.max(1, ...report.days.map((d) => d.minutes));
  const barArea = chartH - 40;
  const slot = CONTENT / Math.max(1, report.days.length);
  report.days.forEach((day, i) => {
    const barH = Math.max(6, (day.minutes / maxMin) * barArea);
    const x = PAD + i * slot + slot * 0.25;
    const w = slot * 0.5;
    const base = chartTop + 12 + barArea;
    if (day.minutes > 0) {
      roundRect(ctx, x, base - barH, w, barH, Math.min(6, w / 2, barH / 2));
      ctx.fillStyle = ACCENT;
      ctx.fill();
    } else {
      // 没学的那天只画一道底线，不画柱。
      ctx.fillStyle = LINE;
      ctx.fillRect(x, base - 2, w, 2);
    }
    ctx.font = font(11);
    ctx.fillStyle = MUTED;
    const label = day.label;
    ctx.fillText(label, x + w / 2 - ctx.measureText(label).width / 2, base + 18);
    if (day.minutes > 0) {
      const value = String(Math.round(day.minutes));
      ctx.fillStyle = INK;
      ctx.fillText(value, x + w / 2 - ctx.measureText(value).width / 2, base - barH - 6);
    }
  });

  ctx.font = font(15, 700);
  ctx.fillStyle = INK;
  ctx.fillText(labels.weakTopics, PAD, weakTop);
  weakLines.forEach((topic, i) => {
    const y = weakTop + 26 + i * 30;
    ctx.fillStyle = report.weakTopics.length > 0 ? "#ff9f0a" : LINE;
    ctx.beginPath();
    ctx.arc(PAD + 5, y - 5, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = font(14);
    ctx.fillStyle = report.weakTopics.length > 0 ? INK : MUTED;
    ctx.fillText(wrapLines(topic, CONTENT - 20, font(14), measure)[0] ?? "", PAD + 18, y);
  });
  drawFooter(ctx, weakTop + 26 + weakLines.length * 30 + 4, PAD, CONTENT, labels);
  return canvas;
}

/** canvas → PNG 的 base64（不带 data: 前缀），交给后端落盘。 */
export function canvasToPngBase64(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}
