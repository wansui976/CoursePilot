import { beforeEach, describe, expect, it } from "vitest";
import { useCaptionPrefs } from "./captionPrefs";

describe("captionPrefs", () => {
  beforeEach(() => {
    localStorage.clear();
    useCaptionPrefs.setState({
      mode: "original",
      lang: "zh",
      size: "medium",
      background: "translucent",
    });
  });

  it("cycles original → bilingual → translation → original and persists it", () => {
    const { cycleMode } = useCaptionPrefs.getState();
    cycleMode();
    expect(useCaptionPrefs.getState().mode).toBe("bilingual");
    expect(localStorage.getItem("course-ai-caption-mode")).toBe("bilingual");
    cycleMode();
    expect(useCaptionPrefs.getState().mode).toBe("translation");
    cycleMode();
    expect(useCaptionPrefs.getState().mode).toBe("original");
  });

  it("persists the target language", () => {
    useCaptionPrefs.getState().setLang("ja");
    expect(localStorage.getItem("course-ai-translation-lang")).toBe("ja");
  });

  it("persists the caption size and background style", () => {
    useCaptionPrefs.getState().setSize("large");
    useCaptionPrefs.getState().setBackground("none");
    expect(useCaptionPrefs.getState()).toMatchObject({ size: "large", background: "none" });
    expect(localStorage.getItem("course-ai-caption-size")).toBe("large");
    expect(localStorage.getItem("course-ai-caption-background")).toBe("none");
  });
});

describe("翻译目标语言的默认值", () => {
  it("中文文稿默认译成英文，其余默认译成中文；日文有假名不算中文", async () => {
    const { defaultTranslationLang } = await import("./captionPrefs");
    expect(defaultTranslationLang(["今天我们学习牛顿第一定律", "惯性是物体本身的属性"])).toBe("en");
    expect(defaultTranslationLang(["Today we study Newton's first law"])).toBe("zh");
    expect(defaultTranslationLang(["今日は慣性について学びます"])).toBe("zh");
    expect(defaultTranslationLang([])).toBe("zh");
  });

  it("用户选过就用选的", async () => {
    const { useCaptionPrefs } = await import("./captionPrefs");
    useCaptionPrefs.getState().setLang("ja");
    expect(useCaptionPrefs.getState().langChosen).toBe(true);
    expect(useCaptionPrefs.getState().lang).toBe("ja");
  });
});
