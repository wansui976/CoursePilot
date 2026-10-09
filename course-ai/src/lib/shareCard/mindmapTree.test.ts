import { describe, expect, it } from "vitest";
import { markmapToTree } from "./mindmapTree";

describe("markmapToTree", () => {
  it("turns a markmap outline into a plain-text tree", () => {
    const tree = markmapToTree("# 假设分配法\n## 方法概述\n- 师傅 &amp; 徒弟\n- **一步**求两值\n## 使用技巧", "x");
    expect(tree).toEqual({
      text: "假设分配法",
      children: [
        {
          text: "方法概述",
          children: [
            { text: "师傅 & 徒弟", children: [] },
            { text: "一步求两值", children: [] },
          ],
        },
        { text: "使用技巧", children: [] },
      ],
    });
  });

  it("falls back to the video title when there is no single root heading", () => {
    const tree = markmapToTree("## 甲\n## 乙", "第 1 讲");
    expect(tree?.text).toBe("第 1 讲");
    expect(tree?.children.map((c) => c.text)).toEqual(["甲", "乙"]);
  });

  it("returns null for an empty mind map", () => {
    expect(markmapToTree("", "t")).toBeNull();
  });
});
