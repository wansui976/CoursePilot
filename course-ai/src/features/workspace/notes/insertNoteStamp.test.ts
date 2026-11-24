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
  it("在光标处插入时间戳，而不是追加到末尾", () => {
    const target = make({ type: "doc", content: [paragraph("已有内容")] });
    // 光标放在正文开头（不是末尾）。
    target.commands.setTextSelection(1);
    insertNoteStamp(target, 65_000);

    const doc = target.getJSON();
    // 仍是一段：没有为了追加内容另起一段。
    expect(doc.content).toHaveLength(1);
    expect(doc.content?.[0].content?.[0]).toMatchObject({
      type: "timestamp",
      attrs: { ms: 65_000 },
    });
    const after = doc.content?.[0].content?.[1] as { type?: string; text?: string } | undefined;
    expect(after?.type).toBe("text");
    expect(after?.text?.startsWith(" ")).toBe(true);
  });

  it("光标停在插入的时间戳后面，接着就能写", () => {
    const target = make({ type: "doc", content: [paragraph("已有内容")] });
    target.commands.setTextSelection(1);
    insertNoteStamp(target, 1_000);

    // 时间戳是原子节点（占 1 个位置），空格再占 1 个：光标应落在 3。
    expect(target.state.selection.from).toBe(3);
  });

  it("光标在段落中间时插在中间，前后文字都保留", () => {
    const target = make({
      type: "doc",
      content: [paragraph("第一段"), paragraph("第二段")],
    });
    // 第二段正文开头：第一段的 nodeSize + 文档边界。
    const secondParagraphStart = target.state.doc.child(0).nodeSize + 1;
    target.commands.setTextSelection(secondParagraphStart);
    insertNoteStamp(target, 2_000);

    const doc = target.getJSON();
    expect(doc.content).toHaveLength(2);
    expect(doc.content?.[0]).toEqual(paragraph("第一段"));
    expect(doc.content?.[1].content?.[0]).toMatchObject({
      type: "timestamp",
      attrs: { ms: 2_000 },
    });
  });

  it("末尾空段不会被顺手写入", () => {
    const target = make({
      type: "doc",
      content: [paragraph("已有内容"), paragraph()],
    });
    target.commands.setTextSelection(1);
    insertNoteStamp(target, 3_000);

    const doc = target.getJSON();
    expect(doc.content?.[0].content?.[0].type).toBe("timestamp");
    expect(doc.content?.[1].content ?? []).toHaveLength(0);
  });

  it("是一次普通编辑：撤销即回到插入前", () => {
    const target = make({ type: "doc", content: [paragraph("已有内容")] });
    target.commands.setTextSelection(1);
    insertNoteStamp(target, 2_000);
    target.commands.undo();
    expect(target.getJSON()).toEqual({ type: "doc", content: [paragraph("已有内容")] });
  });
});
