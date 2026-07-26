import type { CSSProperties } from "react";

/** 四边黑边占比（0~1）。 */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** 低于这个比例的黑边当作编码/暗色边缘噪声，不值得裁。 */
const MIN_EDGE_INSET = 0.02;
/** 两侧相差超过这么多个百分点，就不是一条对称黑边。 */
const MAX_EDGE_GAP = 0.03;

/**
 * 一条轴上真正该裁掉的量。
 *
 * 真实信箱/邮筒黑边本就对称，所以对边取较小值，裁剪永远居中，不会把画面推歪。
 * 但只取 min 不够，还有两种会**吃掉真实画面**的情况：
 *
 * - 两侧差得离谱（如左 2%、右 20%）：这不是对称黑边，而是「单边黑边 + 另一侧的
 *   暗色误判」。取 min 会照着那 2% 去裁——右边那条真黑边一点没少，左边却把画面
 *   削掉一条。整轴不裁才对。
 * - 两侧都只有一丁点（1% 上下）：多半是编码边缘抖动，裁了没收益，只会损失画面。
 */
function axisInset(a: number, b: number): number {
  if (Math.abs(a - b) > MAX_EDGE_GAP) return 0;
  const value = Math.min(a, b);
  return value < MIN_EDGE_INSET ? 0 : value;
}

/** 把探测到的四边收敛成真正安全的裁剪量（见 [`axisInset`]）。 */
export function symmetricInsets(crop: Insets): Insets {
  const lr = axisInset(crop.left, crop.right);
  const tb = axisInset(crop.top, crop.bottom);
  return { top: tb, right: lr, bottom: tb, left: lr };
}

const CROP_KEY = "crop-black-bars";

/**
 * 是否自动去黑边。默认开——绝大多数带黑边的录像去掉更好看。
 *
 * 之所以留这个开关：去黑边是**猜**出来的（cropdetect 按画面亮度估边界），猜错时
 * 画面会显得被裁掉一块或没对齐。关掉就是原封不动的画面，一眼就能分清「是源片
 * 本来如此」还是「我们裁歪了」。
 */
export function isCropEnabled(): boolean {
  try {
    return localStorage.getItem(CROP_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setCropEnabled(enabled: boolean) {
  try {
    localStorage.setItem(CROP_KEY, enabled ? "on" : "off");
  } catch {
    // 隐私模式下写不了 localStorage，本次会话内照常工作即可。
  }
}

/** 把四边占比写成人能读的百分比，供开关的悬浮说明用（排查裁歪时要看的就是这四个数）。 */
export function formatInsets(crop: Insets): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  return `上 ${pct(crop.top)} / 右 ${pct(crop.right)} / 下 ${pct(crop.bottom)} / 左 ${pct(crop.left)}`;
}

/**
 * 切换去黑边时打在画面上的说明。
 *
 * 光靠悬浮提示看不到——控制栏会自动淡出，原生 tooltip 要悬停一秒才出来。排查裁歪
 * 得同时看两组数：探测到的原始四边，和对称化之后**实际用**的四边。两者不一致就说明
 * 是单边误判被抹平了。
 */
export function formatCropNotice(detected: Insets, enabled: boolean): string {
  if (!enabled) return `已关闭去黑边（探测值 ${formatInsets(detected)}）`;
  const effective = symmetricInsets(detected);
  const same =
    effective.top === detected.top &&
    effective.right === detected.right &&
    effective.bottom === detected.bottom &&
    effective.left === detected.left;
  const detail = same
    ? formatInsets(detected)
    : `${formatInsets(detected)} → 实际用 ${formatInsets(effective)}`;
  return `已开启去黑边：${detail}`;
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
