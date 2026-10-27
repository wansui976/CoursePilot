import { describe, expect, it } from "vitest";
import { isBilibiliUrl, titleRepeatsUrl } from "./sourceUrl";
import cases from "./titleRepeatsUrl.cases.json";

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

describe("titleRepeatsUrl", () => {
  // 与 Rust 端 title_repeats_url 共用同一份用例，两边规则不能各改各的。
  it.each(cases.cases)("$title → $repeats", ({ title, url, repeats }) => {
    expect(titleRepeatsUrl(title, url)).toBe(repeats);
  });
});
