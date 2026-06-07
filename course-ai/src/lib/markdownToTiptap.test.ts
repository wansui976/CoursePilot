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

  it("turns a time range [mm:ss-mm:ss] into one timestamp at the start", () => {
    const doc = markdownToTiptap("要点 [72:48-72:52]");
    const para = doc.content![0];
    const stamps = para.content!.filter((n) => n.type === "timestamp");
    expect(stamps).toHaveLength(1);
    expect(stamps[0].attrs!.ms).toBe((72 * 60 + 48) * 1000);
    expect(stamps[0].attrs!.label).toBe("72:48");
    // 「-72:52」尾巴被吞掉，不应作为纯文本漏出。
    const text = para.content!
      .filter((n) => n.type === "text")
      .map((n) => n.text)
      .join("");
    expect(text).not.toContain("72:52");
  });

  it.each([
    ["en dash", "[09:01–09:20]"],
    ["em dash", "[09:01—09:20]"],
    ["figure dash", "[09:01‒09:20]"],
    ["horizontal bar", "[09:01―09:20]"],
    ["minus sign", "[09:01−09:20]"],
    ["fullwidth hyphen", "[09:01－09:20]"],
    ["tilde", "[09:01~09:20]"],
    ["fullwidth tilde", "[09:01～09:20]"],
    ["wave dash", "[09:01〜09:20]"],
  ])("parses a time range joined by %s into one timestamp", (_name, range) => {
    const doc = markdownToTiptap(`要点 ${range}`);
    const para = doc.content![0];
    const stamps = para.content!.filter((n) => n.type === "timestamp");
    expect(stamps).toHaveLength(1);
    expect(stamps[0].attrs!.ms).toBe((9 * 60 + 1) * 1000);
    expect(stamps[0].attrs!.label).toBe("09:01");
    const text = para.content!
      .filter((n) => n.type === "text")
      .map((n) => n.text)
      .join("");
    expect(text).not.toContain("09:20");
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

  it("parses inline \\(...\\) math into a math node", () => {
    const doc = markdownToTiptap("令 \\(x=a\\cos\\theta\\) 即可");
    const para = doc.content![0];
    const math = para.content!.find((n) => n.type === "math");
    expect(math!.attrs!.latex).toBe("x=a\\cos\\theta");
    expect(math!.attrs!.display).toBe(false);
  });

  it("parses display \\[...\\] and $$...$$ math", () => {
    const a = markdownToTiptap("\\[E=mc^2\\]");
    const ma = a.content![0].content!.find((n) => n.type === "math");
    expect(ma!.attrs!.display).toBe(true);
    expect(ma!.attrs!.latex).toBe("E=mc^2");

    const b = markdownToTiptap("$$a^2+b^2$$");
    const mb = b.content![0].content!.find((n) => n.type === "math");
    expect(mb!.attrs!.display).toBe(true);
  });

  it("parses a multi-line \\[..\\] display block with blank lines", () => {
    // 用户真实案例：\[ 与 \] 在不同行，中间还有空行。
    const md =
      "\\[\n\n  v_x' = \\frac{v_x - u}{1}, \\quad\n\n  v_y' = \\frac{v_y}{\\gamma}\n\n  \\]";
    const doc = markdownToTiptap(md);
    const para = doc.content!.find((n) =>
      n.content?.some((c) => c.type === "math"),
    );
    const math = para!.content!.find((c) => c.type === "math");
    expect(math!.attrs!.display).toBe(true);
    expect(math!.attrs!.latex).toContain("v_x' = \\frac{v_x - u}{1}");
    expect(math!.attrs!.latex).toContain("v_y' = \\frac{v_y}{\\gamma}");
    // 块内空行必须剔除（数学模式不允许空行，否则 KaTeX 报错）。
    expect(math!.attrs!.latex).not.toContain("\n\n");
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
