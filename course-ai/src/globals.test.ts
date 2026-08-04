import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve("src/globals.css"), "utf8");

describe("强调色令牌的用法约束", () => {
  it("前景色一律用 --accent-text，不用 --accent", () => {
    // --accent 是实心块的底色。它在暗色主题里刻意保持原值，白字才压得住；
    // --accent-text 才是随主题走的前景变体（暗色下会变亮）。
    // 拿 --accent 当图标/文字色，在近黑底上只有 3.7:1，而且与页面别处的强调蓝
    // 明显不是同一个颜色——左栏选中项、底部选中页签、空态图标一度全踩了这个坑。
    const misuse = [
      ...css.matchAll(
        /^[ \t]*(?:color|-webkit-text-fill-color):\s*var\(--accent\)\s*;/gm,
      ),
    ].map((match) => match[0].trim());

    expect(misuse).toEqual([]);
  });

  it("--accent-text 在两套主题下都有值", () => {
    // 上一条把前景都指向了 --accent-text；它若只在亮色下定义，等于把问题挪了个地方。
    const light = css.match(/^:root\s*\{[\s\S]*?\n\}/m)?.[0] ?? "";
    const dark = css.match(/^\[data-theme="dark"\]\s*\{[\s\S]*?\n\}/m)?.[0] ?? "";

    expect(light).toMatch(/--accent-text:/);
    expect(dark).toMatch(/--accent-text:/);
  });
});
