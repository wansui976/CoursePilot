import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

/**
 * 贴着按钮弹出的浮层（下拉菜单）该放在哪：挂在 body 上、用 fixed 定位，不会被内容区的
 * overflow 裁掉；位置按窗口里剩下的空间选——
 * - 横向：按钮在窗口左半边就和它左缘对齐、往右展开，在右半边就和右缘对齐、往左展开
 *   （课程页顶部靠左的按钮，菜单不会盖到侧栏上去）；最后夹在窗口里；
 * - 纵向：下面放得下就往下弹；放不下、而上面更宽裕就往上弹；都不够就限高，浮层自己滚动。
 * 窗口缩放、页面滚动时跟着重新算。
 */
export function useAnchoredPosition(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  { gap = 6, margin = 8 }: { gap?: number; margin?: number } = {},
): CSSProperties {
  // 量出位置之前先藏着（但要排版出来，才量得到大小），免得在左上角闪一下。
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", left: 0, top: 0, visibility: "hidden" });

  useLayoutEffect(() => {
    if (!open) {
      setStyle({ position: "fixed", left: 0, top: 0, visibility: "hidden" });
      return;
    }
    const place = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const width = panel.offsetWidth;
      const height = panel.scrollHeight;

      const leftHalf = trigger.left + trigger.width / 2 < viewportWidth / 2;
      let left = leftHalf ? trigger.left : trigger.right - width;
      left = Math.min(Math.max(margin, left), Math.max(margin, viewportWidth - width - margin));

      const below = viewportHeight - trigger.bottom - gap - margin;
      const above = trigger.top - gap - margin;
      const next: CSSProperties = { position: "fixed", left, visibility: "visible" };
      if (height <= below || below >= above) {
        next.top = trigger.bottom + gap;
        next.maxHeight = Math.max(below, 120);
      } else {
        next.bottom = viewportHeight - trigger.top + gap;
        next.maxHeight = Math.max(above, 120);
      }
      setStyle(next);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, triggerRef, panelRef, gap, margin]);

  return style;
}
