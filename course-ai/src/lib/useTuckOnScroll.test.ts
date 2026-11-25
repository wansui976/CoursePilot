import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTuckOnScroll } from "./useTuckOnScroll";

/** 用户用手指滚：先有一次触摸，再滚。 */
function scrollTo(el: HTMLElement, top: number) {
  el.dispatchEvent(new Event("touchmove", { bubbles: true }));
  el.scrollTop = top;
  el.dispatchEvent(new Event("scroll"));
}

/** 程序自己滚（跟随播放），没有任何用户输入。 */
function scrollByCode(el: HTMLElement, top: number) {
  el.scrollTop = top;
  el.dispatchEvent(new Event("scroll"));
}

describe("useTuckOnScroll", () => {
  it("往下读时收起，往回滚或回到顶时露出", () => {
    const box = document.createElement("div");
    document.body.appendChild(box);
    const { result } = renderHook(() => useTuckOnScroll(true));
    act(() => scrollTo(box, 0));
    act(() => scrollTo(box, 5));
    expect(result.current).toBe(false); // 手指抖一下不算
    act(() => scrollTo(box, 40));
    expect(result.current).toBe(true);
    act(() => scrollTo(box, 20));
    expect(result.current).toBe(false);
    act(() => scrollTo(box, 80));
    expect(result.current).toBe(true);
    act(() => scrollTo(box, 0));
    expect(result.current).toBe(false);
    box.remove();
  });

  it("跟随播放这类程序滚动不收起浮球", () => {
    vi.useFakeTimers();
    try {
      const box = document.createElement("div");
      document.body.appendChild(box);
      const { result } = renderHook(() => useTuckOnScroll(true));
      vi.advanceTimersByTime(5_000);
      act(() => scrollByCode(box, 0));
      act(() => scrollByCode(box, 300));
      expect(result.current).toBe(false);
      // 刚在别处点过一下（比如点开视频），这个列表紧接着自己滚：也不算。
      const elsewhere = document.createElement("button");
      document.body.appendChild(elsewhere);
      act(() => {
        elsewhere.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      });
      act(() => scrollByCode(box, 600));
      expect(result.current).toBe(false);
      elsewhere.remove();
      // 之后用户自己往下滚，从程序滚到的位置接着算。
      act(() => scrollTo(box, 660));
      expect(result.current).toBe(true);
      box.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("关掉时永远露着", () => {
    const box = document.createElement("div");
    document.body.appendChild(box);
    const { result } = renderHook(() => useTuckOnScroll(false));
    act(() => scrollTo(box, 0));
    act(() => scrollTo(box, 200));
    expect(result.current).toBe(false);
    box.remove();
  });
});
