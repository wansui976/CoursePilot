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
export const ACCENTS: { key: AccentKey; i18nKey: string; accent: string; press: string }[] = [
  { key: "custom", i18nKey: "settings.appearance.accentCustom", accent: DEFAULT_CUSTOM_ACCENT, press: "#255cd0" },
  { key: "blue", i18nKey: "settings.appearance.accentBlue", accent: "#2f6cea", press: "#255cd0" },
  { key: "purple", i18nKey: "settings.appearance.accentPurple", accent: "#8a4bdb", press: "#763bc4" },
  { key: "pink", i18nKey: "settings.appearance.accentPink", accent: "#e0568f", press: "#c8447b" },
  { key: "red", i18nKey: "settings.appearance.accentRed", accent: "#e0483d", press: "#c63a31" },
  { key: "orange", i18nKey: "settings.appearance.accentOrange", accent: "#e8851f", press: "#cf7314" },
  { key: "yellow", i18nKey: "settings.appearance.accentYellow", accent: "#d99e12", press: "#c08a0d" },
  { key: "green", i18nKey: "settings.appearance.accentGreen", accent: "#34a853", press: "#2c9247" },
  { key: "gray", i18nKey: "settings.appearance.accentGray", accent: "#8a8f99", press: "#767b85" },
];

let themeAnimTimer: ReturnType<typeof setTimeout> | undefined;

/** 圆形揭开动画的起点（切换按钮的位置）。每次切换消费一次，避免系统自动切换复用旧坐标。 */
let pendingOrigin: { x: number; y: number } | null = null;

/** 记录下一次明暗切换的动画起点（点击切换按钮的位置），供圆形揭开使用。 */
export function setThemeToggleOrigin(x: number, y: number): void {
  pendingOrigin = { x, y };
}

function consumeThemeOrigin(): { x: number; y: number } | null {
  const origin = pendingOrigin;
  pendingOrigin = null;
  return origin;
}

/** 有可见的高成本内容(标了 data-theme-heavy,如视频或打开的文稿)在场时瞬切:任何动画方案在
 *  视频合成层或数千节点上都会放大成本(VT 双全屏快照 / 全树逐元素过渡)。轻场景才保留渐变。
 *  引擎无 checkVisibility 时按「存在即算」保守处理(宁可瞬切不冒卡顿风险)。 */
function hasVisibleHeavyDom(): boolean {
  for (const el of document.querySelectorAll<HTMLElement>("[data-theme-heavy]")) {
    if (typeof el.checkVisibility !== "function" || el.checkVisibility()) return true;
  }
  return false;
}

/** 与 globals.css 中 --surface-app 保持一致。覆盖层直接用常量，避免临时改 data-theme
 *  触发整页重算/闪一下，也避免读到旧主题色导致「圆与背景同色看不见」。 */
const SURFACE_APP: Record<EffectiveTheme, string> = {
  light: "#f3f4f6",
  dark: "#0a0c10",
};

const CIRCLE_MS = 600;

/** 圆形揭开的序号：快速连点时会有多次揭开重叠。VT 规范下新一次 startViewTransition 会把
 *  上一次 skip 掉（其 finished 立即 reject），若那次的收尾照常执行，就会把正在播放的这一次
 *  的 .theme-circle-vt 与 --theme-circle-* 一起摘掉 —— 动画退化成默认交叉淡化，表现即
 *  「快速点击直接切换、没有圆」。只允许最新一次收尾。 */
let circleSeq = 0;
let circleCleanupTimer: ReturnType<typeof setTimeout> | undefined;
/** 覆盖层兜底路径上，尚未收尾的那一次的 finish（连点时立即结算，避免叠圆）。 */
let pendingOverlayFinish: (() => void) | null = null;

function endRadiusFor(origin: { x: number; y: number }): number {
  const { x, y } = origin;
  return Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  );
}

