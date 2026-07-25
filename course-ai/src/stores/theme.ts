import { flushSync } from "react-dom";
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

let themeAnimTimer: ReturnType<typeof setTimeout> | undefined;

export type ThemeToggleOrigin = { x: number; y: number };

let activeCircleReveal: HTMLElement | null = null;

/** 有可见的大 DOM(标了 data-theme-heavy,如打开的文稿)在场时瞬切:任何动画方案在
 *  数千节点上都会放大成本(VT 双全屏快照 / 全树逐元素过渡)。轻场景才保留渐变。
 *  引擎无 checkVisibility 时按「存在即算」保守处理(宁可瞬切不冒卡顿风险)。 */
function hasVisibleHeavyDom(): boolean {
  for (const el of document.querySelectorAll<HTMLElement>("[data-theme-heavy]")) {
    if (typeof el.checkVisibility !== "function" || el.checkVisibility()) return true;
  }
  return false;
}

const CIRCLE_MS = 420;
const CIRCLE_FADE_MS = 120;
const CIRCLE_SIZE = 48;

function endRadiusFor(origin: ThemeToggleOrigin): number {
  const { x, y } = origin;
  // 多留 2px，消除高 DPI 屏幕在最远角可能出现的一线底色。
  return (
    Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    ) + 2
  );
}

function hasActiveCircleReveal(): boolean {
  if (activeCircleReveal?.isConnected) return true;
  activeCircleReveal = null;
  return false;
}

/** 从按钮中心扩散到整个视口的目标主题底色。
 *
 * 这个路径不依赖 View Transitions：大文稿页仍只合成一层小圆的 transform，不需要
 * 旧/新整页快照；也避免不同 WebView 对 ::view-transition-* 的支持差异。 */
function circleRevealWithOverlay(
  mutate: () => void,
  next: EffectiveTheme,
  origin: ThemeToggleOrigin,
): void {
  if (hasActiveCircleReveal()) return;

  const { x, y } = origin;
  const radius = Math.ceil(endRadiusFor(origin));
  const overlay = document.createElement("div");
  overlay.setAttribute("aria-hidden", "true");
  overlay.dataset.themeCircleReveal = "";
  // 利用 [data-theme] 自身的 CSS 变量取目标底色，避免复制 --surface-app 的常量。
  overlay.dataset.theme = next;
  overlay.className = "theme-circle-reveal";
  overlay.style.setProperty("--theme-circle-x", `${x}px`);
  overlay.style.setProperty("--theme-circle-y", `${y}px`);
  overlay.style.setProperty("--theme-circle-scale", String(radius / (CIRCLE_SIZE / 2)));
  overlay.style.setProperty("--theme-circle-duration", `${CIRCLE_MS}ms`);

  // 只渲染一个 48px 图层并放大 transform，避免大圆 + 模糊光晕产生巨大的栅格化图层。
  const host = document.body ?? document.documentElement;
  host.appendChild(overlay);
  activeCircleReveal = overlay;

  let covered = false;
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    overlay.remove();
    if (activeCircleReveal === overlay) activeCircleReveal = null;
  };
  const finish = () => {
    if (covered) return;
    covered = true;
    document.documentElement.dataset.theme = next;
    flushSync(mutate);
    overlay.classList.add("is-complete");
    window.setTimeout(remove, CIRCLE_FADE_MS + 80);
  };

  overlay.addEventListener("animationend", (event: AnimationEvent) => {
    if (event.target !== overlay) return;
    if (event.animationName === "ca-theme-circle-reveal") finish();
    if (event.animationName === "ca-theme-circle-reveal-fade") remove();
  });
  window.setTimeout(finish, CIRCLE_MS + 80);
}

/** 应用明暗切换(mutate 里做真正的状态变更),按能力与场景选动画:
 *  1. 减少动态效果：瞬切；
 *  2. 有起点（用户点击）：用合成层圆形盖满整屏后切色，文稿等大 DOM 也不取整页快照；
 *  3. 无起点 + 可见重 DOM：瞬切；
 *  4. 其余：View Transitions 交叉淡化，或全树过渡类兜底。 */
function applyThemeChange(
  mutate: () => void,
  next: EffectiveTheme,
  origin?: ThemeToggleOrigin,
): void {
  if (typeof document === "undefined") return mutate();
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return mutate();
  if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
    circleRevealWithOverlay(mutate, next, origin);
    return;
  }
  if (hasVisibleHeavyDom()) return mutate();
  if (typeof document.startViewTransition === "function") {
    // flushSync:让 React 在快照回调内同步提交 data-theme,否则新快照可能截到旧画面。
    document.startViewTransition(() => flushSync(mutate));
    return;
  }
  const root = document.documentElement;
  root.classList.add("theme-animating");
  if (themeAnimTimer) clearTimeout(themeAnimTimer);
  themeAnimTimer = setTimeout(() => root.classList.remove("theme-animating"), 360);
  mutate();
}

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
  /** 快捷在浅/深之间切换；可传入点击坐标作为圆形扩散起点。 */
  toggle: (origin?: { x: number; y: number }) => void;
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
    const next = resolveEffective(pref);
    // 实际明暗变了才播放过渡（如 light→auto 但系统也是 light，则无需动画）。
    if (next !== get().effective) applyThemeChange(() => set({ pref, effective: next }), next);
    else set({ pref, effective: next });
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
  toggle: (origin) => {
    // 圆扩散尚未落幕时忽略重复点击，避免两层遮罩和过期清理回调相互干扰。
    if (hasActiveCircleReveal()) return;
    const pref = get().effective === "light" ? "dark" : "light";
    if (typeof window !== "undefined") window.localStorage.setItem(THEME_KEY, pref);
    const next = resolveEffective(pref);
    applyThemeChange(() => set({ pref, effective: next }), next, origin);
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
      const next = resolveEffective("auto");
      if (next === useTheme.getState().effective) return;
      applyThemeChange(() => useTheme.setState({ effective: next }), next);
    });
}
