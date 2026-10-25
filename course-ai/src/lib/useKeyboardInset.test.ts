import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KEYBOARD_MIN_INSET, keyboardInset, useKeyboardInset } from "./useKeyboardInset";

describe("keyboardInset", () => {
  it("视口没变（桌面、外接键盘）时为 0", () => {
    expect(keyboardInset({ height: 900, offsetTop: 0 }, 900)).toBe(0);
    expect(keyboardInset(null, 900)).toBe(0);
    expect(keyboardInset(undefined, 900)).toBe(0);
  });

  it("键盘顶起来的高度算进底部偏移，并扣掉页面上推的位移", () => {
    expect(keyboardInset({ height: 560, offsetTop: 0 }, 900)).toBe(340);
    // 键盘把页面又往上推了 60px：视口矮 340、同时偏移 60，盖住的仍是 340。
    expect(keyboardInset({ height: 560, offsetTop: 60 }, 900)).toBe(280);
  });

  it("地址栏伸缩这类小幅变化不算键盘", () => {
    expect(keyboardInset({ height: 900 - (KEYBOARD_MIN_INSET - 1), offsetTop: 0 }, 900)).toBe(0);
    expect(keyboardInset({ height: 900 - KEYBOARD_MIN_INSET, offsetTop: 0 }, 900)).toBe(
      KEYBOARD_MIN_INSET,
    );
  });
});

describe("useKeyboardInset", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fakeViewport(height: number) {
    // 两种事件（resize / scroll）注册的是同一个回调，所以按「事件名 + 回调」记，不能去重。
    const listeners: [string, () => void][] = [];
    return {
      height,
      offsetTop: 0,
      addEventListener: (type: string, listener: () => void) => listeners.push([type, listener]),
      removeEventListener: (type: string, listener: () => void) => {
        const index = listeners.findIndex(([kind, fn]) => kind === type && fn === listener);
        if (index >= 0) listeners.splice(index, 1);
      },
      resize(next: number) {
        this.height = next;
        for (const [type, listener] of [...listeners]) if (type === "resize") listener();
      },
      listenerCount: () => listeners.length,
    };
  }

  it("键盘弹出时给出被盖住的高度，收起后回到 0", async () => {
    const viewport = fakeViewport(900);
    vi.stubGlobal("innerHeight", 900);
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });

    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(0);

    viewport.resize(560);
    await vi.waitFor(() => expect(result.current).toBe(340));

    viewport.resize(900);
    await vi.waitFor(() => expect(result.current).toBe(0));
  });

  it("卸载时摘掉监听，不留在 visualViewport 上", () => {
    const viewport = fakeViewport(900);
    vi.stubGlobal("innerHeight", 900);
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });

    const { unmount } = renderHook(() => useKeyboardInset());
    expect(viewport.listenerCount()).toBe(2);
    unmount();
    expect(viewport.listenerCount()).toBe(0);
  });
});
