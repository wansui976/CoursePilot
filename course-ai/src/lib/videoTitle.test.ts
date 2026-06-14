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

  it("decodes iOS percent-encoded file provider titles", () => {
    expect(
      displayTitle(
        "%E9%81%93%E5%BE%B7%E6%B0%B4%E5%B9%B3%E9%AB%98%EF%BC%8C%E5%AF%BC%E8%87%B4%E5%AD%A6%E6%9C%AF%E9%80%A0%E5%81%87%E5%A4%9A%EF%BC%9F.f30080-6A1CC6C8-C5A4-4BC9-AFAC-3A402347A35E.mp4",
      ),
    ).toBe("道德水平高，导致学术造假多？");
  });
});
