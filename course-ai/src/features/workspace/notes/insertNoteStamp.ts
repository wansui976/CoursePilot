import type { Editor } from "@tiptap/react";

/**
 * 「记一笔」：在笔记末尾插入一个时间戳并把光标停在它后面，接着就能写。
 * 最后一段是空段就写进它，否则另起一段。是一次普通编辑（可撤销、照常自动保存）。
 */
export function insertNoteStamp(editor: Editor, ms: number) {
  const timestamp = { type: "timestamp", attrs: { ms } };
  const space = { type: "text", text: " " };
  const last = editor.state.doc.lastChild;
  const end = editor.state.doc.content.size;
  if (last?.type.name === "paragraph" && last.content.size === 0) {
    editor.chain().insertContentAt(end - 1, [timestamp, space]).focus("end").run();
  } else {
    editor
      .chain()
      .insertContentAt(end, { type: "paragraph", content: [timestamp, space] })
      .focus("end")
      .run();
  }
}
