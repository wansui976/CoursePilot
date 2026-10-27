import { describe, expect, it } from "vitest";
import { isBilibiliUrl, looksLikeLink } from "./sourceUrl";

describe("isBilibiliUrl", () => {
  it("matches bilibili hosts and short links", () => {
    expect(isBilibiliUrl("https://www.bilibili.com/video/BV1xx")).toBe(true);
    expect(isBilibiliUrl("  https://b23.tv/abc ")).toBe(true);
    expect(isBilibiliUrl("https://m.bilibili.com/video/BV1xx")).toBe(true);
  });

  it("rejects other sites, look-alike hosts and non-URLs", () => {
    expect(isBilibiliUrl("https://www.youtube.com/watch?v=x")).toBe(false);
    expect(isBilibiliUrl("https://bilibili.com.example/video")).toBe(false);
    expect(isBilibiliUrl("BV1xx")).toBe(false);
  });
});

describe("looksLikeLink", () => {
  it("recognizes links with or without a scheme", () => {
    expect(looksLikeLink("https://www.bilibili.com/video/BV1xx?p=25")).toBe(true);
    expect(looksLikeLink("b23.tv/abc")).toBe(true);
    expect(looksLikeLink("www.bilibili.com/video/BV1xx")).toBe(true);
    expect(looksLikeLink("  https://youtu.be/x  ")).toBe(true);
  });

  it("does not mistake ordinary titles containing slashes for links", () => {
    expect(looksLikeLink("线性代数第二讲")).toBe(false);
    expect(looksLikeLink("第1/2讲")).toBe(false);
    expect(looksLikeLink("3.5/5星")).toBe(false);
    expect(looksLikeLink("第 1/2 讲")).toBe(false);
    expect(looksLikeLink("")).toBe(false);
  });
});
