import { EditorState } from "@tiptap/pm/state";
import type { Editor, JSONContent } from "@tiptap/react";

/**
 * 把库里的笔记装进编辑器，并清空撤销历史。
 *
 * setContent 本身是一步可撤销的事务：不清历史的话，连按 ⌘Z 会一路撤到「装载之前」——
 * 也就是空文档，撤销又算编辑，自动保存随即把空文档写回库里，笔记就没了。面板在视频
 * 之间保活，旧历史还会把上一个视频的笔记撤回到当前视频名下。装载是新的起点，不是编辑。
 */
export function loadDocument(editor: Editor, content: JSONContent) {
  editor.commands.setContent(content, { emitUpdate: false });
  const { doc, plugins, schema } = editor.state;
  editor.view.updateState(EditorState.create({ doc, plugins, schema }));
}
