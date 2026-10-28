import { parseTimestamp } from "@/lib/markdownToTiptap";
import { formatMs } from "@/lib/time";

/**
 * 导图节点末尾的 [mm:ss]：生成时让模型给叶子节点标上讲到这一点的时刻，
 * 显示时把它换成节点后面一枚可点的小时间，点了跳过去。老导图没有时间戳，照常显示。
 */

const TRAILING_STAMP = /\s*\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s*$/;

interface MindmapNode {
  content?: string;
  children?: MindmapNode[];
}

/** 把节点末尾的 [mm:ss] 换成带 data-seek-ms 的小标签（就地改写 markmap 的节点树）。 */
export function linkMindmapTimestamps<T extends MindmapNode>(root: T): T {
  const visit = (node: MindmapNode) => {
    const match = typeof node.content === "string" ? node.content.match(TRAILING_STAMP) : null;
    if (match && node.content) {
      const ms = parseTimestamp(match[1]);
      node.content = node.content.replace(
        TRAILING_STAMP,
        ` <span class="ca-mm-time" data-seek-ms="${ms}" role="button" tabindex="0">${formatMs(ms)}</span>`,
      );
    }
    node.children?.forEach(visit);
  };
  visit(root);
  return root;
}

/** 去掉每行末尾的 [mm:ss]：分享图等纯展示场景用。 */
export function stripMindmapTimestamps(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.replace(TRAILING_STAMP, ""))
    .join("\n");
}

/** 点击落在某个时间标签上时返回它的毫秒数。 */
export function seekMsFromEvent(target: EventTarget | null): number | null {
  const element = (target as Element | null)?.closest?.("[data-seek-ms]");
  if (!element) return null;
  const ms = Number(element.getAttribute("data-seek-ms"));
  return Number.isFinite(ms) ? ms : null;
}
