import { isIOS } from "@/lib/platform";

/** 播放器的本地偏好（倍速、弹幕开关）与运行环境判断。 */

/** macOS WKWebView / iOS 的 AVFoundation 超过 2x 只渲染关键帧，倍速一律封顶在这里。 */
export const APPLE_MAX_PLAYBACK_RATE = 2;

const PLAYBACK_RATE_KEY = "course-ai-playback-rate";
const DANMAKU_ENABLED_KEY = "course-ai-danmaku-enabled";
const SUPPORTED_PLAYBACK_RATES = new Set([0.5, 0.75, 1, 1.25, 1.5, 2]);

export function loadPlaybackRate() {
  try {
    const stored = Number(localStorage.getItem(PLAYBACK_RATE_KEY));
    return SUPPORTED_PLAYBACK_RATES.has(stored) ? stored : 1;
  } catch {
    return 1;
  }
}

export function persistPlaybackRate(rate: number) {
  try {
    localStorage.setItem(PLAYBACK_RATE_KEY, String(rate));
  } catch {
    // 隐私模式无法持久化时，本次播放器会话内仍然生效。
  }
}

// 弹幕开关：全局偏好（跨视频记住），默认开。
export function loadDanmakuEnabled() {
  try {
    return localStorage.getItem(DANMAKU_ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function persistDanmakuEnabled(enabled: boolean) {
  try {
    localStorage.setItem(DANMAKU_ENABLED_KEY, enabled ? "1" : "0");
  } catch {
    // 同上：持久化失败不挡本次会话。
  }
}

export function usesApplePlaybackEngine() {
  if (isIOS()) return true;
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  return (
    /Macintosh|Mac OS X/i.test(ua) &&
    /AppleWebKit/i.test(ua) &&
    !/Chrome|Chromium|Edg|OPR/i.test(ua)
  );
}

// 不是输入框的 <input>：进度条、音量条、复选框。点过进度条后焦点留在它上面，原先一律当成
// 「正在打字」，空格就再也暂停不了。
const NON_TEXT_INPUTS = new Set(["range", "checkbox", "radio", "button", "submit", "reset", "color", "file"]);
// 滑块自己就响应方向键 / Home / End，这几个键留给它，不再额外快进快退一次。
const SLIDER_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** 这次按键归焦点所在的控件处理（正在输入文字，或滑块的方向键），播放器快捷键不接。 */
export function keyBelongsToTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  if (target.tagName === "TEXTAREA" || target.isContentEditable) return true;
  if (target.tagName === "SELECT") return true;
  if (target.tagName !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  if (!NON_TEXT_INPUTS.has(type)) return true;
  return type === "range" && SLIDER_KEYS.has(event.key);
}

export type GestureHint = {
  kind: "brightness" | "volume" | "scrub" | "rate" | "rewind";
  value: number;
};
