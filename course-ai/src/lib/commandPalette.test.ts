import { describe, expect, it } from "vitest";
import { matchScore, parseTimeQuery, rankEntries, type PaletteEntry } from "./commandPalette";

describe("matchScore", () => {
  it("prefers prefix over word-start over infix over scattered", () => {
    const prefix = matchScore("梯度", "梯度下降");
    const word = matchScore("下降", "梯度 下降");
    const infix = matchScore("下降", "梯度下降");
    const scattered = matchScore("梯降", "梯度下降");
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(infix);
    expect(infix).toBeGreaterThan(scattered);
    expect(scattered).toBeGreaterThan(0);
    expect(matchScore("降梯", "梯度下降")).toBe(0);
  });

  it("ignores case and treats empty queries as a match", () => {
    expect(matchScore("ML", "ml basics")).toBe(80);
    expect(matchScore("", "anything")).toBe(1);
  });
});

describe("rankEntries", () => {
  const entries: PaletteEntry[] = [
    { id: "v1", group: "video", label: "01 梯度下降", detail: "机器学习" },
    { id: "v2", group: "video", label: "02 反向传播", detail: "机器学习" },
    { id: "c1", group: "course", label: "机器学习" },
    { id: "p1", group: "page", label: "设置", keywords: ["settings"] },
  ];

  it("groups pages before courses before videos", () => {
    expect(rankEntries(entries, "").map((e) => e.id)).toEqual(["p1", "c1", "v1", "v2"]);
  });

  it("matches labels, keywords and details", () => {
    expect(rankEntries(entries, "settings").map((e) => e.id)).toEqual(["p1"]);
    // 课程名同时命中课程条目（标题）和两个视频（淡字）。
    expect(rankEntries(entries, "机器").map((e) => e.id)).toEqual(["c1", "v1", "v2"]);
    expect(rankEntries(entries, "反向").map((e) => e.id)).toEqual(["v2"]);
  });

  it("caps each group", () => {
    const many = Array.from({ length: 20 }, (_, i): PaletteEntry => ({
      id: `v${i}`,
      group: "video",
      label: `第 ${i} 讲`,
    }));
    expect(rankEntries(many, "讲", 5)).toHaveLength(5);
  });
});

describe("parseTimeQuery", () => {
  it("parses clock times", () => {
    expect(parseTimeQuery("12:30")).toBe(750_000);
    expect(parseTimeQuery("1:02:03")).toBe(3_723_000);
    expect(parseTimeQuery("0:05")).toBe(5_000);
  });

  it("parses unit times in both languages", () => {
    expect(parseTimeQuery("90s")).toBe(90_000);
    expect(parseTimeQuery("5m")).toBe(300_000);
    expect(parseTimeQuery("5分")).toBe(300_000);
    expect(parseTimeQuery("1小时2分")).toBe(3_720_000);
    expect(parseTimeQuery("1h 30m")).toBe(5_400_000);
  });

  it("rejects things that are not times", () => {
    expect(parseTimeQuery("3")).toBeNull();
    expect(parseTimeQuery("第3讲")).toBeNull();
    expect(parseTimeQuery("5m abc")).toBeNull();
    expect(parseTimeQuery("12:75")).toBeNull();
    expect(parseTimeQuery("")).toBeNull();
  });
});
