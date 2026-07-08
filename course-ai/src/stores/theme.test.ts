import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./theme";

// lib.dom 把 startViewTransition 的返回值定为 ViewTransition;测试替身只关心回调执行,
// 这里绕开原签名以便赋入/删除 vi.fn。
const vtDocument = document as unknown as { startViewTransition?: unknown };

function stubReducedMotion(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? matches : false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe("theme store light/dark transition", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("theme-animating");
    useTheme.setState({ pref: "light", effective: "light" });
    stubReducedMotion(false);
  });

  afterEach(() => {
    delete vtDocument.startViewTransition;
    document.querySelectorAll("[data-theme-heavy]").forEach((el) => el.remove());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses a view transition (single snapshot crossfade) when supported", () => {
    // 打开文稿等大 DOM 时,全树逐元素过渡会整屏逐帧重绘而卡顿;
    // 支持 View Transitions 的引擎必须走快照交叉淡化,且不再挂全树过渡类。
    const startViewTransition = vi.fn((cb: () => void) => cb());
    vtDocument.startViewTransition = startViewTransition;

    useTheme.getState().toggle();

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(useTheme.getState().effective).toBe("dark");
    expect(document.documentElement.classList.contains("theme-animating")).toBe(false);
  });

  it("falls back to the whole-tree transition class without view transitions", () => {
    vi.useFakeTimers();

    useTheme.getState().toggle();

    expect(useTheme.getState().effective).toBe("dark");
    expect(document.documentElement.classList.contains("theme-animating")).toBe(true);
    vi.advanceTimersByTime(400);
    expect(document.documentElement.classList.contains("theme-animating")).toBe(false);
  });

  it("switches instantly with no animation under prefers-reduced-motion", () => {
    stubReducedMotion(true);
    const startViewTransition = vi.fn((cb: () => void) => cb());
    vtDocument.startViewTransition = startViewTransition;

    useTheme.getState().toggle();

    expect(useTheme.getState().effective).toBe("dark");
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains("theme-animating")).toBe(false);
  });

  it("does not animate when the effective theme is unchanged", () => {
    const startViewTransition = vi.fn((cb: () => void) => cb());
    vtDocument.startViewTransition = startViewTransition;

    // light → auto 且系统也是 light(matchMedia stub 返回 false):实际明暗没变。
    useTheme.getState().setPref("auto");

    expect(useTheme.getState().effective).toBe("light");
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains("theme-animating")).toBe(false);
  });

  it("switches instantly when a visible heavy-DOM element is present", () => {
    // 文稿等大 DOM 在场时,任何动画(VT 双全屏快照/全树过渡)都会放大成本 —— 必须瞬切。
    const startViewTransition = vi.fn((cb: () => void) => cb());
    vtDocument.startViewTransition = startViewTransition;
    const heavy = document.createElement("div");
    heavy.setAttribute("data-theme-heavy", "");
    (heavy as HTMLElement & { checkVisibility: () => boolean }).checkVisibility = () => true;
    document.body.appendChild(heavy);

    useTheme.getState().toggle();

    expect(useTheme.getState().effective).toBe("dark");
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains("theme-animating")).toBe(false);
  });

  it("keeps the fade when the heavy-DOM element is hidden", () => {
    // TabsPanel 非活动 tab 用 display:none 隐藏,checkVisibility 为 false → 不算在场。
    const startViewTransition = vi.fn((cb: () => void) => cb());
    vtDocument.startViewTransition = startViewTransition;
    const heavy = document.createElement("div");
    heavy.setAttribute("data-theme-heavy", "");
    (heavy as HTMLElement & { checkVisibility: () => boolean }).checkVisibility = () => false;
    document.body.appendChild(heavy);

    useTheme.getState().toggle();

    expect(useTheme.getState().effective).toBe("dark");
    expect(startViewTransition).toHaveBeenCalledTimes(1);
  });
});
