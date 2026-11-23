import { describe, expect, it } from "vitest";
import { tabLabel } from "./noteTabs";

describe("tabLabel", () => {
  it("drops numbering so the tab shows the real title", () => {
    expect(tabLabel("一、课程大纲")).toBe("课程大纲");
    expect(tabLabel("1. 题型本质：概括原因类")).toBe("题型本质：概括原因类");
    expect(tabLabel("第三章 线性变换")).toBe("线性变换");
    expect(tabLabel("（二）材料处理")).toBe("材料处理");
    expect(tabLabel("附：参考答案")).toBe("附：参考答案");
    expect(tabLabel("五、Adam")).toBe("Adam");
  });
});
