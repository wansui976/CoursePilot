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
