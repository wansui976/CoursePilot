import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTuckOnScroll } from "./useTuckOnScroll";

function scrollTo(el: HTMLElement, top: number) {
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
