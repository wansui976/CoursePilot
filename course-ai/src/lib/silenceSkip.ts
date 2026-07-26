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
