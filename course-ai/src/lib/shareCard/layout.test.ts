import { describe, expect, it } from "vitest";
import { ellipsize, layoutTree, parseNoteBlocks, plainInline, wrapLines, type Measure } from "./layout";

// 测宽近似：每个字符 10px（中英一致，方便断言）。
const measure: Measure = (text) => [...text].length * 10;

describe("plainInline", () => {
  it("strips markdown markers, links and timestamps", () => {
    expect(plainInline("**口诀**：先看 `R` 再看[链接](http://x) ▶ [04:22] [1:02:03]")).toBe(
      "口诀：先看 R 再看链接",
    );
    expect(plainInline("用 *假设分配* 法")).toBe("用 假设分配 法");
    expect(plainInline("速度 \\(v^2\\) 与 \\[E=mc^2\\]")).toBe("速度 v^2 与 E=mc^2");
  });
});

describe("parseNoteBlocks", () => {
  it("parses headings, nested bullets, quotes, paragraphs and tables", () => {
    const blocks = parseNoteBlocks(
      [
        "# 标题",
        "",
        "## 使用时机",
        "- 增长率较大时 [01:20]",
        "  - 子要点",
        "1. 第一步",
        "> 老师原话",
        "普通段落",
        "---",
        "| 考点 | 怎么判 |",
        "| --- | :---: |",
        "| R<20% | **直接乘** |",
        "| R≈25% | 4:1 |",
      ].join("\n"),
    );
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "标题" },
      { kind: "heading", level: 2, text: "使用时机" },
      { kind: "bullet", depth: 0, marker: "•", text: "增长率较大时" },
      { kind: "bullet", depth: 1, marker: "•", text: "子要点" },
      { kind: "bullet", depth: 0, marker: "1.", text: "第一步" },
      { kind: "quote", text: "老师原话" },
      { kind: "paragraph", text: "普通段落" },
      {
        kind: "table",
        header: ["考点", "怎么判"],
        rows: [
          ["R<20%", "直接乘"],
          ["R≈25%", "4:1"],
        ],
      },
    ]);
  });
});

describe("wrapLines", () => {
  it("wraps CJK by character and keeps closing punctuation off the line start", () => {
    expect(wrapLines("一二三四五，六七", 50, "f", measure)).toEqual(["一二三四五，", "六七"]);
  });

  it("wraps latin text by word and hard-splits overlong words", () => {
    expect(wrapLines("hello big world", 100, "f", measure)).toEqual(["hello big", "world"]);
    expect(wrapLines("abcdefghijkl", 50, "f", measure)).toEqual(["abcde", "fghij", "kl"]);
  });
});

describe("ellipsize", () => {
  it("keeps short text and truncates long text with an ellipsis", () => {
    expect(ellipsize("短", 100, "f", measure)).toBe("短");
    expect(ellipsize("一二三四五六七八", 50, "f", measure)).toBe("一二三四…");
  });
});

describe("layoutTree", () => {
  it("gives each leaf a row, centers parents and assigns branch colors", () => {
    const layout = layoutTree(
      {
        text: "根",
        children: [
          { text: "甲", children: [{ text: "甲1", children: [] }, { text: "甲2", children: [] }] },
          { text: "乙", children: [] },
        ],
      },
      { measure, fontForDepth: () => "f", maxTextWidth: 100, rowHeight: 20, columnGap: 30 },
    );
    const byText = Object.fromEntries(layout.nodes.map((n) => [n.text, n]));
    expect(byText["甲1"].y).toBe(10);
    expect(byText["甲2"].y).toBe(30);
    expect(byText["乙"].y).toBe(50);
    expect(byText["甲"].y).toBe(20);
    expect(byText["根"].y).toBe(35);
    expect(byText["甲"].branch).toBe(0);
    expect(byText["甲2"].branch).toBe(0);
    expect(byText["乙"].branch).toBe(1);
    expect(byText["根"].x).toBe(0);
    expect(byText["甲"].x).toBe(10 + 30);
    expect(byText["甲1"].x).toBe(10 + 30 + 10 + 30);
    expect(layout.height).toBe(60);
    expect(layout.width).toBe(10 + 30 + 10 + 30 + 20);
  });
});
