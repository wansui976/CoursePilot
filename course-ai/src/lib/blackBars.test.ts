import { describe, expect, it } from "vitest";
import {
  contentAspect,
  cropStyle,
  NO_INSETS,
  resolveCrop,
  type Insets,
} from "./blackBars";

describe("resolveCrop", () => {
  it("keeps a one-sided inset when the opposite edge is clean", () => {
    // 课程录屏常见：顶部一条工具栏黑边、底部没有；不能因为不对称就整轴放弃。
    expect(resolveCrop({ top: 0.037, right: 0.05, bottom: 0, left: 0.05 })).toEqual({
      top: 0.037,
      right: 0.05,
      bottom: 0,
      left: 0.05,
    });
    expect(resolveCrop({ top: 0, right: 0, bottom: 0, left: 0.1 })).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0.1,
    });
  });

  it("treats a few pixels of encoder noise on the opposite edge as clean", () => {
    // cropdetect 按 2px 取整：干净的底边常测出 2/1080 ≈ 0.0019，不能因此把顶部工具栏黑边又放弃掉。
    expect(resolveCrop({ top: 0.037, right: 0, bottom: 0.0019, left: 0 })).toEqual({
      top: 0.037,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });

  it("does not crop a wide one-sided dark area that is probably content", () => {
    // 深色主题录屏：底部 30% 是黑底终端，顶部没有黑边。没有对侧可以对照，不能当黑边整块切掉。
    expect(resolveCrop({ top: 0, right: 0, bottom: 0.3, left: 0 })).toEqual(NO_INSETS);
    expect(resolveCrop({ top: 0, right: 0.2, bottom: 0, left: 0.015 })).toEqual(NO_INSETS);
  });

  it("leaves a wildly asymmetric axis alone instead of shaving the other side", () => {
    // 源片右边有一条真黑边（20%），左边只是画面偏暗被误判成 2%。
    // 两侧差太多就不是同一条黑边，照单全收会把暗色内容当黑边削掉。
    expect(resolveCrop({ top: 0, right: 0.2, bottom: 0, left: 0.02 })).toEqual(NO_INSETS);
    // 上下同理。
    expect(resolveCrop({ top: 0.18, right: 0, bottom: 0.03, left: 0 })).toEqual(NO_INSETS);
  });

  it("ignores a hair-thin inset on both sides", () => {
    // 1% 上下的对称「黑边」多半是编码边缘抖动，裁了没收益，只会损失画面。
    expect(resolveCrop({ top: 0.012, right: 0.01, bottom: 0.012, left: 0.011 })).toEqual(
      NO_INSETS,
    );
  });

  it("crops each side by its own value so the wider side does not keep a sliver", () => {
    // 回归：左右黑边宽度接近但不相等（差 ≤3%）。原来对边取较小值，宽的那侧会
    // 留下一条缝——表现为「只裁掉了一边」。现在各自裁各自的，两边都完整去掉。
    expect(resolveCrop({ top: 0.06, right: 0.02, bottom: 0.06, left: 0.03 })).toEqual({
      top: 0.06,
      right: 0.02,
      bottom: 0.06,
      left: 0.03,
    });
    // 更明显的不对称（差仍 ≤3%）：右 10%、左 8%，两边各自裁干净。
    expect(resolveCrop({ top: 0, right: 0.1, bottom: 0, left: 0.08 })).toEqual({
      top: 0,
      right: 0.1,
      bottom: 0,
      left: 0.08,
    });
  });

  it("keeps a perfectly symmetric letterbox", () => {
    expect(resolveCrop({ top: 0.06, right: 0.08, bottom: 0.06, left: 0.08 })).toEqual({
      top: 0.06,
      right: 0.08,
      bottom: 0.06,
      left: 0.08,
    });
  });
});

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

  it("opts out of preflight max-width so right/bottom bars can be clipped", () => {
    // Tailwind preflight 的 `img, video { max-width: 100% }` 会把放大后的视频夹回舞台
    // 宽度：left 偏移生效、右侧黑边却留在舞台里，看起来就像只裁了左边。
    const crop: Insets = { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 };
    const s = cropStyle({ width: 1280, height: 720 }, crop);
    expect(s.width).toBeGreaterThan(1280);
    expect(s.maxWidth).toBe("none");
    expect(s.maxHeight).toBe("none");
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