/** 取当前强调色给圆描边用；accent 变量定义在 .ca-app 上（见 accentVars 注释），
 *  读不到就退回默认蓝，保证描边一定有个可见颜色。 */
function currentAccent(): string {
  const host = document.querySelector<HTMLElement>(".ca-app") ?? document.documentElement;
  const value = getComputedStyle(host).getPropertyValue("--accent").trim();
  return value || DEFAULT_CUSTOM_ACCENT;
}

/** 从按钮起点扩散的切色圆：超大圆形 div + CSS transition transform:scale。
 *  - 不用 WAAPI：部分 WebKit 上 Element.animate 表现不稳
 *  - 不用 clip-path 动画：部分 WebKit 对 circle() 插值不稳定
 *  - 不用 popover：WebKit 对「顶层弹出层 + transform」的合成有 bug，会整块不绘制，
 *    改为直接挂到 <html> 顶层 + 最大 z-index
 *  - 填充用目标背景常量，另加一圈强调色描边+光晕，避免圆与背景同色「看不见」 */
function circleRevealWithOverlay(
  mutate: () => void,
  next: EffectiveTheme,
  origin: { x: number; y: number },
): void {
  // 连点：上一圈还没扩满就再切，先把它就地结算（提交它的主题并淡出），
  // 保证主题按点击顺序落地，且屏幕上同时只有一个正在扩散的圆。
  pendingOverlayFinish?.();
  const { x, y } = origin;
  const radius = Math.ceil(endRadiusFor(origin));
  const size = radius * 2;
  const accent = currentAccent();
  const overlay = document.createElement("div");
  overlay.setAttribute("aria-hidden", "true");
  overlay.dataset.themeCircleReveal = "";

  overlay.style.cssText = [
    "position:fixed",
    "inset:auto",
    // 圆心对准按钮：用 left/top + 负 margin，避免 transform-origin 与 scale 打架。
    `left:${x}px`,
    `top:${y}px`,
    `width:${size}px`,
    `height:${size}px`,
    `margin-left:${-radius}px`,
    `margin-top:${-radius}px`,
    "padding:0",
    "border:0",
    "display:block",
    "border-radius:50%",
    "pointer-events:none",
    "z-index:2147483647",
    `background:${SURFACE_APP[next]}`,
    // 强调色描边 + 光晕：无论新旧主题对比度多低，圆的边缘都清晰可见。
    `box-shadow:0 0 0 2px ${accent}, 0 0 40px 8px ${accent}`,
    // 从极小开始，scale(0) 在部分合成器上会被跳过。
    "transform:scale(0.001)",
    "opacity:1",
    "will-change:transform,opacity",
    "transition:none",
  ].join(";");

  // 挂到 <html> 顶层（<body> 之后绘制），避开任何 transform 祖先造成的 fixed 定位陷阱。
  const host = document.documentElement;
  host.appendChild(overlay);

  // 强制提交起始 transform，再开过渡；否则会直接到 scale(1)。
  void overlay.getBoundingClientRect();

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (pendingOverlayFinish === finish) pendingOverlayFinish = null;
    document.documentElement.dataset.theme = next;
    flushSync(mutate);
    overlay.style.transition = "opacity 180ms ease-out";
    overlay.style.opacity = "0";
    const remove = () => overlay.remove();
    overlay.addEventListener("transitionend", remove, { once: true });
    window.setTimeout(remove, 260);
  };

  pendingOverlayFinish = finish;

  const start = () => {
    overlay.style.transition = `transform ${CIRCLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`;
    overlay.style.transform = "scale(1)";
  };

  // 等起始 scale 提交后再开过渡。双 rAF + 短 timeout 双保险：
  // 有的 WebView 会合并 rAF；纯 timeout 在前台也足够等到下一帧。
  let started = false;
  const startOnce = () => {
    if (started) return;
    started = true;
    start();
  };
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(startOnce);
  });
  window.setTimeout(startOnce, 16);

  const onEnd = (event: TransitionEvent) => {
    if (event.target !== overlay) return;
    if (event.propertyName !== "transform") return;
    finish();
  };
  overlay.addEventListener("transitionend", onEnd);
  window.setTimeout(finish, CIRCLE_MS + 80);
}

