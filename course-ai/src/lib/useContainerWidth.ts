import { useEffect, useState, type RefObject } from "react";

export type WidthBucket = "compact" | "medium" | "wide";

// 断点（见设计规格）：compact <600 / medium 600–899 / wide ≥900。
const COMPACT_MAX = 600;
const MEDIUM_MAX = 900;

export function bucketForWidth(width: number): WidthBucket {
  if (width < COMPACT_MAX) return "compact";
  if (width < MEDIUM_MAX) return "medium";
  return "wide";
}

/** 是否触控指针（决定触控目标尺寸、是否可依赖 hover），与宽度解耦。 */
export function coarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(pointer: coarse)").matches;
}

function widthFromWindow(): number {
  if (typeof window === "undefined") return 0;
  return window.innerWidth || 0;
}

function initialBucket(): WidthBucket {
  const w = widthFromWindow();
  // 宽度未知（SSR/极端情况）默认 wide，保证测试/桌面按宽屏结构渲染。
  return w > 0 ? bucketForWidth(w) : "wide";
}

/**
 * 观测 `ref` 元素的实际宽度，返回档位。窗口缩放/分屏/旋转都会触发更新。
 * jsdom / 极旧 WebView 无 ResizeObserver 时按窗口宽度定一次。
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>): WidthBucket {
  const [bucket, setBucket] = useState<WidthBucket>(initialBucket);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      setBucket(initialBucket());
      return;
    }
    const el = ref.current;
    const measure = () => {
      // el 脱离文档（clientWidth 0）时退回窗口宽度;都未知则 bucketForWidth(0)=compact。
      setBucket(bucketForWidth(el?.clientWidth || widthFromWindow()));
    };
    measure();
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return bucket;
}
