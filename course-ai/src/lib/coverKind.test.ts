import { describe, expect, it } from "vitest";
import { guessCoverKind } from "./coverKind";

describe("guessCoverKind", () => {
  it("picks the subject from the course name", () => {
    expect(guessCoverKind("线性代数的本质")).toBe("linear");
    expect(guessCoverKind("机器学习导论")).toBe("ml");
    expect(guessCoverKind("操作系统：三个简单部分")).toBe("systems");
    expect(guessCoverKind("计算机网络：自顶向下方法")).toBe("network");
    expect(guessCoverKind("宏观经济学")).toBe("economics");
    expect(guessCoverKind("日语 N3 语法")).toBe("language");
  });

  it("prefers the specific subject over a generic word", () => {
    // 「线性代数」也是数学，但应该画矩阵而不是积分。
    expect(guessCoverKind("考研数学 · 线性代数")).toBe("linear");
    expect(guessCoverKind("概率论与数理统计")).toBe("probability");
  });

  it("falls back to the video title, then to generic", () => {
    expect(guessCoverKind(null, "第 3 讲 梯度下降")).toBe("ml");
    expect(guessCoverKind("我的收藏", "随便看看")).toBe("generic");
  });
});
