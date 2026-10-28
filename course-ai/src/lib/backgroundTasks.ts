import { useEffect, useRef, useState } from "react";
import { useMutationState, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Video } from "@/lib/types";

/**
 * 后台任务：生成摘要 / 章节 / 题目 / 导图 / 讲义、提取课件、识别课件文字、分析知识点……
 * 这些付费或耗时的活都是 React Query 的 mutation，切走面板后照常在跑。
 * 给它们的 mutation 打上 meta.task，全局就能列出「哪个视频在生成什么」，跑完时提醒一声。
 */

export type TaskKind =
  | "summary"
  | "chapters"
  | "quiz"
  | "mindmap"
  | "notes"
  | "slides-extract"
  | "slides-ocr"
  | "handout"
  | "concepts-analyze"
  | "concepts-summarize";

export type TaskMeta = {
  kind: TaskKind;
  videoId?: string;
  courseId?: string;
};

export type BackgroundTask = TaskMeta & {
  id: number;
  submittedAt: number;
};

/** 学习面板里能直达的位置。 */
export type StudyTarget =
  | { tab: "overview" | "transcript" | "notes" }
  | { tab: "more"; moreView: "quiz" | "slides" | "mindmap" };

/** useMutation 的 meta：`meta: taskMeta("summary", { videoId })`。 */
export function taskMeta(kind: TaskKind, scope: { videoId?: string; courseId?: string }) {
  return { task: { kind, ...scope } satisfies TaskMeta };
}

export function readTaskMeta(meta: unknown): TaskMeta | null {
  const task = (meta as { task?: TaskMeta } | undefined)?.task;
  return task && typeof task.kind === "string" ? task : null;
}

/** 任务结果在学习面板的哪一页；课程级任务（知识点）返回 null，由调用方去知识点页。 */
export function studyTargetFor(kind: TaskKind): StudyTarget | null {
  switch (kind) {
    case "summary":
    case "chapters":
      return { tab: "overview" };
    case "notes":
      return { tab: "notes" };
    case "quiz":
      return { tab: "more", moreView: "quiz" };
    case "mindmap":
      return { tab: "more", moreView: "mindmap" };
    case "slides-extract":
    case "slides-ocr":
    case "handout":
      return { tab: "more", moreView: "slides" };
    case "concepts-analyze":
    case "concepts-summarize":
      return null;
  }
}

/** 正在跑的后台任务，按开始时间排列。 */
export function useBackgroundTasks(): BackgroundTask[] {
  return useMutationState({
    filters: { status: "pending", predicate: (mutation) => readTaskMeta(mutation.options.meta) != null },
    select: (mutation) => ({
      ...readTaskMeta(mutation.options.meta)!,
      id: mutation.mutationId,
      submittedAt: mutation.state.submittedAt,
    }),
  }).sort((a, b) => a.submittedAt - b.submittedAt);
}

/** 从已缓存的各课程视频列表里找标题：任务列表不为了一个标题再发请求。 */
export function cachedVideo(queryClient: QueryClient, videoId: string): Video | undefined {
  for (const [, data] of queryClient.getQueriesData<Video[]>({ queryKey: ["videos"] })) {
    const hit = Array.isArray(data) ? data.find((video) => video.id === videoId) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

export function useCachedVideoTitle(videoId: string | undefined): string | undefined {
  const queryClient = useQueryClient();
  return videoId ? cachedVideo(queryClient, videoId)?.title : undefined;
}

/** 每秒走一次的「现在」，给「已用时」用；没有任务时不起定时器。 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export type TaskNotice = TaskMeta & { id: number; ok: boolean };

/**
 * 任务跑完（成功或失败）时回调。只报「开始时还在 pending、现在结束了」的那次转换，
 * 应用启动时缓存里早已结束的旧 mutation 不会被报。
 */
export function useTaskCompletion(onDone: (notice: TaskNotice) => void) {
  const queryClient = useQueryClient();
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    const cache = queryClient.getMutationCache();
    const pending = new Set<number>();
    // 订阅前就已经在跑的任务也要记上，否则它跑完时会被当成「不认识的旧任务」漏报。
    for (const mutation of cache.getAll()) {
      if (mutation.state.status === "pending" && readTaskMeta(mutation.options.meta)) {
        pending.add(mutation.mutationId);
      }
    }
    return cache.subscribe((event) => {
      if (event.type !== "updated" && event.type !== "added") return;
      const mutation = event.mutation;
      if (!mutation) return;
      const task = readTaskMeta(mutation.options.meta);
      if (!task) return;
      const status = mutation.state.status;
      if (status === "pending") {
        pending.add(mutation.mutationId);
        return;
      }
      if (!pending.delete(mutation.mutationId)) return;
      if (status === "success" || status === "error") {
        onDoneRef.current({ ...task, id: mutation.mutationId, ok: status === "success" });
      }
    });
  }, [queryClient]);
}
