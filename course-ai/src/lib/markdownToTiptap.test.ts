import { describe, expect, it } from "vitest";
import { markdownToTiptap, parseTimestamp } from "./markdownToTiptap";

describe("parseTimestamp", () => {
  it("parses mm:ss to ms", () => {
    expect(parseTimestamp("01:05")).toBe(65000);
  });

  it("parses long-video minutes beyond 59 (字幕用总分钟)", () => {
    expect(parseTimestamp("105:30")).toBe((105 * 60 + 30) * 1000);
  });

  it("parses hh:mm:ss to ms", () => {
    expect(parseTimestamp("01:45:30")).toBe((1 * 3600 + 45 * 60 + 30) * 1000);
  });
});

describe("markdownToTiptap", () => {
  it("converts heading and paragraph", () => {
    const doc = markdownToTiptap("# 标题\n\n正文");
    expect(doc.type).toBe("doc");
    expect(doc.content![0]).toMatchObject({
      type: "heading",
      attrs: { level: 1 },
    });
    expect(doc.content![1].type).toBe("paragraph");
  });

  it("converts bullet list", () => {
    const doc = markdownToTiptap("- 一\n- 二");
    expect(doc.content![0].type).toBe("bulletList");
    expect(doc.content![0].content).toHaveLength(2);
  });

  it("turns [mm:ss] into a timestamp node", () => {
    const doc = markdownToTiptap("要点 [01:05]");
    const para = doc.content![0];
    const ts = para.content!.find((n) => n.type === "timestamp");
    expect(ts!.attrs!.ms).toBe(65000);
  });

  it("turns long-video [mmm:ss] into a timestamp node", () => {
    const doc = markdownToTiptap("要点 [105:30]");
    const para = doc.content![0];
    const ts = para.content!.find((n) => n.type === "timestamp");
    expect(ts!.attrs!.ms).toBe((105 * 60 + 30) * 1000);
  });

  it("parses **bold** as a bold mark", () => {
    const doc = markdownToTiptap("这是**重点**内容");
    const para = doc.content![0];
    const bold = para.content!.find((n) => n.marks?.some((m) => m.type === "bold"));
    expect(bold!.text).toBe("重点");
  });

  it("parses ordered list", () => {
    const doc = markdownToTiptap("1. 一\n2. 二");
    expect(doc.content![0].type).toBe("orderedList");
    expect(doc.content![0].content).toHaveLength(2);
  });

  it("parses a markdown table into a table node", () => {
    const md = "| 知识点 | 难度 |\n| --- | --- |\n| 概括题 | 高 |\n| 对策题 | 中 |";
    const doc = markdownToTiptap(md);
    const table = doc.content!.find((n) => n.type === "table");
    expect(table).toBeTruthy();
    // 表头 + 两行数据
    expect(table!.content).toHaveLength(3);
    expect(table!.content![0].content![0].type).toBe("tableHeader");
    expect(table!.content![1].content![0].type).toBe("tableCell");
  });
});
