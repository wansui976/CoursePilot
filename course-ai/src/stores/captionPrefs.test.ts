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
