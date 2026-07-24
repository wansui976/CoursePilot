import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setThemeToggleOrigin, useTheme } from "./theme";

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

async function flushFrames() {
  // circleRevealWithOverlay 用 rAF + 16ms timeout 启动扩散。
  await vi.advanceTimersByTimeAsync(16);
}

describe("theme store light/dark transition", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("theme-animating", "theme-circle-vt");
    for (const prop of ["--theme-circle-x", "--theme-circle-y", "--theme-circle-r"]) {
      document.documentElement.style.removeProperty(prop);
    }
    useTheme.setState({ pref: "light", effective: "light" });
    stubReducedMotion(false);
  });

  afterEach(() => {
    delete vtDocument.startViewTransition;
    document.querySelectorAll("[data-theme-heavy]").forEach((el) => el.remove());
    document.querySelectorAll("[data-theme-circle-reveal]").forEach((el) => el.remove());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses view transitions when available (no whole-tree class)", () => {
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    vtDocument.startViewTransition = startViewTransition;

    useTheme.getState().toggle();

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(useTheme.getState().effective).toBe("dark");
    expect(document.documentElement.classList.contains("theme-animating")).toBe(false);
  });

  it("runs a view-transition circle reveal from the toggle origin (real content inside)", async () => {
    vi.useFakeTimers();
    // 有起点＝用户点了切换按钮：优先用 View Transitions 把新主题快照按 clip-path 圆扩散，
    // 圆内是真实新界面（不是交叉淡化，也不是纯色覆盖层）。
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    vtDocument.startViewTransition = startViewTransition;

    setThemeToggleOrigin(20, 700);
    useTheme.getState().toggle();

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    const root = document.documentElement;
    // 圆心/半径写进 <html> 内联变量，供 globals.css 的 clip-path 关键帧读取。
    expect(root.style.getPropertyValue("--theme-circle-x")).toBe("20px");
    expect(root.style.getPropertyValue("--theme-circle-y")).toBe("700px");
    expect(root.style.getPropertyValue("--theme-circle-r")).not.toBe("");
    expect(root.classList.contains("theme-circle-vt")).toBe(true);
    expect(useTheme.getState().effective).toBe("dark");
    // 没有退回纯色覆盖层
    expect(document.querySelector("[data-theme-circle-reveal]")).toBeNull();

    // 收尾后类与自定义属性都清掉。
    await vi.advanceTimersByTimeAsync(1100);
    expect(root.classList.contains("theme-circle-vt")).toBe(false);
    expect(root.style.getPropertyValue("--theme-circle-x")).toBe("");
  });

  it("falls back to a transform-scale overlay circle when View Transitions are unavailable", async () => {
    vi.useFakeTimers();
    // 不设置 startViewTransition：引擎不支持 VT 时退回纯色覆盖层圆。
    setThemeToggleOrigin(20, 700);
    useTheme.getState().toggle();

    const overlayNow = document.querySelector<HTMLElement>("[data-theme-circle-reveal]");
    expect(overlayNow).not.toBeNull();
    expect(overlayNow!.style.position).toBe("fixed");
    expect(overlayNow!.style.borderRadius).toBe("50%");
    expect(overlayNow!.style.left).toBe("20px");
    expect(overlayNow!.style.top).toBe("700px");
    expect(overlayNow!.style.transform).toBe("scale(0.001)");

    await flushFrames();
    const overlay = document.querySelector<HTMLElement>("[data-theme-circle-reveal]");
    expect(overlay!.style.transform).toBe("scale(1)");
    // 圆尚未收尾前不切主题
    expect(useTheme.getState().effective).toBe("light");

    await vi.advanceTimersByTimeAsync(700);
    expect(useTheme.getState().effective).toBe("dark");
    await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelector("[data-theme-circle-reveal]")).toBeNull();
  });

  it("keeps the circular reveal even when visible heavy DOM is present", async () => {
    vi.useFakeTimers();
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    vtDocument.startViewTransition = startViewTransition;
    const heavy = document.createElement("div");
    heavy.setAttribute("data-theme-heavy", "");
    (heavy as HTMLElement & { checkVisibility: () => boolean }).checkVisibility = () => true;
    document.body.appendChild(heavy);

    setThemeToggleOrigin(24, 680);
    useTheme.getState().toggle();

    // 有起点优先于重 DOM 瞬切：仍走圆形揭开（此处为 VT）。
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains("theme-circle-vt")).toBe(true);
    expect(useTheme.getState().effective).toBe("dark");
    await vi.advanceTimersByTimeAsync(1100);
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
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    vtDocument.startViewTransition = startViewTransition;

    useTheme.getState().toggle();

    expect(useTheme.getState().effective).toBe("dark");
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains("theme-animating")).toBe(false);
  });

  it("still reveals the circle on an explicit toggle even under reduced-motion", async () => {
    // 回归：WKWebView 常把 prefers-reduced-motion 报成 true,早退曾把整段圆动画吞掉,
    // 表现为「只切色、永远看不到圆」。用户亲手点击(带起点)必须照常揭开。
    vi.useFakeTimers();
    stubReducedMotion(true);
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    vtDocument.startViewTransition = startViewTransition;

    setThemeToggleOrigin(20, 700);
    useTheme.getState().toggle();

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains("theme-circle-vt")).toBe(true);
    expect(useTheme.getState().effective).toBe("dark");
    await vi.advanceTimersByTimeAsync(1100);
  });

  it("does not animate when the effective theme is unchanged", () => {
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    vtDocument.startViewTransition = startViewTransition;

    // light → auto 且系统也是 light(matchMedia stub 返回 false):实际明暗没变。
    useTheme.getState().setPref("auto");

    expect(useTheme.getState().effective).toBe("light");
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains("theme-animating")).toBe(false);
  });

  it("switches instantly when a visible heavy-DOM element is present", () => {
    // 文稿等大 DOM 在场时,任何动画(VT 双全屏快照/全树过渡)都会放大成本 —— 必须瞬切。
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
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
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    vtDocument.startViewTransition = startViewTransition;
    const heavy = document.createElement("div");
    heavy.setAttribute("data-theme-heavy", "");
    (heavy as HTMLElement & { checkVisibility: () => boolean }).checkVisibility = () => false;
    document.body.appendChild(heavy);

    useTheme.getState().toggle();

    expect(useTheme.getState().effective).toBe("dark");
    expect(startViewTransition).toHaveBeenCalledTimes(1);
  });

  it("accepts origin coordinates on toggle()", async () => {
    vi.useFakeTimers();
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    vtDocument.startViewTransition = startViewTransition;

    useTheme.getState().toggle({ x: 32, y: 640 });

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(document.documentElement.style.getPropertyValue("--theme-circle-x")).toBe("32px");
    expect(document.documentElement.classList.contains("theme-circle-vt")).toBe(true);
    await vi.advanceTimersByTimeAsync(1100);
    expect(useTheme.getState().effective).toBe("dark");
  });
});
