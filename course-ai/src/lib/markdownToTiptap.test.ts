import { describe, expect, it } from "vitest";
import { markdownToTiptap, parseTimestamp } from "./markdownToTiptap";

describe("parseTimestamp", () => {
  it("parses mm:ss to ms", () => {
    expect(parseTimestamp("01:05")).toBe(65000);
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
});
