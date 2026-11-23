import { useEffect, useState } from "react";

/** 往下滚超过这么多像素才收起、往上滚超过这么多才露出来，手指抖一下不算。 */
const THRESHOLD = 12;

/**
 * 手机上的浮动按钮：往下读的时候收起来，不挡正文；往回滚一点、或滚到顶，就露出来。
 * 页面里滚动的往往是某个内层容器（文稿、知识点列表），所以在 window 上用捕获阶段
 * 听所有元素的 scroll，各容器分别记上一次的位置。
 */
export function useTuckOnScroll(enabled: boolean): boolean {
  const [tucked, setTucked] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setTucked(false);
      return;
    }
    const last = new WeakMap<EventTarget, number>();
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!target) return;
      const element =
        target === document ? (document.scrollingElement ?? document.documentElement) : (target as Element);
      if (!(element instanceof Element)) return;
      // 横向滚动（时间轴、标签条）不算读正文。
      const top = element.scrollTop;
      const previous = last.get(element);
      last.set(element, top);
      if (previous === undefined) return;
      if (top <= 0) return setTucked(false);
      const delta = top - previous;
      if (delta > THRESHOLD) setTucked(true);
      else if (delta < -THRESHOLD) setTucked(false);
      else last.set(element, previous); // 小步累计，慢慢滚也能触发
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, [enabled]);
  return tucked;
}
