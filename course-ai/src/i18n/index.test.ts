import { afterEach, describe, expect, it } from "vitest";
import i18n, { changeLanguage } from "./index";

describe("i18n document metadata", () => {
  afterEach(async () => {
    await changeLanguage("zh-CN");
  });

  it("keeps the document language and title in sync", async () => {
    await changeLanguage("en");

    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("CoursePilot · Learning workspace");
    expect(localStorage.getItem("course-ai-lang")).toBe("en");

    await changeLanguage("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.title).toBe("CoursePilot · 学习工作台");
  });

  it("also follows language changes made through i18next", async () => {
    await i18n.changeLanguage("en");

    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toContain("CoursePilot");
  });
});
