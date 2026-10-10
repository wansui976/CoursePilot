// 分享图的纯排版逻辑：Markdown 拆块、按宽度折行、脑图树布局。
// 不碰 canvas——文本测宽由调用方传入（canvas 用 measureText，测试用字符数近似），
// 真正的绘制在 ./render.ts。

export type Measure = (text: string, font: string) => number;

export type NoteBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "bullet"; depth: number; marker: string; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] };

/** 去掉行内 Markdown 记号与时间戳：分享图里不需要可点击的 [mm:ss]。 */
export function plainInline(text: string): string {
  return text
    // 分享图画不了 KaTeX：去掉 LaTeX 定界符，公式至少按原样可读。
    .replace(/\\[()[\]]/g, "")
    .replace(/\$\$([^$]+)\$\$/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/▶?\s*\[\d{1,2}:\d{2}(?::\d{2})?\]/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => plainInline(cell));
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** 把笔记 Markdown 拆成可排版的块。只认笔记里实际会出现的几种结构。 */
export function parseNoteBlocks(markdown: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    // 表格：表头 + 分隔行 + 若干数据行。
    if (line.startsWith("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--;
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = plainInline(heading[2]);
      if (text) blocks.push({ kind: "heading", level: heading[1].length, text });
      continue;
    }

    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (bullet) {
      const text = plainInline(bullet[3]);
      if (!text) continue;
      const depth = Math.min(3, Math.floor(bullet[1].replace(/\t/g, "  ").length / 2));
      const marker = /\d/.test(bullet[2]) ? bullet[2].replace(")", ".") : "•";
      blocks.push({ kind: "bullet", depth, marker, text });
      continue;
    }

    if (line.startsWith(">")) {
      const text = plainInline(line.replace(/^>+\s?/, ""));
      if (text) blocks.push({ kind: "quote", text });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) continue;
    const text = plainInline(line);
    if (text) blocks.push({ kind: "paragraph", text });
  }
  return blocks;
}

const CJK = /[\u2E80-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF\u3000-\u303F]/;
/** 不能出现在行首的标点：折行时把它们留在上一行末尾。 */
const NO_LINE_START = /^[，。、；：！？）」』》】,.;:!?)\]}%]/;

/** 把文本切成折行单位：中日韩按字，拉丁文按词（连同后面的空格）。 */
function tokens(text: string): string[] {
  const out: string[] = [];
  let word = "";
  for (const ch of text) {
    if (CJK.test(ch)) {
      if (word) {
        out.push(word);
        word = "";
      }
      out.push(ch);
    } else if (ch === " ") {
      out.push(word + " ");
      word = "";
    } else {
      word += ch;
    }
  }
  if (word) out.push(word);
  return out.filter((t) => t.length > 0);
}

/** 按最大宽度折行。单个词比整行还宽时按字符硬切。 */
export function wrapLines(text: string, maxWidth: number, font: string, measure: Measure): string[] {
  const lines: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) lines.push(current.trimEnd());
    current = "";
  };
  for (const token of tokens(text)) {
    const candidate = current + token;
    if (measure(candidate.trimEnd(), font) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (NO_LINE_START.test(token) && current) {
      current += token;
      flush();
      continue;
    }
    if (current) flush();
    if (measure(token.trimEnd(), font) <= maxWidth) {
      current = token.trimStart();
      continue;
    }
    // 超长的词：逐字切。
    for (const ch of token) {
      if (measure(current + ch, font) > maxWidth && current) flush();
      current += ch;
    }
  }
  flush();
  return lines;
}

/** 截断到最大宽度，超出时以省略号结尾。 */
export function ellipsize(text: string, maxWidth: number, font: string, measure: Measure): string {
  if (measure(text, font) <= maxWidth) return text;
  let out = "";
  for (const ch of text) {
    if (measure(out + ch + "…", font) > maxWidth) break;
    out += ch;
  }
  return out + "…";
}

export interface TreeInput {
  text: string;
  children: TreeInput[];
}

export interface LaidNode {
  text: string;
  depth: number;
  /** 所属一级分支的序号（根为 -1），用来上色。 */
  branch: number;
  x: number;
  /** 节点文字的竖直中线。 */
  y: number;
  width: number;
  parent: LaidNode | null;
}

export interface TreeLayout {
  nodes: LaidNode[];
  width: number;
  height: number;
}

export interface TreeLayoutOptions {
  measure: Measure;
  fontForDepth: (depth: number) => string;
  /** 每个节点文字的最大宽度，超出截断。 */
  maxTextWidth: number;
  rowHeight: number;
  columnGap: number;
}

/**
 * 从左到右的树布局：叶子各占一行，父节点竖直居中于子节点之间；
 * 每一层一列，列宽取该层最宽的文字。
 */
export function layoutTree(root: TreeInput, options: TreeLayoutOptions): TreeLayout {
  const { measure, fontForDepth, maxTextWidth, rowHeight, columnGap } = options;
  const nodes: LaidNode[] = [];
  const columnWidths: number[] = [];
  let nextRow = 0;

  function visit(input: TreeInput, depth: number, branch: number, parent: LaidNode | null): LaidNode {
    const font = fontForDepth(depth);
    const text = ellipsize(input.text, maxTextWidth, font, measure);
    const width = Math.ceil(measure(text, font));
    columnWidths[depth] = Math.max(columnWidths[depth] ?? 0, width);
    const node: LaidNode = { text, depth, branch, x: 0, y: 0, width, parent };
    nodes.push(node);
    if (input.children.length === 0) {
      node.y = (nextRow + 0.5) * rowHeight;
      nextRow += 1;
    } else {
      const kids = input.children.map((child, i) =>
        visit(child, depth + 1, depth === 0 ? i : branch, node),
      );
      node.y = (kids[0].y + kids[kids.length - 1].y) / 2;
    }
    return node;
  }

  visit(root, 0, -1, null);
  const columnX: number[] = [];
  let x = 0;
  for (let depth = 0; depth < columnWidths.length; depth++) {
    columnX[depth] = x;
    x += columnWidths[depth] + columnGap;
  }
  for (const node of nodes) node.x = columnX[node.depth];
  return { nodes, width: Math.max(0, x - columnGap), height: nextRow * rowHeight };
}
