/**
 * 笔记模板：空笔记里一键铺好骨架，再往里填。只铺标题和空条目，不替用户写内容。
 * 模板正文在 i18n（`notes.templates.<id>.body`），这里只管有哪些、怎么拼。
 */
export const NOTE_TEMPLATES = ["cornell", "questions", "recap"] as const;
export type NoteTemplate = (typeof NOTE_TEMPLATES)[number];

/** 模板正文是用「|」分隔的二级标题列表；每个标题下留一条空的列表项。 */
export function templateMarkdown(headings: string[]): string {
  return headings
    .map((heading) => heading.trim())
    .filter(Boolean)
    .map((heading) => `## ${heading}\n\n- `)
    .join("\n\n");
}
