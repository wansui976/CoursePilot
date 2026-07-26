import { beforeEach, describe, expect, it } from "vitest";
import {
  contentAspect,
  cropStyle,
  formatCropNotice,
  formatInsets,
  isCropEnabled,
  NO_INSETS,
  setCropEnabled,
  symmetricInsets,
  type Insets,
} from "./blackBars";

describe("black bar switch", () => {
  beforeEach(() => localStorage.clear());

  it("crops by default and remembers being turned off", () => {
    // 默认开：绝大多数带黑边的录像去掉更好看。
    expect(isCropEnabled()).toBe(true);
    setCropEnabled(false);
    expect(isCropEnabled()).toBe(false);
    setCropEnabled(true);
    expect(isCropEnabled()).toBe(true);
  });

  it("shows both the detected and the actually-used insets when they differ", () => {
    // 单边误判被对称化抹平时，两组数不一样——排查裁歪要看的就是这个差别。
    expect(
      formatCropNotice({ top: 0.0625, right: 0, bottom: 0.0625, left: 0.125 }, true),
    ).toBe(
      "已开启去黑边：上 6.3% / 右 0.0% / 下 6.3% / 左 12.5% → 实际用 上 6.3% / 右 0.0% / 下 6.3% / 左 0.0%",
    );
    // 探测本就对称时不必重复写两遍。
    expect(formatCropNotice({ top: 0.1, right: 0, bottom: 0.1, left: 0 }, true)).toBe(
      "已开启去黑边：上 10.0% / 右 0.0% / 下 10.0% / 左 0.0%",
    );
    expect(formatCropNotice({ top: 0.1, right: 0, bottom: 0.1, left: 0 }, false)).toBe(
      "已关闭去黑边（探测值 上 10.0% / 右 0.0% / 下 10.0% / 左 0.0%）",
    );
  });

  it("spells out the four insets for troubleshooting a lopsided picture", () => {
    expect(formatInsets({ top: 0.0625, right: 0, bottom: 0.0625, left: 0.125 })).toBe(
      "上 6.3% / 右 0.0% / 下 6.3% / 左 12.5%",
    );
  });
});

describe("symmetricInsets", () => {
  it("drops a one-sided inset so the picture stays centered", () => {
    // 只检测到左边有「黑边」（右边 0）→ 归零，避免把画面推向一边。
    expect(symmetricInsets({ top: 0, right: 0, bottom: 0, left: 0.1 })).toEqual(NO_INSETS);
  });

  it("leaves a one-sided black bar alone instead of shaving the other side", () => {
    // 源片右边有一条真黑边（20%），左边只是画面偏暗被误判成 2%。
    // 取 min 会照着 2% 裁：右边那条黑边一点没少，左边却把真实画面削掉一条
    // ——正是「左侧被裁切、右侧有黑边」。差得这么多就不该当成对称黑边。
    expect(symmetricInsets({ top: 0, right: 0.2, bottom: 0, left: 0.02 })).toEqual(NO_INSETS);
    // 上下同理。
    expect(symmetricInsets({ top: 0.18, right: 0, bottom: 0.03, left: 0 })).toEqual(NO_INSETS);
  });

  it("ignores a hair-thin inset on both sides", () => {
    // 1% 上下的对称「黑边」多半是编码边缘抖动，裁了没收益，只会损失画面。
    expect(symmetricInsets({ top: 0.012, right: 0.01, bottom: 0.012, left: 0.011 })).toEqual(
      NO_INSETS,
    );
  });

  it("keeps a symmetric letterbox but levels a slightly asymmetric one", () => {
    // 对称信箱黑边保留；左右轻微不等时取较小值，去掉歪斜。
    expect(symmetricInsets({ top: 0.06, right: 0.02, bottom: 0.06, left: 0.03 })).toEqual({
      top: 0.06,
      right: 0.02,
      bottom: 0.06,
      left: 0.02,
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
