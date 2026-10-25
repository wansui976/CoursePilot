import { describe, expect, it } from "vitest";
import { markdownToTiptap } from "./markdownToTiptap";
import { tiptapToMarkdown } from "./tiptapToMarkdown";

describe("tiptapToMarkdown", () => {
  it("exports the visible heading, lists, formatting, timestamp, and math", () => {
    const doc = markdownToTiptap(
      "# 重点\n\n- **结论** [01:05]\n- 公式 $x^2$\n\n1. 第一步\n2. 第二步",
    );

    expect(tiptapToMarkdown(doc)).toBe(
      "# 重点\n\n- **结论** [01:05]\n- 公式 $x^2$\n\n1. 第一步\n2. 第二步",
    );
  });

  it("exports tables without flattening their structure", () => {
    const doc = markdownToTiptap(
      "| 知识点 | 难度 |\n| --- | --- |\n| 概括题 | 高 |",
    );

    expect(tiptapToMarkdown(doc)).toBe(
      "| 知识点 | 难度 |\n| --- | --- |\n| 概括题 | 高 |",
    );
  });

  it("keeps source timestamps from a Tiptap snapshot", () => {
    expect(
      tiptapToMarkdown({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "来源 " },
              { type: "timestamp", attrs: { label: "105:30", ms: 6_330_000 } },
            ],
          },
        ],
      }),
    ).toBe("来源 [105:30]");
  });
});

describe("tiptapToMarkdown：行内标记", () => {
  const para = (...content: object[]) => ({ type: "doc", content: [{ type: "paragraph", content }] });

  it("相邻文字共用的标记只开一次，空格挪到定界符外", () => {
    expect(
      tiptapToMarkdown(
        para(
          { type: "text", text: "粗体里 ", marks: [{ type: "bold" }] },
          { type: "text", text: "再斜", marks: [{ type: "italic" }, { type: "bold" }] },
          { type: "text", text: " 结束" },
        ),
      ),
    ).toBe("**粗体里 _再斜_** 结束");
  });

  it("链接、待办、块级图片", () => {
    expect(
      tiptapToMarkdown({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "文档", marks: [{ type: "link", attrs: { href: "https://x.dev" } }] },
            ],
          },
          {
            type: "taskList",
            content: [
              { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "做完" }] }] },
            ],
          },
          { type: "image", attrs: { src: "note-image:1", alt: null } },
        ],
      }),
    ).toBe("[文档](https://x.dev)\n\n- [x] 做完\n\n![](note-image:1)");
  });
});
