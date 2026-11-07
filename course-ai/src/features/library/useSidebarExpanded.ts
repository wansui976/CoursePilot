import { useCallback, useState } from "react";

const STORAGE_KEY = "course-ai-sidebar-expanded";

function readExpanded(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * 侧栏里展开了哪些课程 / 文件夹。只记在本机（手机和电脑想看的通常不一样），不进同步。
 */
export function useSidebarExpanded() {
  const [expanded, setExpanded] = useState(readExpanded);
  const update = useCallback((change: (next: Set<string>) => void) => {
    setExpanded((current) => {
      const next = new Set(current);
      change(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // 存储不可用：本次会话内照常展开收起，只是不记住。
      }
      return next;
    });
  }, []);
  const toggle = useCallback(
    (id: string) => update((next) => (next.has(id) ? next.delete(id) : next.add(id))),
    [update],
  );
  const open = useCallback((ids: string[]) => update((next) => ids.forEach((id) => next.add(id))), [update]);
  return { expanded, toggle, open };
}
