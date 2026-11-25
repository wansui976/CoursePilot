import type { Editor } from "@tiptap/react";

/**
 * 「记一笔」：插入一个时间戳和一个空格，光标停在后面，接着就能写。是一次普通编辑
 * （可撤销、照常自动保存），插完把光标所在处滚进视野。
 *
 * - 用户在这篇笔记里放过光标（`hasCursor`）：插在光标处。编辑器失焦后 ProseMirror
 *   仍记着那个位置，所以从播放器按快捷键也能落回刚才写到的地方。
 *   有选区时插在选区**后面**，不覆盖选中的文字——按一下「记一笔」把一段话换成时间戳，
 *   谁都想不到。
 * - 还没放过光标（刚打开、光标停在文档开头的默认位置）：接在末尾。最后一段是空段就写进它，
 *   否则另起一段——否则时间戳会插到第一个标题前面。和贴图（insertBlocks）同一个规矩。
 */
export function insertNoteStamp(editor: Editor, ms: number, hasCursor = true) {
  const content = [
    { type: "timestamp", attrs: { ms } },
    { type: "text", text: " " },
  ];
  if (hasCursor) {
    const at = editor.state.selection.to;
    editor.chain().focus().insertContentAt(at, content).scrollIntoView().run();
    return;
  }
  const last = editor.state.doc.lastChild;
  const end = editor.state.doc.content.size;
  if (last?.type.name === "paragraph" && last.content.size === 0) {
    editor.chain().insertContentAt(end - 1, content).focus("end").scrollIntoView().run();
  } else {
    editor
      .chain()
      .insertContentAt(end, { type: "paragraph", content })
      .focus("end")
      .scrollIntoView()
      .run();
  }
}
