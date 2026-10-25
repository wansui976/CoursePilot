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
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

// 匹配 [mm:ss] / [mmm:ss] / [hh:mm:ss]（分钟位允许 1-3 位，兼容长视频）。
// 也兼容模型偶尔写成的时间段 [mm:ss-mm:ss]：只捕获起点（group 1）作跳转目标，
// 把「-终点」尾巴一并吃掉，避免整段时间标注无法解析、原样漏成纯文本。
// 连接符要尽量宽：模型在中文语境里会写出各种破折号/连字号/波浪号
// （hyphen、U+2010–U+2015 整个破折号区段、minus U+2212、全角连字符 U+FF0D、
//  半/全角波浪号 ~ U+FF5E、波浪线 U+301C 等），少覆盖一个就会整段漏成纯文本。
const DASH = "-\\u2010-\\u2015\\u2212\\uFF0D~\\uFF5E\\u301C\\u2053";
export const TIMESTAMP_RE = new RegExp(
  `\\[(\\d{1,3}:\\d{2}(?::\\d{2})?)(?:\\s*[${DASH}]\\s*\\d{1,3}:\\d{2}(?::\\d{2})?)?\\]`,
  "g",
);

export interface TimestampSource {
  label: string;
  ms: number;
}

/**
 * 把段尾连续出现的多个时间戳从正文中分离出来，供渲染层收成一行“来源”。
 * 单个时间戳和夹在正文中的时间戳保持原位，避免改变句子语义。
 */
export function splitTrailingTimestampSources(text: string): {
  body: string;
  sources: TimestampSource[];
} {
  const matches = Array.from(text.matchAll(new RegExp(TIMESTAMP_RE.source, "g")));
  if (matches.length < 2) return { body: text, sources: [] };

  const last = matches[matches.length - 1];
  const lastEnd = (last.index ?? 0) + last[0].length;
  if (text.slice(lastEnd).trim() !== "") return { body: text, sources: [] };

  let firstSource = matches.length - 1;
  for (let index = matches.length - 2; index >= 0; index -= 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const between = text.slice(
      (current.index ?? 0) + current[0].length,
      next.index ?? 0,
    );
    if (!/^[\s,，、;；/|·]*$/.test(between)) break;
    firstSource = index;
  }

  const sourceMatches = matches.slice(firstSource);
  if (sourceMatches.length < 2) return { body: text, sources: [] };

  return {
    body: text.slice(0, sourceMatches[0].index ?? 0).trimEnd(),
    sources: sourceMatches.map((match) => ({
      label: match[1],
      ms: parseTimestamp(match[1]),
    })),
  };
}

// 数学公式定界符：\[..\] 与 $$..$$ 为行间公式，\(..\) 与 $..$ 为行内公式。
export const MATH_RE =
  /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

function withBoldMark(node: Node): Node {
  if (node.type !== "text") return node;
  if (node.marks?.some((m) => m.type === "bold")) return node;
  return { ...node, marks: [...(node.marks ?? []), { type: "bold" }] };
}

