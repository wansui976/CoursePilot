import { useEffect, useState } from "react";

/** 视口被盖住超过这么高才算软键盘；地址栏伸缩、旋转回弹这类几十像素的抖动不算。 */
export const KEYBOARD_MIN_INSET = 120;

/**
 * 软键盘盖住的高度（CSS 像素，从布局视口底边往上算）。
 *
 * iOS 的 WKWebView 弹键盘时不改布局视口，只把 visualViewport 变矮、再往上挪一点；
 * 而 position: fixed 仍然以布局视口为准，于是 bottom: 0 会落在键盘后面。
 * 想让元素贴在键盘上沿，就得把这段差值加到 bottom 上。
 * 桌面、外接键盘、以及把窗口缩小的 Android（resize 模式）都是 0，布局保持原样。
 */
export function keyboardInset(
  viewport: { height: number; offsetTop?: number } | null | undefined,
  layoutHeight: number,
): number {
  if (!viewport || !Number.isFinite(layoutHeight)) return 0;
  const covered = Math.round(layoutHeight - viewport.height - (viewport.offsetTop ?? 0));
  return covered >= KEYBOARD_MIN_INSET ? covered : 0;
}

/**
 * 订阅 visualViewport：键盘弹出 / 收起、键盘上推页面时更新。
 * 测量放在 rAF 里合帧——iOS 弹键盘会连发几十个 resize。
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    let trailing = 0;
    const measure = () => {
      frame = 0;
      setInset(keyboardInset(viewport, window.innerHeight));
    };
    const schedule = () => {
      // iOS 收起键盘、只留输入辅助条时，visualViewport 的值会晚一拍才报到位。
      // 只量事件那一瞬间，格式条会悬在半空；事件过后再补量一次。
      window.clearTimeout(trailing);
      trailing = window.setTimeout(measure, 250);
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    viewport.addEventListener("resize", schedule);
    // 键盘把页面整体上推时只发 scroll，不发 resize。
    viewport.addEventListener("scroll", schedule);
    return () => {
      window.clearTimeout(trailing);
      if (frame) window.cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
    };
  }, []);

  return inset;
}
