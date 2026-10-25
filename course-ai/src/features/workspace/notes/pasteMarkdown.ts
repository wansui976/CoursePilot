import type { JSONContent } from "@tiptap/react";
import { markdownToTiptap } from "@/lib/markdownToTiptap";

const BLOCK_MARKERS = /^(#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|>|```|\|.+\||\$\$|-{3,}\s*$|!\[)/m;
const INLINE_MARKERS = /\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/;

/**
 * 剪贴板里只有纯文本时，它像不像 Markdown。从网页、文档复制来的内容带 text/html，
 * 交给编辑器默认的粘贴处理；只有纯文本（从 .md 文件、代码编辑器、AI 对话里复制）才走这里。
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text.trim()) return false;
  return BLOCK_MARKERS.test(text) || INLINE_MARKERS.test(text);
}

/**
 * 粘贴进来的 Markdown 转成的内容。只有一段时返回行内节点，接在光标处，不另起一段。
 */
export function markdownPasteContent(text: string): JSONContent[] {
  const doc = markdownToTiptap(text) as JSONContent;
  const blocks = doc.content ?? [];
  if (blocks.length === 1 && blocks[0].type === "paragraph") return blocks[0].content ?? [];
  return blocks;
}
