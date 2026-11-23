import { useRef, useState, type PointerEvent } from "react";
import { haptic } from "@/lib/feedback";

/** 拖过这么远松手就算数。 */
export const SWIPE_THRESHOLD_PX = 90;

/**
 * 手机上左右滑复习卡：左滑「忘了」、右滑「记得」。卡片跟着手指走、带一点倾斜，
 * 越过阈值的那一刻轻震一下；没越过就弹回。只认触摸和笔，鼠标照旧用按钮和键盘。
 */
export function useSwipeCard({
  enabled,
  onSwipe,
}: {
  enabled: boolean;
  onSwipe: (direction: "left" | "right") => void;
}) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const crossed = useRef(false);

  function onPointerDown(event: PointerEvent<HTMLElement>) {
    if (!enabled || event.pointerType === "mouse") return;
    start.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
    crossed.current = false;
  }

  function onPointerMove(event: PointerEvent<HTMLElement>) {
    const s = start.current;
    if (!s || event.pointerId !== s.id) return;
    const next = event.clientX - s.x;
    // 竖着滑是在滚动答案，不接管。
    if (Math.abs(event.clientY - s.y) > Math.abs(next) && Math.abs(next) < 12) return;
    const over = Math.abs(next) >= SWIPE_THRESHOLD_PX;
    if (over !== crossed.current) {
      crossed.current = over;
      if (over) haptic("tick");
    }
    setDx(next);
  }

  function finish(event: PointerEvent<HTMLElement>) {
    const s = start.current;
    if (!s || event.pointerId !== s.id) return;
    start.current = null;
    const final = event.clientX - s.x;
    setDx(0);
    if (Math.abs(final) >= SWIPE_THRESHOLD_PX) onSwipe(final > 0 ? "right" : "left");
  }

  return {
    dx,
    /** 0..1：左右印章的不透明度。 */
    leftStamp: Math.min(1, Math.max(0, -dx / SWIPE_THRESHOLD_PX)),
    rightStamp: Math.min(1, Math.max(0, dx / SWIPE_THRESHOLD_PX)),
    handlers: { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: () => setDx(0) },
  };
}
