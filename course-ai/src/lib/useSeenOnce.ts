import { useEffect, useState, type RefObject } from "react";

/**
 * 元素进入（或接近）视口过一次就一直为 true。用来推迟只在看得见时才需要的请求，
 * 比如几百张课程卡片的首帧封面：一打开就全要，后端要排几百个截帧进程。
 * 没有 IntersectionObserver 的环境（测试、旧 WebView）直接当作看见了。
 */
export function useSeenOnce(ref: RefObject<Element | null>, rootMargin = "600px"): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen) return;
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin, seen]);
  return seen;
}
