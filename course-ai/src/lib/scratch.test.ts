import { describe, expect, it } from "vitest";
import { parseScratch, scratchToMarkdown, stepMark } from "./scratch";

describe("草稿纸", () => {
  it("一行一步，划掉的不编号，「答：」那行是答案，模型自己的编号去掉", () => {
    const scratch = parseScratch("1. 设 $x=1$\n\n~~$x+1=3$~~\n② $x+1=2$\n答：$x=1$");
    expect(scratch.steps).toEqual([
      { text: "设 $x=1$", struck: false },
      { text: "$x+1=3$", struck: true },
      { text: "$x+1=2$", struck: false },
    ]);
    expect(scratch.answer).toBe("$x=1$");
  });

  it("复制、存笔记时还原成编号列表、删除线和加粗答案，块外文字不动", () => {
    const md = scratchToMarkdown("思路如下。\n\n```scratch\n第一步\n~~错的~~\n第二步\n答：42\n```\n");
    expect(md).toBe("思路如下。\n\n1. 第一步\n   ~~错的~~\n2. 第二步\n\n**答：42**\n\n");
  });

  it("圈号写到 ⑳，再多写数字", () => {
    expect(stepMark(1)).toBe("①");
    expect(stepMark(20)).toBe("⑳");
    expect(stepMark(21)).toBe("21.");
  });
});
