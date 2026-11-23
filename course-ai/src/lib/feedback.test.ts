import { beforeEach, describe, expect, it, vi } from "vitest";
import { HAPTIC_PATTERNS, haptic, useFeedbackPrefs } from "./feedback";

describe("feedback prefs", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to quiet sound and haptics on, and remembers changes", () => {
    expect(useFeedbackPrefs.getState().sound).toBe("quiet");
    useFeedbackPrefs.getState().setSound("off");
    useFeedbackPrefs.getState().setHaptics(false);
    expect(localStorage.getItem("course-ai-ui-sound")).toBe("off");
    expect(localStorage.getItem("course-ai-haptics")).toBe("0");
    useFeedbackPrefs.getState().setHaptics(true);
  });

  it("vibrates with the pattern for the moment, and not when turned off", () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
    useFeedbackPrefs.getState().setHaptics(true);
    haptic("warning");
    expect(vibrate).toHaveBeenCalledWith(HAPTIC_PATTERNS.warning);
    useFeedbackPrefs.getState().setHaptics(false);
    haptic("tick");
    expect(vibrate).toHaveBeenCalledTimes(1);
  });
});
