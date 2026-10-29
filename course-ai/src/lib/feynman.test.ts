import { describe, expect, it } from "vitest";
import type { FeynmanResult } from "@/lib/types";
import { coverage, filledGaps, markExplanation, samePoint } from "./feynman";

const result = (over: Partial<FeynmanResult>): FeynmanResult => ({
  covered: [],
  missed: [],
  wrong: [],
  comment: "",
  ...over,
});

describe("feynman", () => {
  it("把原话切成讲对 / 讲错 / 普通几段，讲错的带上正确说法", () => {
    const text = "梯度下降就是沿着负梯度走。学习率越大越好。";
    const pieces = markExplanation(
      text,
      result({
        covered: [{ point: "方向", quote: "沿着负梯度走。" }],
        wrong: [{ quote: "学习率越大越好", correction: "过大会震荡", video_id: null, ref_ms: null }],
      }),
    );
    expect(pieces.map((piece) => piece.kind)).toEqual(["plain", "covered", "wrong", "plain"]);
    expect(pieces[2]).toEqual({ text: "学习率越大越好", kind: "wrong", note: "过大会震荡" });
    expect(pieces.map((piece) => piece.text).join("")).toBe(text);
  });

  it("引语对不上原文时不标，原文完整保留", () => {
    const pieces = markExplanation("我的理解", result({ covered: [{ point: "x", quote: "完全不同的话" }] }));
    expect(pieces).toEqual([{ text: "我的理解", kind: "plain" }]);
  });

  it("判断两个要点是否同一件事", () => {
    expect(samePoint("学习率过大会震荡", "学习率太大时会来回震荡")).toBe(true);
    expect(samePoint("学习率过大会震荡", "梯度是增长最快的方向")).toBe(false);
    expect(samePoint("学习率过大会震荡", "学习率的选择")).toBe(false);
  });

  it("再讲一遍：数出上次漏掉、这次补上的要点；覆盖率按要点算", () => {
    const previous = result({ missed: [{ point: "学习率过大会震荡", video_id: null, ref_ms: null }] });
    const current = result({ covered: [{ point: "学习率太大时会来回震荡", quote: "" }], missed: [{ point: "x", video_id: null, ref_ms: null }] });
    expect(filledGaps(previous, current)).toEqual(["学习率过大会震荡"]);
    expect(coverage(current)).toBe(0.5);
    expect(coverage(result({}))).toBe(0);
  });
});
