import { create } from "zustand";

/**
 * 界面声音与触感：只在几个时刻出声、只在状态变化时震动（设计系统 SoundDesign / Haptics）。
 *
 * 声音：粉笔书写、翻卡、翻页（课程牌堆）、点亮四种，现场用 Web Audio 合成（不带音频文件），
 * 默认「很轻」，可在设置 → 外观里关掉；启动后头两秒不出声。
 * 触感：手机上用 navigator.vibrate（Android WebView 支持；iOS WebView 没有这个接口，调用无效果）。
 */
export type SoundLevel = "off" | "quiet" | "normal";
export type SoundKind = "chalk" | "flip" | "page" | "stamp";
export type HapticKind = "tick" | "soft" | "stamp" | "warning" | "success";

const SOUND_KEY = "course-ai-ui-sound";
const HAPTIC_KEY = "course-ai-haptics";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 存不下就只在这次会话里生效。
  }
}

interface FeedbackPrefs {
  sound: SoundLevel;
  haptics: boolean;
  setSound: (level: SoundLevel) => void;
  setHaptics: (on: boolean) => void;
}

export const useFeedbackPrefs = create<FeedbackPrefs>((set) => ({
  sound: (() => {
    const saved = typeof window === "undefined" ? null : read(SOUND_KEY);
    return saved === "off" || saved === "normal" ? saved : "quiet";
  })(),
  haptics: typeof window === "undefined" ? true : read(HAPTIC_KEY) !== "0",
  setSound: (sound) => {
    write(SOUND_KEY, sound);
    set({ sound });
  },
  setHaptics: (haptics) => {
    write(HAPTIC_KEY, haptics ? "1" : "0");
    set({ haptics });
  },
}));

/** 启动后头两秒不出声：恢复会话时不该叮叮当当。 */
const QUIET_AFTER_LAUNCH_MS = 2000;
const launchedAt = typeof performance === "undefined" ? 0 : performance.now();

let ctx: AudioContext | null = null;
let current: { stop: () => void } | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx ??= new Ctor();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function noise(c: AudioContext, seconds: number): AudioBufferSourceNode {
  const buffer = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * seconds)), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const source = c.createBufferSource();
  source.buffer = buffer;
  return source;
}

function envelope(gain: GainNode, t0: number, points: [number, number][], scale: number) {
  gain.gain.setValueAtTime(0, t0);
  for (const [at, value] of points) gain.gain.linearRampToValueAtTime(value * scale, t0 + at);
}

/** 各种声音的合成配方。返回所有发声节点，便于下一声来时把这一声掐掉。 */
function synth(c: AudioContext, kind: SoundKind, scale: number): AudioScheduledSourceNode[] {
  const t = c.currentTime + 0.01;
  const out: AudioScheduledSourceNode[] = [];
  if (kind === "chalk") {
    for (let k = 0; k < 5; k++) {
      const s = noise(c, 0.14);
      const f = c.createBiquadFilter();
      const g = c.createGain();
      f.type = "bandpass";
      f.frequency.value = 2600 + Math.random() * 1800;
      f.Q.value = 1.4;
      s.connect(f).connect(g).connect(c.destination);
      const t0 = t + k * 0.12;
      envelope(g, t0, [[0.01, 0.09], [0.05, 0.05], [0.09, 0.08], [0.13, 0]], scale);
      s.start(t0);
      out.push(s);
    }
  } else if (kind === "flip") {
    const s = noise(c, 0.3);
    const f = c.createBiquadFilter();
    const g = c.createGain();
    f.type = "highpass";
    f.frequency.setValueAtTime(700, t);
    f.frequency.exponentialRampToValueAtTime(5000, t + 0.22);
    s.connect(f).connect(g).connect(c.destination);
    envelope(g, t, [[0.03, 0.16], [0.12, 0.06], [0.25, 0]], scale);
    s.start(t);
    out.push(s);
  } else if (kind === "page") {
    // 翻一页厚纸：先是纸面擦过的一声「唰」（带通往上扫），末尾纸落下的一下轻响。
    const swish = noise(c, 0.22);
    const band = c.createBiquadFilter();
    const g1 = c.createGain();
    band.type = "bandpass";
    band.Q.value = 0.9;
    band.frequency.setValueAtTime(900, t);
    band.frequency.exponentialRampToValueAtTime(2600, t + 0.18);
    swish.connect(band).connect(g1).connect(c.destination);
    envelope(g1, t, [[0.04, 0.12], [0.14, 0.07], [0.2, 0]], scale);
    swish.start(t);
    const tap = noise(c, 0.06);
    const low = c.createBiquadFilter();
    const g2 = c.createGain();
    low.type = "lowpass";
    low.frequency.value = 700;
    tap.connect(low).connect(g2).connect(c.destination);
    envelope(g2, t + 0.19, [[0.005, 0.18], [0.05, 0]], scale);
    tap.start(t + 0.19);
    out.push(swish, tap);
  } else {
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.12);
    o.connect(g).connect(c.destination);
    envelope(g, t, [[0.005, 0.35], [0.14, 0]], scale);
    o.start(t);
    o.stop(t + 0.16);
    out.push(o);
  }
  return out;
}

/** 播一声界面音。设置为关、刚启动、或浏览器不支持时什么都不做。 */
export function playSound(kind: SoundKind) {
  const level = useFeedbackPrefs.getState().sound;
  if (level === "off") return;
  if (typeof performance !== "undefined" && performance.now() - launchedAt < QUIET_AFTER_LAUNCH_MS) return;
  const c = audio();
  if (!c) return;
  try {
    current?.stop();
    const nodes = synth(c, kind, level === "normal" ? 1.6 : 1);
    current = {
      stop: () => {
        for (const node of nodes) {
          try {
            node.stop();
          } catch {
            // 已经停了。
          }
        }
      },
    };
  } catch {
    // 声音只是点缀，出错就算了。
  }
}

/** 各种触感的震动序列（毫秒：震、停、震……）。 */
export const HAPTIC_PATTERNS: Record<HapticKind, number[]> = {
  tick: [8],
  soft: [12],
  stamp: [24, 90, 10, 60, 10],
  warning: [12, 80, 12],
  success: [10, 100, 16],
};

/** 震一下。只在状态变化的那一刻调用，不在滚动、悬停、每一帧拖动里调用。 */
export function haptic(kind: HapticKind) {
  if (!useFeedbackPrefs.getState().haptics) return;
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(HAPTIC_PATTERNS[kind]);
  } catch {
    // 不支持就算了。
  }
}
