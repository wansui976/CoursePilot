import type { Editor } from "@tiptap/react";

/**
 * 「记一笔」：在光标处插入一个时间戳和一个空格，光标停在后面，接着就能写。
 * 有选区时替换选区；没有光标（编辑器刚打开）时落在文档开头。
 * 是一次普通编辑（可撤销、照常自动保存）。
 */
export function insertNoteStamp(editor: Editor, ms: number) {
  editor
    .chain()
    .focus()
    .insertContent([
      { type: "timestamp", attrs: { ms } },
      { type: "text", text: " " },
    ])
    .run();
}
