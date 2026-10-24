import { beforeEach, describe, expect, it, vi } from "vitest";

async function freshStore() {
  vi.resetModules();
  return import("./readingFont");
}

describe("阅读字体", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty("--font-reading");
    document.documentElement.style.removeProperty("--reading-scale");
  });

  it("没选过时默认宋体，并在加载时就写到 <html> 上", async () => {
    const { useReadingFont, readingFontStack } = await freshStore();
    expect(useReadingFont.getState().font).toBe("serif");
    expect(document.documentElement.style.getPropertyValue("--font-reading")).toBe(
      readingFontStack("serif"),
    );
  });

  it("切换后立即生效并记住，下次启动沿用", async () => {
    const first = await freshStore();
    first.useReadingFont.getState().setFont("kai");
    expect(document.documentElement.style.getPropertyValue("--font-reading")).toContain('"Kaiti SC"');

    const second = await freshStore();
    expect(second.useReadingFont.getState().font).toBe("kai");
  });

  it("存储里是不认识的值时回到默认", async () => {
    localStorage.setItem("course-ai-reading-font", "comic-sans");
    const { useReadingFont } = await freshStore();
    expect(useReadingFont.getState().font).toBe("serif");
  });

  it("黑体沿用界面字体；衬线类不拿 serif 兜底（Windows 上会落到发虚的 SimSun）", async () => {
    const { readingFontStack } = await freshStore();
    expect(readingFontStack("sans")).toBe("var(--font-app)");
    for (const font of ["serif", "kai", "fangsong"] as const) {
      const stack = readingFontStack(font);
      expect(stack.endsWith("var(--font-app)")).toBe(true);
      expect(stack).not.toMatch(/SimSun|(^|,\s*)serif\s*(,|$)/);
    }
  });

  it("阅读字号默认标准；切换后写 --reading-scale 并记住，非法值回到标准", async () => {
    const first = await freshStore();
    expect(first.useReadingFont.getState().size).toBe("medium");
    expect(document.documentElement.style.getPropertyValue("--reading-scale")).toBe("1");

    first.useReadingFont.getState().setSize("large");
    expect(document.documentElement.style.getPropertyValue("--reading-scale")).toBe("1.12");
    const second = await freshStore();
    expect(second.useReadingFont.getState().size).toBe("large");

    localStorage.setItem("course-ai-reading-size", "huge");
    const third = await freshStore();
    expect(third.useReadingFont.getState().size).toBe("medium");
  });
});
