import { describe, expect, it } from "vitest";
import { noteStampTimes, rulerStepMinutes } from "./noteStamps";

describe("noteStampTimes", () => {
  it("从 Tiptap JSON 里找时间戳节点，升序去重", () => {
    const doc = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "timestamp", attrs: { ms: 90_000 } }] },
        { type: "paragraph", content: [{ type: "timestamp", attrs: { ms: 5_000 } }, { type: "timestamp", attrs: { ms: 90_000 } }] },
      ],
    });
    expect(noteStampTimes(doc)).toEqual([5_000, 90_000]);
  });

  it("旧的 markdown 笔记按 [mm:ss] 找，[00:00] 也算，乱写的不算", () => {
    expect(noteStampTimes("开头 [00:00] 中间 [01:30-02:00] 乱写 [99:99]")).toEqual([0, 90_000]);
    expect(noteStampTimes(null)).toEqual([]);
  });
});

describe("rulerStepMinutes", () => {
  it("一条进度条最多约 90 道分钟刻度", () => {
    expect(rulerStepMinutes(45 * 60_000)).toBe(1);
    expect(rulerStepMinutes(120 * 60_000)).toBe(5);
    expect(rulerStepMinutes(10 * 3_600_000)).toBe(10);
  });
});
