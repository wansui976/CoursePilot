import { describe, expect, it } from "vitest";
import { isBilibiliUrl } from "./sourceUrl";

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
