// 字幕用「总分钟:秒」拼时间戳，长视频分钟可达三位（如 105:30）；
// LLM 也可能写成 hh:mm:ss。统一按「从右到左每段 ×60」折算成毫秒。
export function parseTimestamp(clock: string): number {
  const parts = clock.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
}

interface Node {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
  text?: string;
  marks?: { type: string }[];
}

// 匹配 [mm:ss] / [mmm:ss] / [hh:mm:ss]（分钟位允许 1-3 位，兼容长视频）。
export const TIMESTAMP_RE = /\[(\d{1,3}:\d{2}(?::\d{2})?)\]/g;

// 数学公式定界符：\[..\] 与 $$..$$ 为行间公式，\(..\) 与 $..$ 为行内公式。
export const MATH_RE =
  /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

/** 把一段文本切成「数学公式 / 粗体 / 时间戳 / 纯文本」的内联节点。 */
function inline(text: string): Node[] {
  const nodes: Node[] = [];
  const re = new RegExp(MATH_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(...inlineRich(text.slice(last, m.index)));
    const display = m[1] !== undefined || m[3] !== undefined;
    const latex = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim();
    nodes.push({ type: "math", attrs: { latex, display } });
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(...inlineRich(text.slice(last)));
  return nodes.length ? nodes : [{ type: "text", text: text || " " }];
}

/** 在非公式文本里识别 **粗体** 与时间戳。 */
function inlineRich(text: string): Node[] {
  const nodes: Node[] = [];
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      nodes.push({ type: "text", text: part.slice(2, -2), marks: [{ type: "bold" }] });
      continue;
    }
    nodes.push(...inlinePlain(part));
  }
  return nodes;
}

/** 在纯文本里识别 [mm:ss] 时间戳，渲染为可点击的 timestamp 节点。 */
function inlinePlain(text: string): Node[] {
  const nodes: Node[] = [];
  const re = new RegExp(TIMESTAMP_RE.source, "g");
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push({ type: "text", text: text.slice(last, match.index) });
    }
    nodes.push({
      type: "timestamp",
      attrs: { ms: parseTimestamp(match[1]), label: match[1] },
    });
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push({ type: "text", text: text.slice(last) });
  return nodes;
}

/** 一行是不是表格行：以 | 开头/结尾。 */
function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.lastIndexOf("|") > 0;
}

/** 分隔行：|---|:--:|---| 这种只含 - : | 空格的行。 */
function isTableDivider(line: string): boolean {
  const t = line.trim();
  return isTableRow(t) && /^\|?[\s:\-|]+\|?$/.test(t) && t.includes("-");
}

function splitCells(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

function cell(type: "tableHeader" | "tableCell", text: string): Node {
  return { type, content: [{ type: "paragraph", content: inline(text) }] };
}

/** 从 lines[start] 开始尽量吃下一张表格，返回 [表格节点, 下一行索引]。 */
function parseTable(lines: string[], start: number): [Node, number] {
  const header = splitCells(lines[start]);
  let i = start + 2; // 跳过表头 + 分隔行
  const rows: Node[] = [
    { type: "tableRow", content: header.map((c) => cell("tableHeader", c)) },
  ];
  while (i < lines.length && isTableRow(lines[i]) && !isTableDivider(lines[i])) {
    const cells = splitCells(lines[i]);
    // 列数对齐到表头，避免空单元格丢失。
    while (cells.length < header.length) cells.push("");
    rows.push({
      type: "tableRow",
      content: cells
        .slice(0, header.length)
        .map((c) => cell("tableCell", c)),
    });
    i += 1;
  }
  return [{ type: "table", content: rows }, i];
}

export function markdownToTiptap(md: string): Node {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const content: Node[] = [];
  let bulletBuffer: Node[] = [];
  let orderedBuffer: Node[] = [];

  const flushBullets = () => {
    if (bulletBuffer.length) {
      content.push({ type: "bulletList", content: bulletBuffer });
      bulletBuffer = [];
    }
  };
  const flushOrdered = () => {
    if (orderedBuffer.length) {
      content.push({ type: "orderedList", content: orderedBuffer });
      orderedBuffer = [];
    }
  };
  const flushLists = () => {
    flushBullets();
    flushOrdered();
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushLists();
      continue;
    }

    // 表格：表头行后紧跟分隔行才认定为表格。
    if (
      isTableRow(line) &&
      idx + 1 < lines.length &&
      isTableDivider(lines[idx + 1])
    ) {
      flushLists();
      const [table, next] = parseTable(lines, idx);
      content.push(table);
      idx = next - 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushLists();
      content.push({
        type: "heading",
        attrs: { level: Math.min(heading[1].length, 6) },
        content: inline(heading[2]),
      });
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      flushBullets();
      orderedBuffer.push({
        type: "listItem",
        content: [{ type: "paragraph", content: inline(ordered[1]) }],
      });
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flushOrdered();
      bulletBuffer.push({
        type: "listItem",
        content: [{ type: "paragraph", content: inline(bullet[1]) }],
      });
      continue;
    }

    flushLists();
    content.push({ type: "paragraph", content: inline(line) });
  }
  flushLists();
  return {
    type: "doc",
    content: content.length ? content : [{ type: "paragraph" }],
  };
}
