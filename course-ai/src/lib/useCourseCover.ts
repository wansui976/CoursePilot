import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { guessCoverKind, type CourseCover, type CoverKind, type CoverShape } from "@/lib/coverKind";
import { ipc } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";

/** 所有课程存下来的封面，按课程 id 查。 */
export function useCourseCovers() {
  return useQuery({
    queryKey: qk.courseCovers(),
    queryFn: () => ipc.courses.covers(),
    staleTime: Infinity,
    select: (list) => new Map(list.map((cover) => [cover.course_id, cover])),
  });
}

export interface ResolvedCover {
  kind: CoverKind;
  art: CoverShape[] | null;
  terms: string[];
}

/** 一门课的封面：有存下来的（AI 或手动）就用它，没有就按课程名和标题里的关键词猜。 */
export function useCoverFor(courseId: string | null | undefined, ...texts: (string | null | undefined)[]): ResolvedCover {
  const { data } = useCourseCovers();
  const saved = courseId ? data?.get(courseId) : undefined;
  if (saved) return { kind: saved.kind, art: saved.art, terms: saved.terms };
  return { kind: guessCoverKind(...texts), art: null, terms: [] };
}

/** 这次启动里已经排进队的课程，失败了也不再问（没配模型、离线时不反复打扰）。 */
const asked = new Set<string>();
const queue: string[] = [];
let running = false;
let stopped = false;

async function drain(onCover: (cover: CourseCover) => void) {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0 && !stopped) {
      const id = queue.shift()!;
      try {
        const cover = await ipc.courses.classifyCover(id);
        if (cover) onCover(cover);
      } catch (error) {
        if (String(error).includes("还没有配置大模型")) stopped = true;
      }
    }
  } finally {
    running = false;
  }
}

/**
 * 还没有封面的课程，挨个请 AI 判断一次（全局一个队列，一次只发一个请求）。
 * 没配大模型就停下，本次启动不再尝试。判断出来之前封面先用关键词猜的结果，判断完自动换上。
 */
export function useAutoClassifyCovers(courseIds: string[]) {
  const queryClient = useQueryClient();
  const { data, isSuccess } = useCourseCovers();
  const key = isSuccess ? courseIds.filter((id) => !data.has(id) && !asked.has(id)).join(",") : "";

  useEffect(() => {
    if (!key || stopped) return;
    for (const id of key.split(",")) {
      asked.add(id);
      queue.push(id);
    }
    void drain((cover) =>
      queryClient.setQueryData<CourseCover[]>(qk.courseCovers(), (list = []) => [
        ...list.filter((item) => item.course_id !== cover.course_id),
        cover,
      ]),
    );
  }, [key, queryClient]);
}

/** 测试用：清掉本次启动的记忆。 */
export function resetAutoClassifyForTests() {
  asked.clear();
  queue.length = 0;
  running = false;
  stopped = false;
}