/** 把非粗体文本切成「数学公式 / 时间戳 / 纯文本」的内联节点。 */
function inlineMath(text: string): Node[] {
  const nodes: Node[] = [];
  const re = new RegExp(MATH_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(...inlinePlain(text.slice(last, m.index)));
    const display = m[1] !== undefined || m[3] !== undefined;
    const latex = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim();
    nodes.push({ type: "math", attrs: { latex, display } });
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(...inlinePlain(text.slice(last)));
  return nodes.length ? nodes : [{ type: "text", text: text || " " }];
}

/** 把一段文本切成「粗体 / 数学公式 / 时间戳 / 纯文本」的内联节点。
 *  粗体可以包住公式（**\(t\) 的意义**），公式里也可能出现 **（如 \(a**b**c\)）——
 *  因此 ** 只有整对都落在公式区间之外才算粗体定界符，否则原样交给公式解析。 */
function inline(text: string): Node[] {
  const mathRanges: Array<[number, number]> = [];
  const mre = new RegExp(MATH_RE.source, "g");
  let mm: RegExpExecArray | null;
  while ((mm = mre.exec(text)) !== null) {
    mathRanges.push([mm.index, mm.index + mm[0].length]);
  }
  const insideMath = (i: number) =>
    mathRanges.some(([start, end]) => i > start && i < end);

  const nodes: Node[] = [];
  const bre = /\*\*[^*]+\*\*/g;
  let last = 0;
  let bm: RegExpExecArray | null;
  while ((bm = bre.exec(text)) !== null) {
    if (insideMath(bm.index) || insideMath(bm.index + bm[0].length)) continue;
    if (bm.index > last) nodes.push(...inlineMath(text.slice(last, bm.index)));
    nodes.push(...inlineMath(bm[0].slice(2, -2)).map(withBoldMark));
    last = bm.index + bm[0].length;
  }
  if (last < text.length) nodes.push(...inlineMath(text.slice(last)));
  return nodes.length ? nodes : [{ type: "text", text: text || " " }];
}

// 行内标记（加粗另行处理）：反斜杠转义、`代码`、![图](地址)、[文字](链接)、~~删除线~~、*斜体* / _斜体_。
// 斜体两侧不能紧挨字母数字，免得 2*3*4、snake_case_name 被当成斜体；中文不算 \w，「这是_重点_」照常识别。
const INLINE_MARK_RE =
  /\\([\\`*_[\]~])|`([^`\n]+)`|!\[([^\]\n]*)\]\(([^)\s]+)\)|\[([^\]\n]+)\]\(([^)\s]+)\)|~~([^~\n]+)~~|(?<![\w*\\])\*(?![\s*])([^*\n]+?)(?<![\s\\])\*(?![\w*])|(?<![\w\\])_(?![\s_])([^_\n]+?)(?<![\s\\])_(?!\w)/g;

function withMark(nodes: Node[], mark: { type: string; attrs?: Record<string, unknown> }): Node[] {
  return nodes.map((node) =>
    node.type === "text" ? { ...node, marks: [...(node.marks ?? []), mark] } : node,
  );
}

/** 在纯文本里识别行内标记与 [mm:ss] 时间戳。 */
function inlinePlain(text: string): Node[] {
  const nodes: Node[] = [];
  const re = new RegExp(INLINE_MARK_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (value: string) => {
    if (value) nodes.push(...timestamps(value));
  };
  while ((m = re.exec(text)) !== null) {
    pushText(text.slice(last, m.index));
    if (m[1] !== undefined) nodes.push({ type: "text", text: m[1] });
    else if (m[2] !== undefined) nodes.push({ type: "text", text: m[2], marks: [{ type: "code" }] });
    // 图片是块级节点，夹在句子里时没法原地放；保留原文，整行只有图片时由块级解析接手。
    else if (m[4] !== undefined) nodes.push({ type: "text", text: m[0] });
    else if (m[6] !== undefined) {
      nodes.push(...withMark(inlinePlain(m[5]), { type: "link", attrs: { href: m[6] } }));
    } else if (m[7] !== undefined) nodes.push(...withMark(inlinePlain(m[7]), { type: "strike" }));
    else nodes.push(...withMark(inlinePlain(m[8] ?? m[9] ?? ""), { type: "italic" }));
    last = m.index + m[0].length;
  }
  pushText(text.slice(last));
  return nodes;
}

/** 在纯文本里识别 [mm:ss] 时间戳，渲染为可点击的 timestamp 节点。 */
function timestamps(text: string): Node[] {
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

/**
 * 识别从 lines[start] 开始、跨多行的行间公式块（\[ … \] 或 $$ … $$）。
 * 逐行处理的解析器无法靠 inline() 跨行匹配，故在块级单独处理。
 * 注意：LaTeX 数学模式里空行是非法段落分隔，会让 KaTeX 报错，所以剔除空行。
 * 返回 [段落节点, 下一行索引]；不是公式块则返回 null。
 */
function tryDisplayMathBlock(lines: string[], start: number): [Node, number] | null {
  const t = lines[start].trim();
  let openToken: string;
  let closeToken: string;
  if (t.startsWith("\\[")) {
    openToken = "\\[";
    closeToken = "\\]";
  } else if (t.startsWith("$$")) {
    openToken = "$$";
    closeToken = "$$";
  } else {
    return null;
  }

  const afterOpen = t.slice(openToken.length);
  // 同一行就闭合的，交给 inline() 处理，不在这里。
  if (afterOpen.includes(closeToken)) return null;

  const collected: string[] = [];
  if (afterOpen.trim()) collected.push(afterOpen.trim());
  for (let j = start + 1; j < lines.length; j++) {
    const idx = lines[j].indexOf(closeToken);
    if (idx >= 0) {
      const before = lines[j].slice(0, idx);
      if (before.trim()) collected.push(before.trim());
      const latex = collected.join("\n").trim();
      if (!latex) return null;
      return [
        {
          type: "paragraph",
          content: [{ type: "math", attrs: { latex, display: true } }],
        },
        j + 1,
      ];
    }
    // 剔除块内空行（数学模式不允许空行）。
    if (lines[j].trim()) collected.push(lines[j].trim());
  }
  return null; // 没找到闭合，放弃当作公式块。
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

function sourceParagraph(sources: TimestampSource[]): Node {
  const content: Node[] = [{ type: "text", text: "来源 " }];
  sources.forEach((source, index) => {
    if (index > 0) content.push({ type: "text", text: " " });
    content.push({
      type: "timestamp",
      attrs: { ms: source.ms, label: source.label, source: true },
    });
  });
  return { type: "paragraph", content };
}

function paragraphNodes(text: string): Node[] {
  const { body, sources } = splitTrailingTimestampSources(text);
  if (sources.length === 0) {
    return [{ type: "paragraph", content: inline(text) }];
  }
  return [
    ...(body ? [{ type: "paragraph", content: inline(body) }] : []),
    sourceParagraph(sources),
  ];
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

const IMAGE_RE = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** 整行只有图片（可以几张并排写）时，每张一个图片块；否则 null。 */
function imageLine(line: string): Node[] | null {
  if (line.replace(new RegExp(IMAGE_RE.source, "g"), "").trim() !== "") return null;
  const images = Array.from(line.matchAll(new RegExp(IMAGE_RE.source, "g")));
  if (images.length === 0) return null;
  return images.map((match) => ({
    type: "image",
    attrs: { src: match[2], alt: match[1] || null },
  }));
}

export function markdownToTiptap(md: string): Node {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const content: Node[] = [];
  let bulletBuffer: Node[] = [];
  let orderedBuffer: Node[] = [];
  let taskBuffer: Node[] = [];

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
  const flushTasks = () => {
    if (taskBuffer.length) {
      content.push({ type: "taskList", content: taskBuffer });
      taskBuffer = [];
    }
  };
  const flushLists = () => {
    flushBullets();
    flushOrdered();
    flushTasks();
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushLists();
      continue;
    }

    // 代码块：``` 起、``` 止；里面原样保留，不再做任何行内解析。没闭合就吃到文末。
    const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flushLists();
      const code: string[] = [];
      idx += 1;
      while (idx < lines.length && !/^\s*```\s*$/.test(lines[idx])) {
        code.push(lines[idx]);
        idx += 1;
      }
      const text = code.join("\n");
      content.push({
        type: "codeBlock",
        attrs: { language: fence[1] || null },
        ...(text ? { content: [{ type: "text", text }] } : {}),
      });
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushLists();
      content.push({ type: "horizontalRule" });
      continue;
    }

    const images = imageLine(line);
    if (images) {
      flushLists();
      content.push(...images);
      continue;
    }

    // 多行行间公式块：\[ … \] / $$ … $$（跨行 + 含空行）。
    const mathBlock = tryDisplayMathBlock(lines, idx);
    if (mathBlock) {
      flushLists();
      content.push(mathBlock[0]);
      idx = mathBlock[1] - 1;
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

    // 引用块：连续的 `>` 行去掉前缀后递归解析，块内的标题/列表/加粗照常保留。
    // tiptapToMarkdown 会把 blockquote 写回 `> …`，这里不解析的话存一次读一次就成了字面 `>`。
    if (/^\s*>/.test(line)) {
      flushLists();
      const quoted: string[] = [];
      while (idx < lines.length && /^\s*>/.test(lines[idx])) {
        quoted.push(lines[idx].replace(/^\s*>\s?/, ""));
        idx++;
      }
      idx--;
      const inner = markdownToTiptap(quoted.join("\n")).content ?? [];
      content.push({
        type: "blockquote",
        content: inner.length ? inner : [{ type: "paragraph" }],
      });
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

    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      flushBullets();
      flushOrdered();
      taskBuffer.push({
        type: "taskItem",
        attrs: { checked: task[1] !== " " },
        content: paragraphNodes(task[2]),
      });
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      flushBullets();
      flushTasks();
      orderedBuffer.push({
        type: "listItem",
        content: paragraphNodes(ordered[1]),
      });
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      flushOrdered();
      flushTasks();
      bulletBuffer.push({
        type: "listItem",
        content: paragraphNodes(bullet[1]),
      });
      continue;
    }

    flushLists();
    content.push(...paragraphNodes(line));
  }
  flushLists();
  return {
    type: "doc",
    content: content.length ? content : [{ type: "paragraph" }],
  };
}
