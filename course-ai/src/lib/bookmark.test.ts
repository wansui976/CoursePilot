import { beforeEach, describe, expect, it } from "vitest";
import { atKey, lastVideoKey } from "@/lib/playback";
import { courseBookmark, DUSTY_AFTER_DAYS } from "./bookmark";

const videos = [
  { id: "a", title: "第 1 讲 引言" },
  { id: "b", title: "梯度下降" },
];
const NOW = Date.UTC(2026, 10, 23);

describe("courseBookmark", () => {
  beforeEach(() => localStorage.clear());

  it("has no ribbon for a course never opened", () => {
    expect(courseBookmark("c", videos, NOW)).toBeNull();
  });

  it("sits at the last opened lecture and gathers dust after two weeks", () => {
    localStorage.setItem(lastVideoKey("c"), "b");
    localStorage.setItem(atKey("b"), String(NOW - 3 * 86_400_000));
    expect(courseBookmark("c", videos, NOW)).toMatchObject({ lecture: 2, idleDays: 3, dusty: false });
    localStorage.setItem(atKey("b"), String(NOW - DUSTY_AFTER_DAYS * 86_400_000));
    expect(courseBookmark("c", videos, NOW)?.dusty).toBe(true);
  });
});
