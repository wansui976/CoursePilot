import { describe, expect, it } from "vitest";
import { looksLikeMarkdown, markdownPasteContent } from "./pasteMarkdown";

describe("粘贴 Markdown", () => {
  it("认得出常见的 Markdown，普通句子不算", () => {
    for (const text of ["# 标题", "- 一\n- 二", "1. 第一步", "> 引用", "```\ncode\n```", "| a | b |", "**重点**", "见 [文档](https://x.dev)", "- [ ] 待办"]) {
      expect(looksLikeMarkdown(text), text).toBe(true);
    }
    for (const text of ["今天学了梯度下降。", "C# 和 F# 都行", "3 * 4 = 12", "  "]) {
      expect(looksLikeMarkdown(text), text).toBe(false);
    }
  });

  it("只有一段时给行内节点，接在光标处；多段给块", () => {
    expect(markdownPasteContent("**重点** 在这")).toEqual([
      { type: "text", text: "重点", marks: [{ type: "bold" }] },
      { type: "text", text: " 在这" },
    ]);
    expect(markdownPasteContent("# 标题\n\n正文").map((node) => node.type)).toEqual([
      "heading",
      "paragraph",
    ]);
  });
});
