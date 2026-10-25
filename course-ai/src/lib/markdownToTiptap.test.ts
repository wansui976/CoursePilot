import { describe, expect, it } from "vitest";
import { markdownToTiptap, parseTimestamp } from "./markdownToTiptap";
import { tiptapToMarkdown } from "./tiptapToMarkdown";

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

  it("moves consecutive trailing timestamps into a paragraph-level source row", () => {
    const doc = markdownToTiptap("核心结论。 [01:05] [02:10] [03:15]");

    expect(doc.content).toHaveLength(2);
    expect(doc.content![0]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: "核心结论。" }],
    });
    expect(doc.content![1].content![0]).toMatchObject({
      type: "text",
      text: "来源 ",
    });
    const sources = doc.content![1].content!.filter(
      (node) => node.type === "timestamp",
    );
    expect(sources).toHaveLength(3);
    expect(sources.every((node) => node.attrs?.source === true)).toBe(true);
  });

  it("keeps a single trailing timestamp inline", () => {
    const doc = markdownToTiptap("核心结论 [01:05]");

    expect(doc.content).toHaveLength(1);
    expect(doc.content![0].content!.find((node) => node.type === "timestamp")?.attrs)
      .not.toHaveProperty("source", true);
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

  it("parses bold labels that contain inline math", () => {
    const doc = markdownToTiptap("- **\\(t\\) 的几何意义**：定点 \\(M_0\\)");
    const list = doc.content![0];
    const para = list.content![0].content![0];
    const text = para.content!
      .filter((n) => n.type === "text")
      .map((n) => n.text)
      .join("");
    const boldText = para.content!
      .filter((n) => n.marks?.some((m) => m.type === "bold"))
      .map((n) => n.text)
      .join("");
    const math = para.content!.filter((n) => n.type === "math");

    expect(text).not.toContain("**");
    expect(boldText).toBe(" 的几何意义");
    expect(math[0].attrs!.latex).toBe("t");
    expect(math[1].attrs!.latex).toBe("M_0");
  });

  it("keeps ** inside inline math as part of the formula", () => {
    const doc = markdownToTiptap("\\(a**b**c\\)");
    const para = doc.content![0];
    const math = para.content!.filter((n) => n.type === "math");

    expect(math).toHaveLength(1);
    expect(math[0].attrs!.latex).toBe("a**b**c");
    expect(
      para.content!.some((n) => n.marks?.some((m) => m.type === "bold")),
    ).toBe(false);
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

describe("markdownToTiptap blockquotes", () => {
  it("parses consecutive > lines into one blockquote with nested formatting", () => {
    const doc = markdownToTiptap("正文\n\n> 一句话：**下山**\n> - 每步朝最陡处");
    const quote = doc.content?.find((node) => node.type === "blockquote");
    expect(quote).toBeDefined();
    expect(quote?.content?.map((node) => node.type)).toEqual(["paragraph", "bulletList"]);
    expect(JSON.stringify(quote)).toContain('"bold"');
    expect(JSON.stringify(doc)).not.toContain("> ");
  });

  it("round-trips a quote through the editor document unchanged", () => {
    const md = "> 蒙着眼下山，每一步朝最陡处迈一小步。";
    expect(tiptapToMarkdown(markdownToTiptap(md)).trim()).toBe(md);
  });
});


describe("markdownToTiptap：编辑器支持的其余 Markdown", () => {
  const roundTrip = (md: string) => tiptapToMarkdown(markdownToTiptap(md)).trim();

  it("行内：斜体、删除线、行内代码、链接，写回后不变", () => {
    for (const md of [
      "这是 _重点_ 和 ~~废话~~，命令 `git log`。",
      "参考 [官方文档](https://example.com/a_b) 第三节",
      "**加粗里有 _斜体_**",
    ]) {
      expect(roundTrip(md)).toBe(md);
    }
    const marks = markdownToTiptap("见 [文档](https://x.dev)").content?.[0].content?.[1];
    expect(marks).toEqual({
      type: "text",
      text: "文档",
      marks: [{ type: "link", attrs: { href: "https://x.dev" } }],
    });
  });

  it("不把乘号和 snake_case 当成斜体；转义字符还原成原字", () => {
    const text = (md: string) =>
      (markdownToTiptap(md).content?.[0].content ?? []).map((node) => node.text).join("");
    expect(markdownToTiptap("2*3*4 与 snake_case_name").content?.[0].content).toEqual([
      { type: "text", text: "2*3*4 与 snake_case_name" },
    ]);
    expect(text("1\\*2 与 a\\_b")).toBe("1*2 与 a_b");
  });

  it("代码块原样保留，里面的标记不解析", () => {
    const md = "```python\nx = a * b * c  # **不加粗**\n```";
    const block = markdownToTiptap(md).content?.[0];
    expect(block).toEqual({
      type: "codeBlock",
      attrs: { language: "python" },
      content: [{ type: "text", text: "x = a * b * c  # **不加粗**" }],
    });
    expect(roundTrip(md)).toBe(md);
  });

  it("分隔线、待办、整行图片", () => {
    const md = [
      "- [ ] 复习第三章",
      "- [x] 看完视频",
      "",
      "---",
      "",
      "![板书](note-image:abc123)",
    ].join("\n");
    const doc = markdownToTiptap(md);
    expect(doc.content?.map((node) => node.type)).toEqual(["taskList", "horizontalRule", "image"]);
    expect(doc.content?.[0].content?.map((item) => item.attrs?.checked)).toEqual([false, true]);
    expect(doc.content?.[2].attrs).toEqual({ src: "note-image:abc123", alt: "板书" });
    expect(roundTrip(md)).toBe(md);
  });

  it("句子中间的图片语法保留为原文（图片是块级的，没法插在句子里）", () => {
    const doc = markdownToTiptap("看 ![图](a.png) 这里");
    expect(doc.content?.[0].type).toBe("paragraph");
    expect(doc.content?.[0].content?.map((node) => node.text).join("")).toBe("看 ![图](a.png) 这里");
  });
});
