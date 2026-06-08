import { create } from "zustand";

export type ThemePref = "light" | "dark" | "auto";
export type EffectiveTheme = "light" | "dark";
export type AccentKey =
  | "multi"
  | "blue"
  | "purple"
  | "pink"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "gray";

const THEME_KEY = "course-ai-theme";
const ACCENT_KEY = "course-ai-accent";

/** 强调色：accent 为基色、press 深一档；text/weak 用 color-mix 随明暗派生。
 *  multi = 系统「多色」，等同默认蓝，选它时清除覆盖、回到 globals.css 的定义。 */
export const ACCENTS: { key: AccentKey; label: string; accent: string; press: string }[] = [
  { key: "multi", label: "多色", accent: "#2f6cea", press: "#255cd0" },
  { key: "blue", label: "蓝", accent: "#2f6cea", press: "#255cd0" },
  { key: "purple", label: "紫", accent: "#8a4bdb", press: "#763bc4" },
  { key: "pink", label: "粉", accent: "#e0568f", press: "#c8447b" },
  { key: "red", label: "红", accent: "#e0483d", press: "#c63a31" },
  { key: "orange", label: "橙", accent: "#e8851f", press: "#cf7314" },
  { key: "yellow", label: "黄", accent: "#d99e12", press: "#c08a0d" },
  { key: "green", label: "绿", accent: "#34a853", press: "#2c9247" },
  { key: "gray", label: "灰", accent: "#8a8f99", press: "#767b85" },
];

function systemDark(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

function resolveEffective(pref: ThemePref): EffectiveTheme {
  if (pref === "auto") return systemDark() ? "dark" : "light";
  return pref;
}

function readPref(): ThemePref {
  if (typeof window === "undefined") return "light";
  const value = window.localStorage.getItem(THEME_KEY);
  return value === "dark" || value === "auto" ? value : "light";
}

function readAccent(): AccentKey {
  if (typeof window === "undefined") return "multi";
  const value = window.localStorage.getItem(ACCENT_KEY);
  return ACCENTS.some((a) => a.key === value) ? (value as AccentKey) : "multi";
}

const ACCENT_VARS = [
  "--accent",
  "--accent-press",
  "--accent-text",
  "--accent-weak",
  "--accent-weak-2",
];

/** 把选中的强调色写到 :root 的 CSS 变量上（随明暗派生 text/weak）。 */
function applyAccent(accentKey: AccentKey, effective: EffectiveTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const entry = ACCENTS.find((a) => a.key === accentKey);
  if (!entry || accentKey === "multi") {
    for (const name of ACCENT_VARS) root.style.removeProperty(name);
    return;
  }
  const { accent, press } = entry;
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--accent-press", press);
  root.style.setProperty(
    "--accent-text",
    effective === "dark"
      ? `color-mix(in srgb, ${accent} 62%, white)`
      : `color-mix(in srgb, ${accent} 86%, black)`,
  );
  root.style.setProperty("--accent-weak", `color-mix(in srgb, ${accent} 14%, transparent)`);
  root.style.setProperty("--accent-weak-2", `color-mix(in srgb, ${accent} 24%, transparent)`);
}

interface ThemeState {
  pref: ThemePref;
  /** 实际生效的明暗（auto 解析后的结果），渲染到 .ca-app 的 data-theme。 */
  effective: EffectiveTheme;
  accent: AccentKey;
  setPref: (pref: ThemePref) => void;
  setAccent: (accent: AccentKey) => void;
  /** 快捷在浅/深之间切换（点顶部那颗按钮用）。 */
  toggle: () => void;
  /** 从 localStorage 重新读取并应用（应用启动 / Home 挂载时各调一次）。 */
  sync: () => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  pref: readPref(),
  effective: resolveEffective(readPref()),
  accent: readAccent(),
  setPref: (pref) => {
    if (typeof window !== "undefined") window.localStorage.setItem(THEME_KEY, pref);
    const effective = resolveEffective(pref);
    applyAccent(get().accent, effective);
    set({ pref, effective });
  },
  setAccent: (accent) => {
    if (typeof window !== "undefined") window.localStorage.setItem(ACCENT_KEY, accent);
    applyAccent(accent, get().effective);
    set({ accent });
  },
  toggle: () => {
    get().setPref(get().effective === "light" ? "dark" : "light");
  },
  sync: () => {
    const pref = readPref();
    const accent = readAccent();
    const effective = resolveEffective(pref);
    applyAccent(accent, effective);
    set({ pref, effective, accent });
  },
}));

// 跟随系统：仅在 pref=auto 时，系统明暗变化要实时反映到界面。
if (typeof window !== "undefined" && window.matchMedia) {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener?.("change", () => {
      const { pref, accent } = useTheme.getState();
      if (pref !== "auto") return;
      const effective = resolveEffective("auto");
      applyAccent(accent, effective);
      useTheme.setState({ effective });
    });
}

// 首屏即把已保存的强调色应用上（data-theme 由 Home 渲染到 .ca-app）。
applyAccent(readAccent(), resolveEffective(readPref()));
