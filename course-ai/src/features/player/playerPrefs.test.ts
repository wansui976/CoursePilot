import { beforeEach, describe, expect, it } from "vitest";
import { loadPlaybackRate, persistPlaybackRate } from "./playerPrefs";

beforeEach(() => localStorage.clear());

describe("per-course playback rate", () => {
  it("remembers each course's own rate and falls back to the last one picked", () => {
    expect(loadPlaybackRate("a")).toBe(1);
    persistPlaybackRate(1.5, "a");
    persistPlaybackRate(1.25, "b");
    expect(loadPlaybackRate("a")).toBe(1.5);
    expect(loadPlaybackRate("b")).toBe(1.25);
    // 没调过的课：用最近一次选的。
    expect(loadPlaybackRate("c")).toBe(1.25);
    expect(loadPlaybackRate()).toBe(1.25);
  });

  it("ignores unsupported stored values", () => {
    localStorage.setItem("course-ai-course-rate:a", "7");
    expect(loadPlaybackRate("a")).toBe(1);
  });
});
