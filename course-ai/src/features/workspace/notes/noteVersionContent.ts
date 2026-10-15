import type { JSONContent } from "@tiptap/react";
import { markdownToTiptap } from "@/lib/markdownToTiptap";
import { tiptapToMarkdown } from "@/lib/tiptapToMarkdown";

/** 笔记存储有两种形态（与 getNotes 同形）：用户编辑过的 Tiptap JSON，或 AI 生成的 markdown。 */
function parseDoc(content: string): JSONContent | null {
  try {
    const parsed = JSON.parse(content) as JSONContent;
    return parsed?.type === "doc" ? parsed : null;
  } catch {
    return null;
  }
}

/** 装回编辑器用的文档。 */
export function noteContentToDoc(content: string): JSONContent {
  return parseDoc(content) ?? (markdownToTiptap(content) as JSONContent);
}

/** 预览用的 markdown。 */
export function noteContentToMarkdown(content: string): string {
  const doc = parseDoc(content);
  return doc ? tiptapToMarkdown(doc) : content;
}

/** 大致字数：去掉 markdown 标记与空白后的字符数，只用于列表里「约 N 字」。 */
export function noteContentLength(content: string): number {
  return noteContentToMarkdown(content)
    .replace(/\[\d{1,3}:\d{2}(?::\d{2})?\]/g, "")
    .replace(/[#>*_`|\-\s]/g, "").length;
}
