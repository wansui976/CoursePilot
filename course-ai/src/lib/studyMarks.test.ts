import { describe, expect, it } from "vitest";
import { noteMoments, timelineMarks } from "./studyMarks";

describe("noteMoments", () => {
  it("reads TipTap timestamp nodes, HTML chips and markdown clocks", () => {
    const tiptap = JSON.stringify({ type: "timestamp", attrs: { ms: 65000, label: "" } });
    expect(noteMoments(tiptap)).toEqual([65000]);
    expect(noteMoments('<span data-ms="12000">▶ 00:12</span>')).toEqual([12000]);
    expect(noteMoments("要点 [03:10]，另见 [1:04:22] 和 [12:00-13:30]")).toEqual([190000, 720000, 3862000]);
  });

  it("dedupes and sorts, and is empty without notes", () => {
    expect(noteMoments("[00:05] [00:05] [00:01]")).toEqual([1000, 5000]);
    expect(noteMoments(null)).toEqual([]);
  });
});

describe("timelineMarks", () => {
  it("turns cards into highlight marks and lapsed cards into mistakes", () => {
    const marks = timelineMarks("[00:10]", [
      { card_id: "a", source_ms: 5000, lapses: 0 },
      { card_id: "b", source_ms: 9000, lapses: 2 },
    ]);
    expect(marks).toEqual({ notes: [10000], cards: [5000, 9000], mistakes: [9000] });
  });
});
