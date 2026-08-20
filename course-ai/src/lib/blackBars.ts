import type { CSSProperties } from "react";

/** 四边黑边占比（0~1）。 */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** 后端 `cmd_ensure_crop` 的返回：`insets` 有值 = 已探测过（无黑边为全 0）；
 *  `detecting` = 后台正在测，前端该轮询等结果。 */
export interface CropStatus {
  insets: Insets | null;
  detecting: boolean;
}

/** 低于这个比例的黑边当作编码/暗色边缘噪声，不值得裁。 */
const MIN_EDGE_INSET = 0.02;
/** 两侧相差超过这么多个百分点，就不是一条对称黑边（一侧多半是暗色误判）。 */
const MAX_EDGE_GAP = 0.03;

/** 一侧的裁剪量：两侧差得离谱时视为一侧误判，整轴都不裁。 */
function sideValue(a: number, b: number): number {
  if (Math.abs(a - b) > MAX_EDGE_GAP) return 0;
  return a < MIN_EDGE_INSET ? 0 : a;
}

/**
 * 把探测到的四边收敛成真正安全的裁剪量。
 *
 * **每侧按自己探测到的值独立裁剪**。真实片源的左右黑边宽度往往略有差别，
 * 原来对边取较小值会让宽的那侧留下一条缝——表现为「只裁掉了一边」。
 * 现在各自裁各自的，两边都能完整去掉，裁剪只把画面往宽侧推一点点（差 ≤3%，
 * 最多 1.5%，肉眼不可见）。
 *
 * 两侧差得离谱时（> MAX_EDGE_GAP）仍整轴不裁：那是「单边真黑边 + 另一侧暗色
 * 误判」，照单全收会把暗色内容当黑边削掉。各侧不足 MIN_EDGE_INSET 的按噪声忽略。
 */
export function resolveCrop(crop: Insets): Insets {
  return {
    top: sideValue(crop.top, crop.bottom),
    right: sideValue(crop.right, crop.left),
    bottom: sideValue(crop.bottom, crop.top),
    left: sideValue(crop.left, crop.right),
  };
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
