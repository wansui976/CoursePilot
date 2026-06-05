import type { CSSProperties } from "react";

/** 四边黑边占比（0~1）。 */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

// 三通道都 ≤ 此值才算「黑」（通道级判定，避免把深色内容误判成黑边）。
const BLACK_LEVEL = 16;
// 一行/列里允许超阈值的离群像素比例（容忍噪点、角标）。
const OUTLIER_FRAC = 0.02;
// 黑边占比下限：低于此值视为 0（避免 1~2px 抖动裁剪）。
const MIN_INSET = 0.015;
// 黑边占比上限：高于此值视为异常（整帧偏暗等），该边不裁。
const MAX_INSET = 0.4;

function isBlack(data: Uint8ClampedArray, i: number): boolean {
  return (
    data[i] <= BLACK_LEVEL &&
    data[i + 1] <= BLACK_LEVEL &&
    data[i + 2] <= BLACK_LEVEL
  );
}

function rowIsBlack(data: Uint8ClampedArray, w: number, y: number): boolean {
  let nonBlack = 0;
  const limit = w * OUTLIER_FRAC;
  for (let x = 0; x < w; x++) {
    if (!isBlack(data, (y * w + x) * 4) && ++nonBlack > limit) return false;
  }
  return true;
}

function colIsBlack(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
): boolean {
  let nonBlack = 0;
  const limit = h * OUTLIER_FRAC;
  for (let y = 0; y < h; y++) {
    if (!isBlack(data, (y * w + x) * 4) && ++nonBlack > limit) return false;
  }
  return true;
}

/** 把「连续黑行/列数 / 总数」换算成最终占比，套用上下限保护。 */
function toInset(blackCount: number, total: number): number {
  const frac = blackCount / total;
  if (frac < MIN_INSET || frac > MAX_INSET) return 0;
  return frac;
}

/** 扫描一帧 RGBA 像素，返回四边黑边占比。 */
export function detectBlackBars(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): Insets {
  let top = 0;
  while (top < h && rowIsBlack(data, w, top)) top++;
  let bottom = 0;
  while (bottom < h && rowIsBlack(data, w, h - 1 - bottom)) bottom++;
  let left = 0;
  while (left < w && colIsBlack(data, w, h, left)) left++;
  let right = 0;
  while (right < w && colIsBlack(data, w, h, w - 1 - right)) right++;

  return {
    top: toInset(top, h),
    bottom: toInset(bottom, h),
    left: toInset(left, w),
    right: toInset(right, w),
  };
}

export interface Box {
  width: number;
  height: number;
}

/**
 * 把裁剪矩形换算成 `<video>` 的绝对定位样式：放大并负偏移，使内容区正好铺满
 * 尺寸为 stageBox 的 `overflow:hidden` 包裹层，黑边被推出视野。
 * 无裁剪时即 width=stageBox.width、height=stageBox.height、零偏移（等价原渲染）。
 * width/height 比值恒等于原视频固有比例，故纯裁剪、零拉伸。
 */
export function cropStyle(stageBox: Box, crop: Insets): CSSProperties {
  const denomW = 1 - crop.left - crop.right;
  const denomH = 1 - crop.top - crop.bottom;
  const width = stageBox.width / denomW;
  const height = stageBox.height / denomH;
  return {
    position: "absolute",
    left: -width * crop.left || 0,
    top: -height * crop.top || 0,
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
