import type { CSSProperties } from "react";

/** 四边黑边占比（0~1）。 */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * 只保留**对称**黑边：对边取较小值（left/right 取 min，top/bottom 取 min）。
 * 真实信箱/邮筒黑边本就对称；单边多出来的一点几乎都是边缘/压缩噪声的误判——
 * 若照单全收会把画面往一边推（看起来「歪了/没居中」）。对称化后裁剪永远居中，
 * 同时仍能去掉真正的对称黑边。
 */
export function symmetricInsets(crop: Insets): Insets {
  const lr = Math.min(crop.left, crop.right);
  const tb = Math.min(crop.top, crop.bottom);
  return { top: tb, right: lr, bottom: tb, left: lr };
}

export interface Box {
  width: number;
  height: number;
}

function snapToDevicePixel(value: number, dpr: number): number {
  if (!Number.isFinite(dpr) || dpr <= 0) return value;
  return Math.round(value * dpr) / dpr;
}

/**
 * 把裁剪矩形换算成 `<video>` 的绝对定位样式：放大并负偏移，使内容区正好铺满
 * 尺寸为 stageBox 的 `overflow:hidden` 包裹层，黑边被推出视野。
 * 无裁剪时即 width=stageBox.width、height=stageBox.height、零偏移（等价原渲染）。
 * width/height 比值恒等于原视频固有比例，故纯裁剪、零拉伸。
 */
export function cropStyle(
  stageBox: Box,
  crop: Insets,
  dpr = 1,
): CSSProperties {
  const denomW = 1 - crop.left - crop.right;
  const denomH = 1 - crop.top - crop.bottom;
  const width = snapToDevicePixel(stageBox.width / denomW, dpr);
  const height = snapToDevicePixel(stageBox.height / denomH, dpr);
  return {
    position: "absolute",
    left: snapToDevicePixel(-width * crop.left, dpr) || 0,
    top: snapToDevicePixel(-height * crop.top, dpr) || 0,
    width,
    height,
  };
}

/** 裁剪后内容区的宽高比 = 原比例 × (1-左-右) / (1-上-下)。 */
export function contentAspect(videoAspect: number, crop: Insets): number {
  const w = 1 - crop.left - crop.right;
  const h = 1 - crop.top - crop.bottom;
  return (videoAspect * w) / h;
}
