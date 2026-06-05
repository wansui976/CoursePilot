import { describe, expect, it } from "vitest";
import { contentAspect, cropStyle, NO_INSETS, type Insets } from "./blackBars";

describe("cropStyle", () => {
  it("fills the stage box exactly when there is no crop", () => {
    const s = cropStyle({ width: 1280, height: 720 }, NO_INSETS);
    expect(s.width).toBe(1280);
    expect(s.height).toBe(720);
    expect(s.left).toBe(0);
    expect(s.top).toBe(0);
    expect(s.position).toBe("absolute");
  });

  it("scales and offsets to push letterbox bars out of view, no distortion", () => {
    const crop: Insets = { top: 0.1, right: 0, bottom: 0.1, left: 0 };
    const s = cropStyle({ width: 1280, height: 720 }, crop);
    // height 放大到 720 / 0.8 = 900，宽不变，向上偏移 -900*0.1 = -90。
    expect(s.width).toBe(1280);
    expect(s.height).toBeCloseTo(900, 5);
    expect(s.top).toBeCloseTo(-90, 5);
    expect(s.left).toBe(0);
  });

  it("snaps crop geometry to device pixels when a dpr is provided", () => {
    const crop: Insets = { top: 0, right: 0.1, bottom: 0, left: 0.1 };
    const s = cropStyle({ width: 335.5, height: 240 }, crop, 2);
    expect(s.width).toBe(419.5);
    expect(s.height).toBe(240);
    expect(s.left).toBe(-42);
    expect(s.top).toBe(0);
  });
});

describe("contentAspect", () => {
  it("returns the raw aspect when there is no crop", () => {
    expect(contentAspect(16 / 9, NO_INSETS)).toBeCloseTo(16 / 9, 5);
  });

  it("widens the aspect for letterbox (top/bottom) crop", () => {
    const crop: Insets = { top: 0.1, right: 0, bottom: 0.1, left: 0 };
    expect(contentAspect(16 / 9, crop)).toBeCloseTo((16 / 9) / 0.8, 5);
  });

  it("narrows the aspect for pillarbox (left/right) crop", () => {
    const crop: Insets = { top: 0, right: 0.1, bottom: 0, left: 0.1 };
    expect(contentAspect(16 / 9, crop)).toBeCloseTo((16 / 9) * 0.8, 5);
  });
});
