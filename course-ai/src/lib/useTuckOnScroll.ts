import { useEffect, useState } from "react";

/** 往下滚超过这么多像素才收起、往上滚超过这么多才露出来，手指抖一下不算。 */
const THRESHOLD = 12;
/** 手指 / 滚轮 / 按键之后多久内的滚动算用户自己滚的（含 iOS 松手后的惯性）。 */
const USER_SCROLL_WINDOW_MS = 1500;
const USER_INPUT_EVENTS = ["touchstart", "touchmove", "touchend", "wheel", "keydown", "pointerdown"] as const;

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
    // 只认用户自己滚的：文稿、重点章节「跟随播放」时会自己往下滚，那时浮球被收起，
    // 用户什么都没做按钮就没了。程序滚动只更新记下的位置，不改收起状态。
    // 还要是在这个容器里动的手：点一下视频卡片后，章节列表紧接着自己滚到播放位置，
    // 光看「刚有过输入」会把那次程序滚动也算成用户的。
    let lastInputAt = Number.NEGATIVE_INFINITY;
    let lastInputTarget: Node | null = null;
    const onInput = (event: Event) => {
      lastInputAt = performance.now();
      lastInputTarget =
        event.type === "keydown"
          ? document.activeElement
          : event.target instanceof Node
            ? event.target
            : null;
    };
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
      if (performance.now() - lastInputAt > USER_SCROLL_WINDOW_MS) return;
      const isPageScroller = element === (document.scrollingElement ?? document.documentElement);
      if (!isPageScroller && !(lastInputTarget && element.contains(lastInputTarget))) return;
      if (top <= 0) return setTucked(false);
      const delta = top - previous;
      if (delta > THRESHOLD) setTucked(true);
      else if (delta < -THRESHOLD) setTucked(false);
      else last.set(element, previous); // 小步累计，慢慢滚也能触发
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    for (const type of USER_INPUT_EVENTS) {
      window.addEventListener(type, onInput, { capture: true, passive: true });
    }
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      for (const type of USER_INPUT_EVENTS) {
        window.removeEventListener(type, onInput, { capture: true });
      }
    };
  }, [enabled]);
  return tucked;
}
