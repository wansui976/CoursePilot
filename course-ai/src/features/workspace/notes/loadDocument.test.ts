import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDocument } from "./loadDocument";

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function createEditor(onUpdate = vi.fn()) {
  editor = new Editor({
    extensions: [StarterKit],
    content: { type: "doc", content: [{ type: "paragraph" }] },
    onUpdate,
  });
  return editor;
}

function undoAll(target: Editor) {
  for (let i = 0; i < 50; i++) target.commands.undo();
}

describe("loadDocument", () => {
  it("连按撤销停在装载的内容上，不会撤成空文档", () => {
    const target = createEditor();
    loadDocument(target, doc("梯度下降笔记"));

    target.commands.insertContentAt(target.state.doc.content.size - 1, "，补一句");
    expect(target.getText()).toBe("梯度下降笔记，补一句");

    undoAll(target);
    expect(target.getText()).toBe("梯度下降笔记");
  });

  it("换一份笔记装载后，撤销不会把上一份笔记带回来", () => {
    const target = createEditor();
    loadDocument(target, doc("上一个视频的笔记"));
    target.commands.insertContentAt(1, "改动");

    loadDocument(target, doc("这个视频的笔记"));
    undoAll(target);

    expect(target.getText()).toBe("这个视频的笔记");
  });

  it("装载本身不触发 update（不会被当成编辑去自动保存）", () => {
    const onUpdate = vi.fn();
    const target = createEditor(onUpdate);
    loadDocument(target, doc("已有笔记"));
    undoAll(target);

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("装载后编辑仍可撤销、可重做", () => {
    const target = createEditor();
    loadDocument(target, doc("笔记"));
    target.commands.insertContentAt(target.state.doc.content.size - 1, "！");

    target.commands.undo();
    expect(target.getText()).toBe("笔记");
    target.commands.redo();
    expect(target.getText()).toBe("笔记！");
  });
});
