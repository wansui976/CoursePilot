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
}

// 匹配 [mm:ss] / [mmm:ss] / [hh:mm:ss]（分钟位允许 1-3 位，兼容长视频）。
export const TIMESTAMP_RE = /\[(\d{1,3}:\d{2}(?::\d{2})?)\]/g;
const TS = TIMESTAMP_RE;

function inline(text: string): Node[] {
  const nodes: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(TS)) {
    const idx = match.index ?? 0;
    if (idx > last) nodes.push({ type: "text", text: text.slice(last, idx) });
    nodes.push({
      type: "timestamp",
      attrs: { ms: parseTimestamp(match[1]), label: match[1] },
    });
    last = idx + match[0].length;
  }
  if (last < text.length) nodes.push({ type: "text", text: text.slice(last) });
  return nodes.length ? nodes : [{ type: "text", text: text || " " }];
}

export function markdownToTiptap(md: string): Node {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const content: Node[] = [];
  let listBuffer: Node[] = [];

  const flushList = () => {
    if (listBuffer.length) {
      content.push({ type: "bulletList", content: listBuffer });
      listBuffer = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushList();
      content.push({
        type: "heading",
        attrs: { level: heading[1].length },
        content: inline(heading[2]),
      });
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      listBuffer.push({
        type: "listItem",
        content: [{ type: "paragraph", content: inline(bullet[1]) }],
      });
      continue;
    }
    flushList();
    content.push({ type: "paragraph", content: inline(line) });
  }
  flushList();
  return {
    type: "doc",
    content: content.length ? content : [{ type: "paragraph" }],
  };
}
