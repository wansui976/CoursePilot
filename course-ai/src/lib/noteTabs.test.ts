import { describe, expect, it } from "vitest";
import { tabLabel } from "./noteTabs";

describe("tabLabel", () => {
  it("drops numbering so the tab shows the real title", () => {
    expect(tabLabel("一、课程大纲")).toBe("课程大纲");
    expect(tabLabel("1. 题型本质：概括原因类")).toBe("题型本质");
    expect(tabLabel("第三章 线性变换")).toBe("线性变换");
    expect(tabLabel("（二）材料处理")).toBe("材料处理");
    expect(tabLabel("附：参考答案")).toBe("附参考答案");
    expect(tabLabel("五、Adam")).toBe("Adam");
    expect(tabLabel("1.2 背景知识")).toBe("背景知识");
    expect(tabLabel("2.3.1 递归")).toBe("递归");
    expect(tabLabel("第一部分：概述")).toBe("概述");
    expect(tabLabel("第2讲 梯度")).toBe("梯度");
  });

  it("stops at the first punctuation so tabs never show symbols", () => {
    expect(tabLabel("审题：锁定关键词")).toBe("审题");
    expect(tabLabel("总括词（三类）")).toBe("总括词");
    expect(tabLabel("例题：各类原因")).toBe("例题");
    expect(tabLabel("判分与逻辑")).toBe("判分与逻辑");
    expect(tabLabel("速查表")).toBe("速查表");
    expect(tabLabel("“保大弃小”原则")).toBe("保大弃小原则");
  });
});
