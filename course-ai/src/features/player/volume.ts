import { isMobile } from "@/lib/platform";
import { isMacWebKit } from "./playerPrefs";

/**
 * 播放器音量：Windows 上能放大到 200%（网课录音常常很小声，系统音量开满也听不清），
 * 每门课记住自己的音量（不同老师的录音响度差很多，换课不用再去调系统音量）。
 *
 * <video>.volume 最多只有 1。超过 100% 时把声音接进 Web Audio：元素音量开满，
 * 再由 GainNode 放大，后面跟一个限幅器，放大后的峰值不至于削波刺耳。
 * 只在第一次调到 100% 以上时才接——接进去之后这个元素的声音就一直走
 * Web Audio（同一个元素只能接一次），没必要的话不去动它。
 *
 * 只在 Windows（WebView2 / Chromium）上放大，Mac 和手机最多 100%：
 * - Mac 的 WKWebView 把元素接进 Web Audio 之后，只要不是 1 倍速，输出大约每秒断 3 毫秒
 *   （实测 2x：30 秒里 29 次，1x 只有零星几次），听起来就是倍速时一卡一卡、吞字。
 *   接上就拆不掉，调回 100% 也照样卡，所以干脆不接。
 * - 手机有实体音量键，而且走 Web Audio 会影响锁屏 / 后台播放。
 *
 * 实测（Chrome，媒体在另一个端口、带 CORS 头）：放大 1 / 1.5 / 2 倍的输出电平都是原来的
 * 1 / 1.5 / 2 倍；不带 crossOrigin 加载的接进去是静音（所以 boostFor 先看 crossOrigin）。
 */

const STORAGE_PREFIX = "course-ai-volume:";

/** 能不能放大到 100% 以上：见文件头，只有 Windows 的 WebView2 可以。 */
function boostSupported(): boolean {
  return !isMobile() && !isMacWebKit();
}

export function maxVolume(): number {
  return boostSupported() ? 2 : 1;
}

export function clampVolume(value: number): number {
  return Math.min(maxVolume(), Math.max(0, value));
}

export function readCourseVolume(courseId: string | null | undefined): number | null {
  if (!courseId) return null;
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + courseId);
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? clampVolume(value) : null;
  } catch {
    return null;
  }
}

export function writeCourseVolume(courseId: string | null | undefined, value: number): void {
  if (!courseId) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + courseId, String(Math.round(value * 100) / 100));
  } catch {
    // 存不下（隐私模式、配额满）不影响播放。
  }
}

/** 本地媒体服务的地址：带 CORS 头，可以用 crossOrigin="anonymous" 加载、接进 Web Audio。 */
export function canBoost(src: string): boolean {
  return boostSupported() && /^http:\/\/127\.0\.0\.1:\d+\//.test(src);
}

type Boost = { context: AudioContext; gain: GainNode };
const boosts = new WeakMap<HTMLMediaElement, Boost>();

function boostFor(video: HTMLMediaElement): Boost | null {
  const existing = boosts.get(video);
  if (existing) return existing;
  // 没有以 CORS 方式加载的跨源媒体接进 Web Audio 只会输出静音，宁可不放大。
  if (video.crossOrigin !== "anonymous") return null;
  const AudioContextClass =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;
  try {
    const context = new AudioContextClass();
    const source = context.createMediaElementSource(video);
    const gain = context.createGain();
    const limiter = context.createDynamicsCompressor();
    // 只在接近满幅时才压：平时（放大 1 倍）声音原样通过。
    limiter.threshold.value = -2;
    limiter.knee.value = 4;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    source.connect(gain).connect(limiter).connect(context.destination);
    const boost = { context, gain };
    boosts.set(video, boost);
    return boost;
  } catch {
    return null;
  }
}

/**
 * 把音量（0..maxVolume）应用到元素上。超过 1 的部分交给 Web Audio 放大；
 * 接不上 Web Audio 时退回 100%。
 */
export function applyVolume(video: HTMLMediaElement, volume: number, muted: boolean): void {
  const value = clampVolume(volume);
  video.muted = muted || value === 0;
  const boost = value > 1 ? boostFor(video) : boosts.get(video);
  video.volume = Math.min(1, value);
  if (boost) {
    boost.gain.gain.value = Math.max(1, value);
    if (boost.context.state === "suspended") void boost.context.resume().catch(() => {});
  }
}

/** 这个元素现在是否在放大（元素音量是 1、实际按更大的倍数在放）。 */
export function isBoosted(video: HTMLMediaElement): boolean {
  const boost = boosts.get(video);
  return !!boost && boost.gain.gain.value > 1;
}
