import { describe, expect, it } from "vitest";
import { markdownToTiptap } from "./markdownToTiptap";
import { templateMarkdown } from "./noteTemplates";

describe("templateMarkdown", () => {
  it("lays out one heading and an empty bullet per section", () => {
    const md = templateMarkdown(["线索与问题", " 笔记 ", "", "总结"]);
    expect(md).toBe("## 线索与问题\n\n- \n\n## 笔记\n\n- \n\n## 总结\n\n- ");
    const doc = markdownToTiptap(md) as { content: { type: string; attrs?: { level?: number } }[] };
    expect(doc.content.filter((node) => node.type === "heading")).toHaveLength(3);
  });
});
