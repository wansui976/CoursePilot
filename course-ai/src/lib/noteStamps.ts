import { parseTimestamp, TIMESTAMP_RE } from "@/lib/markdownToTiptap";

interface JsonNode {
  type?: string;
  attrs?: { ms?: unknown };
  content?: JsonNode[];
}

/**
 * 笔记里记下的时间点（毫秒，升序去重）：进度条直尺上的铅笔记号。
 * 笔记存的是 Tiptap JSON（找 timestamp 节点）或旧的 markdown（找 [mm:ss]）。
 */
export function noteStampTimes(content: string | null | undefined): number[] {
  if (!content) return [];
  const found = new Set<number>();
  let doc: JsonNode | null = null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object") doc = parsed as JsonNode;
  } catch {
    doc = null;
  }
  if (doc) {
    const walk = (node: JsonNode) => {
      if (node.type === "timestamp" && typeof node.attrs?.ms === "number" && node.attrs.ms >= 0) {
        found.add(Math.round(node.attrs.ms));
      }
      node.content?.forEach(walk);
    };
    walk(doc);
  } else {
    for (const match of content.matchAll(new RegExp(TIMESTAMP_RE.source, "g"))) {
      const ms = parseTimestamp(match[1]);
      if (ms > 0 || match[1].replace(/[0:]/g, "") === "") found.add(ms);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** 直尺的分钟刻度隔几分钟一道：一条进度条上最多约 90 道，长视频就 5 / 10 / 15 分钟一道。 */
export function rulerStepMinutes(durationMs: number): number {
  const minutes = durationMs / 60_000;
  for (const step of [1, 5, 10, 15, 30]) {
    if (minutes / step <= 90) return step;
  }
  return 60;
}
