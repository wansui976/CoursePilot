import { isMobile } from "@/lib/platform";

/**
 * 播放器音量：桌面能放大到 200%（网课录音常常很小声，系统音量开满也听不清），
 * 每门课记住自己的音量（不同老师的录音响度差很多，换课不用再去调系统音量）。
 *
 * <video>.volume 最多只有 1。超过 100% 时把声音接进 Web Audio：元素音量开满，
 * 再由 GainNode 放大，后面跟一个限幅器，放大后的峰值不至于削波刺耳。
 * 只在桌面、并且第一次调到 100% 以上时才接——接进去之后这个元素的声音就一直走
 * Web Audio（同一个元素只能接一次），没必要的话不去动它。手机不接：手机有实体音量键，
 * 而且走 Web Audio 会影响锁屏 / 后台播放。
 *
 * 实测（Chrome 与 Playwright WebKit，媒体在另一个端口、带 CORS 头）：放大 1 / 1.5 / 2 倍
 * 的输出电平都是原来的 1 / 1.5 / 2 倍；不带 crossOrigin 加载的接进去是静音（所以 boostFor
 * 先看 crossOrigin）。WebKit 在播放途中接入时约有 0.25 秒没声音，之后一直正常——只在
 * 第一次调过 100% 的那一下。
 */

const STORAGE_PREFIX = "course-ai-volume:";

export function maxVolume(): number {
  return isMobile() ? 1 : 2;
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
  return !isMobile() && /^http:\/\/127\.0\.0\.1:\d+\//.test(src);
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
