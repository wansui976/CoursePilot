import { beforeEach, describe, expect, it } from "vitest";
import { focusRemainingMs, localDay, useFocusTimer } from "./focusTimer";

const T0 = new Date(2026, 10, 28, 9, 0, 0).getTime();

beforeEach(() => {
  localStorage.clear();
  useFocusTimer.setState({
    phase: "idle",
    endsAt: 0,
    focusMinutes: 25,
    breakMinutes: 5,
    autoBreak: true,
    doneToday: { day: localDay(T0), count: 0, minutes: 0 },
    lastTransition: null,
  });
});

describe("focus timer", () => {
  it("counts down a focus block and rolls into a break", () => {
    const timer = useFocusTimer.getState();
    timer.start(T0);
    expect(useFocusTimer.getState().phase).toBe("focus");
    expect(focusRemainingMs(useFocusTimer.getState(), T0 + 60_000)).toBe(24 * 60_000);
    expect(useFocusTimer.getState().tick(T0 + 24 * 60_000)).toBe(false);

    expect(useFocusTimer.getState().tick(T0 + 25 * 60_000 + 500)).toBe(true);
    const state = useFocusTimer.getState();
    expect(state.phase).toBe("break");
    // 休息从专注本该结束的那一刻算起，不从 tick 晚到的那一刻。
    expect(state.endsAt).toBe(T0 + 30 * 60_000);
    expect(state.doneToday).toMatchObject({ count: 1, minutes: 25 });
    expect(state.lastTransition).toMatchObject({ from: "focus", to: "break" });

    useFocusTimer.getState().tick(T0 + 30 * 60_000);
    expect(useFocusTimer.getState().phase).toBe("idle");
    expect(JSON.parse(localStorage.getItem("course-ai-focus-done")!)).toMatchObject({ count: 1 });
  });

  it("persists the running block so a reload keeps counting", () => {
    useFocusTimer.getState().start(T0);
    expect(JSON.parse(localStorage.getItem("course-ai-focus-timer")!)).toEqual({
      phase: "focus",
      endsAt: T0 + 25 * 60_000,
    });
    useFocusTimer.getState().stop();
    expect(localStorage.getItem("course-ai-focus-timer")).toBeNull();
  });

  it("skips the break when coming back long after the block ended", () => {
    useFocusTimer.getState().start(T0);
    useFocusTimer.getState().tick(T0 + 8 * 3600_000);
    expect(useFocusTimer.getState().phase).toBe("idle");
    expect(useFocusTimer.getState().doneToday.count).toBe(1);
  });

  it("respects custom durations and the auto-break switch", () => {
    useFocusTimer.getState().setPrefs({ focusMinutes: 45, autoBreak: false });
    useFocusTimer.getState().start(T0);
    expect(useFocusTimer.getState().endsAt).toBe(T0 + 45 * 60_000);
    useFocusTimer.getState().tick(T0 + 45 * 60_000);
    expect(useFocusTimer.getState().phase).toBe("idle");
    expect(JSON.parse(localStorage.getItem("course-ai-focus-prefs")!)).toMatchObject({
      focusMinutes: 45,
      autoBreak: false,
    });
  });
});
