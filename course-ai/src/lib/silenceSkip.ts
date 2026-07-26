/** 跳停顿：播放时跃过老师写板书、等学生记笔记这类长时间无声的空档。
 *
 * 后端已经把「哪些静音真的能跳」算好了（画面同时在变的那截不跳），这里只负责
 * 「播到了就跳」以及开关的记忆。判定是纯函数，方便单测。 */

export type SkipRange = { start_ms: number; end_ms: number };

const ENABLED_KEY = "skip-silence";

/** 默认关：跳过是会改变观看内容的行为，得由用户主动打开。 */
export function isSkipSilenceEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "on";
  } catch {
    return false;
  }
}

export function setSkipSilenceEnabled(enabled: boolean) {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? "on" : "off");
  } catch {
    // 隐私模式下写不了 localStorage，本次会话内照常工作即可。
  }
}

/** 播放到 positionMs 时该跳到哪；不在任何区间内返回 null。 */
export function skipTargetMs(ranges: SkipRange[], positionMs: number): number | null {
  const hit = ranges.find(
    (range) => positionMs >= range.start_ms && positionMs < range.end_ms,
  );
  return hit ? hit.end_ms : null;
}

/** 跳过后的提示文案。用户得知道刚才画面为什么突然前进了。 */
export function formatSkipNotice(fromMs: number, toMs: number): string {
  const seconds = Math.max(1, Math.round((toMs - fromMs) / 1000));
  return `跳过 ${seconds} 秒静音`;
}

/** 试跳时落在停顿前多久。留一点余量，好看清「说着说着——啪，跳过去了」。 */
export const PREVIEW_LEAD_MS = 1_500;

function previewMs(range: SkipRange): number {
  return Math.max(0, range.start_ms - PREVIEW_LEAD_MS);
}

/**
 * 「下一处停顿」的落点：第一处落点还在当前位置之后的停顿。
 *
 * 用落点（而不是停顿起点）来比，是为了让连按有效——按一次正好停在落点上，
 * 再按一次就该去下一处，而不是原地不动。
 */
export function nextSkipPreviewMs(ranges: SkipRange[], positionMs: number): number | null {
  const hit = ranges.find((range) => previewMs(range) > positionMs);
  return hit ? previewMs(hit) : null;
}

/** 「上一处停顿」的落点：最后一处落点还在当前位置之前的停顿。 */
export function prevSkipPreviewMs(ranges: SkipRange[], positionMs: number): number | null {
  const hits = ranges.filter((range) => previewMs(range) < positionMs);
  const hit = hits[hits.length - 1];
  return hit ? previewMs(hit) : null;
}
