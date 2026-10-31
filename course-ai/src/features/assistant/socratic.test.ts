import { describe, expect, it } from "vitest";
import { guidedTopic, parseSocraticBlock, splitSocratic, visibleAnswer } from "./socratic";

describe("splitSocratic", () => {
  it("拆出正文与结构块", () => {
    const answer =
      '对，方向是对的。那学习率很大时会怎样？\n\n```socratic\n{"step":2,"total":4,"options":["会震荡","下降更快"],"hints":["想想步子太大","回看 [07:10]"],"answer":"会在谷底两侧来回跳","done":false}\n```';
    const { text, block } = splitSocratic(answer);
    expect(text).toBe("对，方向是对的。那学习率很大时会怎样？");
    expect(block).toEqual({
      step: 2,
      total: 4,
      options: ["会震荡", "下降更快"],
      hints: ["想想步子太大", "回看 [07:10]"],
      answer: "会在谷底两侧来回跳",
      done: false,
      summary: [],
    });
  });

  it("流式中块还没写完：正文先藏掉块，不解析", () => {
    const { text, block } = splitSocratic('问题？\n```socratic\n{"step":1,"opt');
    expect(text).toBe("问题？");
    expect(block).toBeNull();
  });

  it("没有块或 JSON 坏了：正文照常，没有按钮", () => {
    expect(splitSocratic("普通回答")).toEqual({ text: "普通回答", block: null });
    expect(splitSocratic("回答\n```socratic\n{坏的}\n```").block).toBeNull();
  });
});

describe("parseSocraticBlock", () => {
  it("收尾时只留总结与结论，选项和提示清空", () => {
    const block = parseSocraticBlock(
      '{"done":true,"options":["x"],"hints":["y"],"answer":"结论","summary":["要点一","要点二"]}',
    );
    expect(block).toEqual({ options: [], hints: [], answer: "结论", done: true, summary: ["要点一", "要点二"] });
  });

  it("字段类型不对就丢掉，数量封顶", () => {
    const block = parseSocraticBlock(
      JSON.stringify({ step: "2", total: 1.5, options: ["a", 1, "b", "c", "d", "e"], hints: "no" }),
    );
    expect(block).toEqual({ options: ["a", "b", "c", "d"], hints: [], done: false, summary: [] });
  });
});

describe("guidedTopic / visibleAnswer", () => {
  const block = (done: boolean) => `x\n\`\`\`socratic\n{"done":${done}}\n\`\`\``;
  const turns = [
    { id: "a", question: "普通问题", answer: "答" },
    { id: "b", question: "上一段引导", answer: block(true), mode: "socratic" as const },
    { id: "c", question: "这一段的起点", answer: block(false), mode: "socratic" as const },
    { id: "d", question: "我觉得是 A", answer: block(true), mode: "socratic" as const },
  ];

  it("从收尾那一轮往前找到这一段引导的第一问，越过上一段的收尾就停", () => {
    expect(guidedTopic(turns, "d")).toBe("这一段的起点");
    expect(guidedTopic(turns, "b")).toBe("上一段引导");
    expect(guidedTopic(turns, "missing")).toBeNull();
  });

  it("引导轮次复制 / 存笔记时去掉结构块，普通轮次原样", () => {
    expect(visibleAnswer({ answer: block(false), mode: "socratic" })).toBe("x");
    expect(visibleAnswer({ answer: block(false) })).toContain("```socratic");
  });

  it("结构块没闭合 / JSON 坏掉时不能把整轮复制成空", () => {
    // 只有块、块还坏了：正文被剥空，退回原文，至少让人能复制到自己真正说过的话。
    const broken = "```socratic\n{坏的}";
    expect(visibleAnswer({ answer: broken, mode: "socratic" })).toBe(broken);
    // 块合法但只有结构、没有正文：复制结论与要点。
    const onlyBlock = '```socratic\n{"done":true,"summary":["要点一"],"answer":"结论"}\n```';
    expect(visibleAnswer({ answer: onlyBlock, mode: "socratic" })).toBe("结论\n要点一");
    expect(visibleAnswer({ answer: block(false), mode: "socratic" })).not.toContain("```");
  });
});
