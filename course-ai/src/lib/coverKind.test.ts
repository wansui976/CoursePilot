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

describe("more subjects and stable picks", () => {
  it("recognises sciences, programming and history", () => {
    expect(guessCoverKind("大学物理（上）")).toBe("physics");
    expect(guessCoverKind("有机化学")).toBe("chemistry");
    expect(guessCoverKind("食品营养与生食安全")).toBe("biology");
    expect(guessCoverKind("Python 编程入门")).toBe("programming");
    expect(guessCoverKind("中国近代史纲要")).toBe("history");
  });

  it("picks the same index for the same name", async () => {
    const { stableIndex } = await import("./coverKind");
    expect(stableIndex("新课程 2", 4)).toBe(stableIndex("新课程 2", 4));
    const picks = new Set(["新课程 1", "新课程 2", "新课程 3", "新课程 4", "新课程 5", "新课程 6"].map((n) => stableIndex(n, 4)));
    expect(picks.size).toBeGreaterThan(1);
  });

  it("does not match a subject keyword inside another word", () => {
    expect(guessCoverKind("Photography videos")).not.toBe("systems");
    expect(guessCoverKind("Lesson2 课程")).not.toBe("language");
    expect(guessCoverKind("Section1 导论")).not.toBe("language");
    expect(guessCoverKind("日语N1 词汇")).toBe("language");
    expect(guessCoverKind("OS 进程调度")).toBe("systems");
  });
});
