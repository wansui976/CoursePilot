import { describe, expect, it } from "vitest";
import { lectureOrder, parseLectureNumber } from "./lectureOrder";

const videos = (...titles: string[]) => titles.map((title, i) => ({ id: `v${i}`, title }));
const titlesOf = (list: { id: string; title: string }[], order: string[] | null) =>
  order?.map((id) => list.find((video) => video.id === id)!.title);

describe("parseLectureNumber", () => {
  it("reads Arabic and Chinese numerals", () => {
    expect(parseLectureNumber("12")).toBe(12);
    expect(parseLectureNumber("十")).toBe(10);
    expect(parseLectureNumber("十二")).toBe(12);
    expect(parseLectureNumber("二十三")).toBe(23);
    expect(parseLectureNumber("两")).toBe(2);
    expect(parseLectureNumber("一百零五")).toBe(105);
    expect(parseLectureNumber("abc")).toBeNull();
    expect(parseLectureNumber("")).toBeNull();
  });
});

describe("lectureOrder", () => {
  it("sorts 第N讲 with Chinese numerals by value, not by text", () => {
    const list = videos("第十讲 决策树", "第二讲 线性回归", "第一讲 绪论", "第十一讲 SVM");
    expect(titlesOf(list, lectureOrder(list))).toEqual([
      "第一讲 绪论",
      "第二讲 线性回归",
      "第十讲 决策树",
      "第十一讲 SVM",
    ]);
  });

  it("prefers the numbering that most titles share, and splits a lecture's parts by title", () => {
    // B 站分 P：P 序号每个都有，「第N讲」有重复（上 / 下），按 P 排。
    const list = videos(
      "吴恩达机器学习 P3 第二讲（下）",
      "吴恩达机器学习 P1 第一讲",
      "吴恩达机器学习 P2 第二讲（上）",
      "吴恩达机器学习 P10 答疑",
    );
    expect(titlesOf(list, lectureOrder(list))).toEqual([
      "吴恩达机器学习 P1 第一讲",
      "吴恩达机器学习 P2 第二讲（上）",
      "吴恩达机器学习 P3 第二讲（下）",
      "吴恩达机器学习 P10 答疑",
    ]);
  });

  it("handles English names, leading numbers and full-width digits", () => {
    const lectures = videos("Lecture 10 - RNN", "Lecture 2 - CNN", "lec1 intro");
    expect(titlesOf(lectures, lectureOrder(lectures))).toEqual(["lec1 intro", "Lecture 2 - CNN", "Lecture 10 - RNN"]);

    const leading = videos("10. 总结", "02 回归", "1、绪论");
    expect(titlesOf(leading, lectureOrder(leading))).toEqual(["1、绪论", "02 回归", "10. 总结"]);

    const fullWidth = videos("第１２讲", "第３讲");
    expect(titlesOf(fullWidth, lectureOrder(fullWidth))).toEqual(["第３讲", "第１２讲"]);
  });

  it("keeps unnumbered videos at the end in their original order", () => {
    const list = videos("课程介绍", "第三讲", "补充材料", "第一讲");
    expect(titlesOf(list, lectureOrder(list))).toEqual(["第一讲", "第三讲", "课程介绍", "补充材料"]);
  });

  it("does not mistake file extensions, years or words for lecture numbers", () => {
    expect(lectureOrder(videos("intro.mp4", "app3 demo"))).toBeNull();
    expect(lectureOrder(videos("2024 年真题", "2023 年真题"))).toBeNull();
    expect(lectureOrder(videos("只有一个 第一讲", "没有编号"))).toBeNull();
  });
});
