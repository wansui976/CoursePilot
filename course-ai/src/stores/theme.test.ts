import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./theme";

// lib.dom 把 startViewTransition 的返回值定为 ViewTransition；测试替身只关心回调执行。
const vtDocument = document as unknown as { startViewTransition?: unknown };
const circleSelector = "[data-theme-circle-reveal]";

function stubReducedMotion(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? matches : false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function addHeavyDom(visible: boolean) {
  const heavy = document.createElement("div");
  heavy.setAttribute("data-theme-heavy", "");
  (heavy as HTMLElement & { checkVisibility: () => boolean }).checkVisibility = () => visible;
  document.body.appendChild(heavy);
}

describe("theme store light/dark transition", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("theme-animating", "theme-circle-vt");
    document.documentElement.dataset.theme = "light";
    document.querySelectorAll(circleSelector).forEach((el) => el.remove());
    useTheme.setState({ pref: "light", effective: "light" });
    stubReducedMotion(false);
  });

  afterEach(() => {
    vi.clearAllTimers();
    delete vtDocument.startViewTransition;
    document.querySelectorAll("[data-theme-heavy]").forEach((el) => el.remove());
    document.querySelectorAll(circleSelector).forEach((el) => el.remove());
    document.documentElement.classList.remove("theme-animating", "theme-circle-vt");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses View Transitions when no explicit origin is available", () => {
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

  it("reveals an explicit toggle with a target-theme circle even when View Transitions exist", async () => {
    vi.useFakeTimers();
    const startViewTransition = vi.fn();
    vtDocument.startViewTransition = startViewTransition;
    const origin = { x: 24, y: window.innerHeight - 24 };

    useTheme.getState().toggle(origin);

    const overlay = document.querySelector<HTMLElement>(circleSelector);
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(overlay).not.toBeNull();
    expect(overlay).toHaveClass("theme-circle-reveal");
    expect(overlay).toHaveAttribute("data-theme", "dark");
    expect(overlay!.style.getPropertyValue("--theme-circle-x")).toBe(`${origin.x}px`);
    expect(overlay!.style.getPropertyValue("--theme-circle-y")).toBe(`${origin.y}px`);
    expect(overlay!.style.getPropertyValue("--theme-circle-duration")).toBe("420ms");
    expect(Number(overlay!.style.getPropertyValue("--theme-circle-scale")) * 24).toBeGreaterThanOrEqual(
      Math.hypot(
        Math.max(origin.x, window.innerWidth - origin.x),
        Math.max(origin.y, window.innerHeight - origin.y),
      ) + 2,
    );
    expect(useTheme.getState().effective).toBe("light");

    await vi.advanceTimersByTimeAsync(500);
    expect(useTheme.getState().effective).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(overlay).toHaveClass("is-complete");

    await vi.advanceTimersByTimeAsync(250);
    expect(document.querySelector(circleSelector)).toBeNull();
  });

  it("keeps the explicit circle path when visible heavy DOM is present", () => {
    vi.useFakeTimers();
    const startViewTransition = vi.fn();
    vtDocument.startViewTransition = startViewTransition;
    addHeavyDom(true);

    useTheme.getState().toggle({ x: 24, y: window.innerHeight - 24 });

    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.querySelector(circleSelector)).not.toBeNull();
    expect(useTheme.getState().effective).toBe("light");
  });

  it("falls back to the whole-tree transition class without View Transitions", () => {
    vi.useFakeTimers();

    useTheme.getState().toggle();

    expect(useTheme.getState().effective).toBe("dark");
    expect(document.documentElement.classList.contains("theme-animating")).toBe(true);
    vi.advanceTimersByTime(400);
    expect(document.documentElement.classList.contains("theme-animating")).toBe(false);
  });

  it("switches an explicit toggle instantly under prefers-reduced-motion", () => {
    stubReducedMotion(true);
    const startViewTransition = vi.fn();
    vtDocument.startViewTransition = startViewTransition;

    useTheme.getState().toggle({ x: 24, y: window.innerHeight - 24 });

    expect(useTheme.getState().effective).toBe("dark");
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.querySelector(circleSelector)).toBeNull();
    expect(document.documentElement.classList.contains("theme-animating")).toBe(false);
  });

  it("does not animate when the effective theme is unchanged", () => {
    const startViewTransition = vi.fn();
    vtDocument.startViewTransition = startViewTransition;

    // light -> auto 且系统也是 light：实际明暗没有变化。
    useTheme.getState().setPref("auto");

    expect(useTheme.getState().effective).toBe("light");
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains("theme-animating")).toBe(false);
  });

  it("switches instantly when visible heavy DOM has no explicit origin", () => {
    const startViewTransition = vi.fn();
    vtDocument.startViewTransition = startViewTransition;
    addHeavyDom(true);

    useTheme.getState().toggle();

    expect(useTheme.getState().effective).toBe("dark");
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains("theme-animating")).toBe(false);
  });

  it("uses View Transitions when heavy DOM is hidden", () => {
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    vtDocument.startViewTransition = startViewTransition;
    addHeavyDom(false);

    useTheme.getState().toggle();

    expect(useTheme.getState().effective).toBe("dark");
    expect(startViewTransition).toHaveBeenCalledTimes(1);
  });

  it("ignores a second explicit toggle while the circle is in progress", async () => {
    vi.useFakeTimers();

    useTheme.getState().toggle({ x: 24, y: window.innerHeight - 24 });
    useTheme.getState().toggle({ x: 24, y: window.innerHeight - 24 });

    expect(document.querySelectorAll(circleSelector)).toHaveLength(1);
    expect(useTheme.getState().effective).toBe("light");
    await vi.advanceTimersByTimeAsync(500);
    expect(useTheme.getState().effective).toBe("dark");
  });
});