/** 圆形揭开(首选):用 View Transitions 把「新主题快照」以 clip-path 圆从起点扩到整屏。
 *  圆内是真实的新主题界面、圆外是旧界面的静止快照——扩散过程中就能看到新界面在圆里
 *  逐渐显现,而不是先盖一层纯色圆、等盖满再整块切色。动画在 globals.css 的
 *  .theme-circle-vt 里声明(clip-path 圆),这里只负责写入圆心/半径并触发快照。 */
function circleRevealViewTransition(
  mutate: () => void,
  next: EffectiveTheme,
  origin: { x: number; y: number },
): void {
  const root = document.documentElement;
  const seq = ++circleSeq;
  const endRadius = Math.ceil(endRadiusFor(origin));
  root.style.setProperty("--theme-circle-x", `${origin.x}px`);
  root.style.setProperty("--theme-circle-y", `${origin.y}px`);
  root.style.setProperty("--theme-circle-r", `${endRadius}px`);
  root.classList.add("theme-circle-vt");

  const cleanup = () => {
    // 已被更晚的一次揭开接管：那次正在用这些类与变量，绝不能替它摘掉。
    if (seq !== circleSeq) return;
    root.classList.remove("theme-circle-vt");
    root.style.removeProperty("--theme-circle-x");
    root.style.removeProperty("--theme-circle-y");
    root.style.removeProperty("--theme-circle-r");
  };

  let transition: { finished: Promise<unknown> };
  try {
    transition = document.startViewTransition(() => {
      // 同步提交新主题:html[data-theme] 立即变(根变量),React 再同步渲染
      // .ca-app[data-theme](局部变量),保证「新快照」抓到的是完整的新主题配色。
      root.dataset.theme = next;
      flushSync(mutate);
    });
  } catch {
    cleanup();
    mutate();
    return;
  }
  transition.finished.then(cleanup, cleanup);
  // 双保险:极端情况下 finished 不落定也要把类和自定义属性摘掉。
  // 只保留最新一次的兜底 timer,否则上一次的定时器会在这一次播到一半时开火。
  if (circleCleanupTimer) clearTimeout(circleCleanupTimer);
  circleCleanupTimer = setTimeout(cleanup, CIRCLE_MS + 400);
}

/** 从按钮起点做圆形切色:优先 View Transitions(圆内显示真实新界面);引擎不支持时
 *  退回纯色覆盖层(圆内只有目标底色,扩满后再切——这是没有 VT 时的次优兜底)。 */
function circleRevealTheme(
  mutate: () => void,
  next: EffectiveTheme,
  origin: { x: number; y: number },
): void {
  if (typeof document.startViewTransition === "function") {
    circleRevealViewTransition(mutate, next, origin);
    return;
  }
  circleRevealWithOverlay(mutate, next, origin);
}

/** 应用明暗切换(mutate 里做真正的状态变更),按能力与场景选动画:
 *  1. reduce-motion:无论是否由按钮点击触发都直接瞬切;
 *  2. 有起点(点/键切换按钮):从按钮圆形扩散盖满整屏再切色(CSS transform 覆盖层);
 *  3. 无起点 + 可见重 DOM(data-theme-heavy):直接切——避免 VT/全树过渡放大成本;
 *  4. 无起点:View Transitions 交叉淡化,或全树过渡类兜底。 */
