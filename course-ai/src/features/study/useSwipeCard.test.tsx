import { act, renderHook } from "@testing-library/react";
import type { PointerEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { SWIPE_THRESHOLD_PX, useSwipeCard } from "./useSwipeCard";

const ev = (x: number, y = 0, pointerType = "touch") =>
  ({ clientX: x, clientY: y, pointerId: 1, pointerType }) as unknown as PointerEvent<HTMLElement>;

describe("useSwipeCard", () => {
  it("grades when a touch drag passes the threshold, and springs back otherwise", () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useSwipeCard({ enabled: true, onSwipe }));
    act(() => result.current.handlers.onPointerDown(ev(100)));
    act(() => result.current.handlers.onPointerMove(ev(100 + SWIPE_THRESHOLD_PX + 10)));
    expect(result.current.rightStamp).toBe(1);
    act(() => result.current.handlers.onPointerUp(ev(100 + SWIPE_THRESHOLD_PX + 10)));
    expect(onSwipe).toHaveBeenCalledWith("right");
    expect(result.current.dx).toBe(0);

    act(() => result.current.handlers.onPointerDown(ev(100)));
    act(() => result.current.handlers.onPointerUp(ev(60)));
    expect(onSwipe).toHaveBeenCalledTimes(1);
  });

  it("ignores the mouse and does nothing before the card is turned", () => {
    const onSwipe = vi.fn();
    const mouse = renderHook(() => useSwipeCard({ enabled: true, onSwipe }));
    act(() => mouse.result.current.handlers.onPointerDown(ev(0, 0, "mouse")));
    act(() => mouse.result.current.handlers.onPointerUp(ev(-200, 0, "mouse")));
    const off = renderHook(() => useSwipeCard({ enabled: false, onSwipe }));
    act(() => off.result.current.handlers.onPointerDown(ev(0)));
    act(() => off.result.current.handlers.onPointerUp(ev(-200)));
    expect(onSwipe).not.toHaveBeenCalled();
  });
});
