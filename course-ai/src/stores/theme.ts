import { create } from "zustand";

export type ThemePref = "light" | "dark" | "auto";
export type EffectiveTheme = "light" | "dark";
export type AccentKey =
  | "custom"
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
const CUSTOM_ACCENT_KEY = "course-ai-custom-accent";
const DEFAULT_CUSTOM_ACCENT = "#2f6cea";

/** 强调色：accent 为基色、press 深一档；text/weak 用 color-mix 随明暗派生。
 *  custom = 用户通过系统色板选择的第一颗强调色。 */
export const ACCENTS: { key: AccentKey; label: string; accent: string; press: string }[] = [
  { key: "custom", label: "多色", accent: DEFAULT_CUSTOM_ACCENT, press: "#255cd0" },
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
  if (typeof window === "undefined") return "custom";
  const value = window.localStorage.getItem(ACCENT_KEY);
  return ACCENTS.some((a) => a.key === value) ? (value as AccentKey) : "custom";
}

function isHexColor(value: string | null): value is string {
  return !!value && /^#[0-9a-fA-F]{6}$/.test(value);
}

function normalizeHexColor(value: string): string {
  return value.toLowerCase();
}

function readCustomAccent(): string {
  if (typeof window === "undefined") return DEFAULT_CUSTOM_ACCENT;
  const value = window.localStorage.getItem(CUSTOM_ACCENT_KEY);
  return isHexColor(value) ? normalizeHexColor(value) : DEFAULT_CUSTOM_ACCENT;
}

/** 选中强调色对应的 CSS 变量(随明暗派生 text/weak)。
 *  注意：.ca-app 在 CSS 里本地重定义了 --accent，所以必须把这些变量作为内联
 *  style 写在 .ca-app 元素上(内联优先级最高)才能覆盖，写到 :root 会被它遮蔽。 */
export function accentVars(
  accent: AccentKey,
  effective: EffectiveTheme,
  customAccent = readCustomAccent(),
): Record<string, string> {
  const entry = ACCENTS.find((a) => a.key === accent);
  if (!entry) return {};
  const base = accent === "custom" ? customAccent : entry.accent;
  const press =
    accent === "custom" ? `color-mix(in srgb, ${base} 88%, black)` : entry.press;
  return {
    "--accent": base,
    "--accent-press": press,
    "--accent-text":
      effective === "dark"
        ? `color-mix(in srgb, ${base} 62%, white)`
        : `color-mix(in srgb, ${base} 86%, black)`,
    "--accent-weak": `color-mix(in srgb, ${base} 14%, transparent)`,
    "--accent-weak-2": `color-mix(in srgb, ${base} 24%, transparent)`,
    // Tailwind 的 primary 系列(bg-primary/text-primary/accent-primary 等)走这个
    // @theme 令牌,一并联动,让用 primary 的元素也跟随强调色。
    "--color-primary": base,
  };
}

interface ThemeState {
  pref: ThemePref;
  /** 实际生效的明暗（auto 解析后的结果），渲染到 .ca-app 的 data-theme。 */
  effective: EffectiveTheme;
  accent: AccentKey;
  customAccent: string;
  setPref: (pref: ThemePref) => void;
  setAccent: (accent: AccentKey) => void;
  setCustomAccent: (accent: string) => void;
  /** 快捷在浅/深之间切换（点顶部那颗按钮用）。 */
  toggle: () => void;
  /** 从 localStorage 重新读取并应用（应用启动 / Home 挂载时各调一次）。 */
  sync: () => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  pref: readPref(),
  effective: resolveEffective(readPref()),
  accent: readAccent(),
  customAccent: readCustomAccent(),
  setPref: (pref) => {
    if (typeof window !== "undefined") window.localStorage.setItem(THEME_KEY, pref);
    set({ pref, effective: resolveEffective(pref) });
  },
  setAccent: (accent) => {
    if (typeof window !== "undefined") window.localStorage.setItem(ACCENT_KEY, accent);
    set({ accent });
  },
  setCustomAccent: (accent) => {
    if (!isHexColor(accent)) return;
    const customAccent = normalizeHexColor(accent);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(CUSTOM_ACCENT_KEY, customAccent);
      window.localStorage.setItem(ACCENT_KEY, "custom");
    }
    set({ accent: "custom", customAccent });
  },
  toggle: () => {
    get().setPref(get().effective === "light" ? "dark" : "light");
  },
  sync: () => {
    const pref = readPref();
    set({
      pref,
      accent: readAccent(),
      customAccent: readCustomAccent(),
      effective: resolveEffective(pref),
    });
  },
}));

// 跟随系统：仅在 pref=auto 时，系统明暗变化要实时反映到界面。
if (typeof window !== "undefined" && window.matchMedia) {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener?.("change", () => {
      if (useTheme.getState().pref !== "auto") return;
      useTheme.setState({ effective: resolveEffective("auto") });
    });
}