function applyThemeChange(mutate: () => void, next: EffectiveTheme): void {
  if (typeof document === "undefined") return mutate();
  const origin = consumeThemeOrigin();
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return mutate();
  if (origin) {
    circleRevealTheme(mutate, next, origin);
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

function rgbFromHex(value: string): [number, number, number] {
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

function relativeLuminance(value: string): number {
  const [r, g, b] = rgbFromHex(value).map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

/** 纯黑/纯白中总有一个能让任意不透明 sRGB 色达到至少 4.58:1。 */
function readableForeground(background: string): "#000000" | "#ffffff" {
  return contrastRatio("#ffffff", background) >= contrastRatio("#000000", background)
    ? "#ffffff"
    : "#000000";
}

function mixHex(value: string, target: string, ratio: number): string {
  const source = rgbFromHex(value);
  const destination = rgbFromHex(target);
  return `#${source
    .map((channel, index) =>
      Math.round(channel + (destination[index] - channel) * ratio)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** 保留强调色的色相倾向，同时确保小号文字在普通/选中交互表面上都达到 AA。 */
function readableAccentText(base: string, effective: EffectiveTheme): string {
  // 深色控件悬浮表面比主面板更亮；选中态还会叠加最多 24% 的强调色。
  // 两种表面都纳入计算，避免颜色只在静止面板上达标、选中后反而失去对比。
  const surface = effective === "dark" ? "#252a30" : "#ffffff";
  const selectedSurface = mixHex(surface, base, 0.24);
  const isReadable = (candidate: string) =>
    [surface, selectedSurface].every(
      (background) => contrastRatio(candidate, background) >= 4.5,
    );
  if (isReadable(base)) return base;
  const target = effective === "dark" ? "#ffffff" : "#000000";
  for (let step = 1; step <= 100; step += 1) {
    const candidate = mixHex(base, target, step / 100);
    if (isReadable(candidate)) return candidate;
  }
  return target;
}

/** 播放器控制层是近黑底，单独派生强调色，不能复用面板上的文字色。 */
function readableVideoAccent(base: string): string {
  const background = "#1a1a1a";
  if (contrastRatio(base, background) >= 4.5) return base;
  for (let step = 1; step <= 100; step += 1) {
    const candidate = mixHex(base, "#ffffff", step / 100);
    if (contrastRatio(candidate, background) >= 4.5) return candidate;
  }
  return "#ffffff";
}

function darkenHex(value: string, amount: number): string {
  return `#${rgbFromHex(value)
    .map((channel) => Math.round(channel * amount).toString(16).padStart(2, "0"))
    .join("")}`;
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
  const validCustomAccent = isHexColor(customAccent)
    ? normalizeHexColor(customAccent)
    : DEFAULT_CUSTOM_ACCENT;
  const base = accent === "custom" ? validCustomAccent : entry.accent;
  const press = accent === "custom" ? darkenHex(base, 0.88) : entry.press;
  const onAccent = readableForeground(base);
  const onAccentPress = readableForeground(press);
  const statusOk = effective === "dark" ? "#34d399" : "#147a52";
  const statusErr = effective === "dark" ? "#f87171" : "#c92a2a";
  return {
    "--accent": base,
    "--accent-press": press,
    "--on-accent": onAccent,
    "--on-accent-press": onAccentPress,
    "--accent-text": readableAccentText(base, effective),
    "--video-accent": readableVideoAccent(base),
    "--on-status-ok": readableForeground(statusOk),
    "--on-status-err": readableForeground(statusErr),
    "--accent-weak": `color-mix(in srgb, ${base} 14%, transparent)`,
    "--accent-weak-2": `color-mix(in srgb, ${base} 24%, transparent)`,
    // Tailwind 的 primary 系列(bg-primary/text-primary/accent-primary 等)走这个
    // @theme 令牌,一并联动,让用 primary 的元素也跟随强调色。
    "--color-primary": base,
    "--color-primary-foreground": onAccent,
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
    if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
      pendingOrigin = { x: origin.x, y: origin.y };
    }
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
      const next = resolveEffective("auto");
      if (next === useTheme.getState().effective) return;
      applyThemeChange(() => useTheme.setState({ effective: next }), next);
    });
}
