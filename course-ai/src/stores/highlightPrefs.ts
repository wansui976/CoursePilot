import { create } from "zustand";
import type { HighlightMode, HighlightStrength } from "@/lib/highlights";

/**
 * 精华压缩版的偏好：档位与力度是全局的（换视频沿用），「这段有用」按视频记。
 * 存 localStorage，跟倍速、跳停顿一样是本机偏好，不进同步。
 */
const KEY = "course-ai-highlights";
const MAX_KEPT_VIDEOS = 200;

interface Persisted {
  mode: HighlightMode;
  strength: HighlightStrength;
  kept: Record<string, number[]>;
}

function read(): Persisted {
  const fallback: Persisted = { mode: "off", strength: 2, kept: {} };
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Persisted> | null;
    if (!value || typeof value !== "object") return fallback;
    return {
      mode: value.mode === "fast" || value.mode === "skip" ? value.mode : "off",
      strength: value.strength === 1 || value.strength === 3 ? value.strength : 2,
      kept: value.kept && typeof value.kept === "object" ? value.kept : {},
    };
  } catch {
    return fallback;
  }
}

function write(state: Persisted) {
  try {
    const ids = Object.keys(state.kept);
    const kept =
      ids.length > MAX_KEPT_VIDEOS
        ? Object.fromEntries(ids.slice(-MAX_KEPT_VIDEOS).map((id) => [id, state.kept[id]]))
        : state.kept;
    localStorage.setItem(KEY, JSON.stringify({ ...state, kept }));
  } catch {
    // 存不下只是下次启动回到默认。
  }
}

interface HighlightPrefsState extends Persisted {
  setMode: (mode: HighlightMode) => void;
  setStrength: (strength: HighlightStrength) => void;
  /** 「这段有用」：之后不再快放 / 跳过这一段。 */
  keep: (videoId: string, startMs: number) => void;
}

export const useHighlightPrefs = create<HighlightPrefsState>((set, get) => {
  const persist = (patch: Partial<Persisted>) => {
    const { mode, strength, kept } = { ...get(), ...patch };
    write({ mode, strength, kept });
    set(patch);
  };
  return {
    ...read(),
    setMode: (mode) => persist({ mode }),
    setStrength: (strength) => persist({ strength }),
    keep: (videoId, startMs) => {
      const current = get().kept[videoId] ?? [];
      if (current.includes(startMs)) return;
      persist({ kept: { ...get().kept, [videoId]: [...current, startMs] } });
    },
  };
});
