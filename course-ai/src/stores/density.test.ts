import { afterEach, describe, expect, it, vi } from "vitest";

describe("useDensity", () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.density;
    vi.resetModules();
  });

  it("默认舒适；切到紧凑后写 data-density 并记住", async () => {
    const { useDensity } = await import("./density");
    expect(useDensity.getState().density).toBe("comfortable");
    expect(document.documentElement.dataset.density).toBeUndefined();
    useDensity.getState().setDensity("compact");
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(localStorage.getItem("course-ai-density")).toBe("compact");
    useDensity.getState().setDensity("comfortable");
    expect(document.documentElement.dataset.density).toBeUndefined();
  });

  it("启动时读回上次的选择，非法值回到舒适", async () => {
    localStorage.setItem("course-ai-density", "compact");
    const first = await import("./density");
    expect(first.useDensity.getState().density).toBe("compact");
    vi.resetModules();
    localStorage.setItem("course-ai-density", "huge");
    const second = await import("./density");
    expect(second.useDensity.getState().density).toBe("comfortable");
  });
});
