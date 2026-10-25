import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { insertNoteStamp } from "./insertNoteStamp";
import { TimestampNode } from "./timestampNode";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function make(content: object) {
  editor = new Editor({ extensions: [StarterKit, TimestampNode], content });
  return editor as unknown as Parameters<typeof insertNoteStamp>[0];
}

const paragraph = (text?: string) =>
  text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" };

describe("记一笔：insertNoteStamp", () => {
  it("末尾不是空段时另起一段，时间戳后留一个空格，光标停在最后", () => {
    const target = make({ type: "doc", content: [paragraph("已有内容")] });
    insertNoteStamp(target, 65_000);

    const doc = target.getJSON();
    expect(doc.content).toHaveLength(2);
    expect(doc.content?.[1]).toEqual({
      type: "paragraph",
      content: [
        { type: "timestamp", attrs: { ms: 65_000, label: "", source: false } },
        { type: "text", text: " " },
      ],
    });
    expect(target.state.selection.from).toBe(target.state.doc.content.size - 1);
  });

  it("末尾是空段就写进它，不再多出一个空行", () => {
    const target = make({ type: "doc", content: [paragraph("已有内容"), paragraph()] });
    insertNoteStamp(target, 1_000);

    const doc = target.getJSON();
    expect(doc.content).toHaveLength(2);
    expect(doc.content?.[1].content?.[0]).toMatchObject({ type: "timestamp", attrs: { ms: 1_000 } });
  });

  it("是一次普通编辑：撤销即回到插入前", () => {
    const target = make({ type: "doc", content: [paragraph("已有内容")] });
    insertNoteStamp(target, 2_000);
    target.commands.undo();
    expect(target.getJSON().content).toHaveLength(1);
  });
});
