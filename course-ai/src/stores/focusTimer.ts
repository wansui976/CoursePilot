import { create } from "zustand";

/**
 * 番茄钟：专注 N 分钟 → 休息 M 分钟。结束时刻按墙钟存（`endsAt`），写进本地：
 * 刷新页面、切到别的视图都接着倒数。只记本机，不同步——在哪台设备上专注就在哪台计时。
 *
 * 今天完成了几个专注段也记在本地（按本地日期），学习面板和侧栏里显示。
 */
export type FocusPhase = "idle" | "focus" | "break";

export const FOCUS_MINUTES = [15, 25, 45, 60] as const;
export const BREAK_MINUTES = [5, 10, 15] as const;

const STATE_KEY = "course-ai-focus-timer";
const PREFS_KEY = "course-ai-focus-prefs";
const DONE_KEY = "course-ai-focus-done";

interface Persisted {
  phase: FocusPhase;
  endsAt: number;
}

interface Prefs {
  focusMinutes: number;
  breakMinutes: number;
  /** 专注结束后自动开始休息。 */
  autoBreak: boolean;
}

interface DoneLog {
  day: string;
  count: number;
  minutes: number;
}

const DEFAULT_PREFS: Prefs = { focusMinutes: 25, breakMinutes: 5, autoBreak: true };

export function localDay(now = Date.now()) {
  const date = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存不下就只在这次运行里有效。
  }
}

function loadPrefs(): Prefs {
  const saved = typeof window === "undefined" ? null : readJson<Partial<Prefs>>(PREFS_KEY);
  const focus = Number(saved?.focusMinutes);
  const rest = Number(saved?.breakMinutes);
  return {
    focusMinutes: Number.isFinite(focus) && focus >= 1 && focus <= 180 ? focus : DEFAULT_PREFS.focusMinutes,
    breakMinutes: Number.isFinite(rest) && rest >= 1 && rest <= 60 ? rest : DEFAULT_PREFS.breakMinutes,
    autoBreak: saved?.autoBreak !== false,
  };
}

function loadState(): Persisted {
  const saved = typeof window === "undefined" ? null : readJson<Persisted>(STATE_KEY);
  if (!saved || (saved.phase !== "focus" && saved.phase !== "break") || !Number.isFinite(saved.endsAt)) {
    return { phase: "idle", endsAt: 0 };
  }
  return saved;
}

function loadDone(now = Date.now()): DoneLog {
  const saved = typeof window === "undefined" ? null : readJson<DoneLog>(DONE_KEY);
  const today = localDay(now);
  if (!saved || saved.day !== today) return { day: today, count: 0, minutes: 0 };
  return { day: today, count: Number(saved.count) || 0, minutes: Number(saved.minutes) || 0 };
}

/** 一段结束时刚发生了什么：界面据此提示（发通知、响一声）。 */
export type FocusTransition = { from: FocusPhase; to: FocusPhase; at: number; nonce: number };

interface FocusTimerState extends Prefs {
  phase: FocusPhase;
  endsAt: number;
  doneToday: DoneLog;
  lastTransition: FocusTransition | null;
  start: (now?: number) => void;
  startBreak: (now?: number) => void;
  stop: () => void;
  /** 每秒调一次：到点就进入下一段。返回是否换了段。 */
  tick: (now?: number) => boolean;
  setPrefs: (prefs: Partial<Prefs>) => void;
}

export const useFocusTimer = create<FocusTimerState>((set, get) => {
  const persist = (phase: FocusPhase, endsAt: number) =>
    writeJson(STATE_KEY, phase === "idle" ? null : { phase, endsAt });
  return {
    ...loadPrefs(),
    ...loadState(),
    doneToday: loadDone(),
    lastTransition: null,
    start: (now = Date.now()) => {
      const endsAt = now + get().focusMinutes * 60_000;
      persist("focus", endsAt);
      set({ phase: "focus", endsAt });
    },
    startBreak: (now = Date.now()) => {
      const endsAt = now + get().breakMinutes * 60_000;
      persist("break", endsAt);
      set({ phase: "break", endsAt });
    },
    stop: () => {
      persist("idle", 0);
      set({ phase: "idle", endsAt: 0 });
    },
    tick: (now = Date.now()) => {
      const state = get();
      if (state.phase === "idle" || now < state.endsAt) return false;
      const nonce = (state.lastTransition?.nonce ?? 0) + 1;
      if (state.phase === "focus") {
        const done = loadDone(now);
        const next: DoneLog = {
          day: done.day,
          count: done.count + 1,
          minutes: done.minutes + state.focusMinutes,
        };
        writeJson(DONE_KEY, next);
        // 过点很久才回来（电脑睡了一晚）：不再补一段休息，直接停下。
        const stale = now - state.endsAt > state.breakMinutes * 60_000;
        if (state.autoBreak && !stale) {
          const endsAt = state.endsAt + state.breakMinutes * 60_000;
          persist("break", endsAt);
          set({
            phase: "break",
            endsAt,
            doneToday: next,
            lastTransition: { from: "focus", to: "break", at: now, nonce },
          });
        } else {
          persist("idle", 0);
          set({
            phase: "idle",
            endsAt: 0,
            doneToday: next,
            lastTransition: { from: "focus", to: "idle", at: now, nonce },
          });
        }
        return true;
      }
      persist("idle", 0);
      set({
        phase: "idle",
        endsAt: 0,
        doneToday: loadDone(now),
        lastTransition: { from: "break", to: "idle", at: now, nonce },
      });
      return true;
    },
    setPrefs: (prefs) => {
      const next = { ...loadPrefs(), ...prefs };
      writeJson(PREFS_KEY, next);
      set(next);
    },
  };
});

/** 还剩多少毫秒；没在计时返回 0。 */
export function focusRemainingMs(state: { phase: FocusPhase; endsAt: number }, now = Date.now()) {
  return state.phase === "idle" ? 0 : Math.max(0, state.endsAt - now);
}
