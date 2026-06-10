import { describe, expect, it } from "vitest";
import { displayTitle } from "./videoTitle";

describe("displayTitle", () => {
  it("strips a trailing video extension", () => {
    expect(displayTitle("01.底层逻辑.mp4")).toBe("01.底层逻辑");
    expect(displayTitle("lecture.MKV")).toBe("lecture");
  });

  it("leaves titles without a video extension unchanged", () => {
    expect(displayTitle("第一章 总论")).toBe("第一章 总论");
    expect(displayTitle("notes.pdf")).toBe("notes.pdf");
    expect(displayTitle("a.mp4.summary")).toBe("a.mp4.summary");
  });
});
