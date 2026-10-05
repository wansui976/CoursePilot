import { queryOptions } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";

/**
 * 被多处组件共同读取的查询。同一份缓存只该有一种取法：键、取数函数和轮询策略
 * 集中在这里，调用方按需展开再补 `staleTime` / `enabled` 这类观察者级选项。
 * 只有一个读取点的查询留在组件里，用 `qk` 取键即可。
 */
export const queries = {
  courses: () =>
    queryOptions({ queryKey: qk.courses(), queryFn: ipc.courses.list }),

  videos: (courseId: string | null) =>
    queryOptions({
      queryKey: qk.videos.list(courseId),
      queryFn: () => ipc.videos.list(courseId!),
      enabled: !!courseId,
    }),

  /** 讲稿在 ASR 跑完前是空的：空时每 2 秒轮询，拿到内容就停。 */
  transcripts: (videoId: string) =>
    queryOptions({
      queryKey: qk.transcripts(videoId),
      queryFn: () => ipc.transcripts.list(videoId),
      refetchInterval: (query) =>
        query.state.data && query.state.data.length > 0 ? false : 2000,
    }),

  chapters: (videoId: string) =>
    queryOptions({
      queryKey: qk.artifact("chapters", videoId),
      queryFn: () => ipc.ai.getChapters(videoId),
    }),
  summary: (videoId: string) =>
    queryOptions({
      queryKey: qk.artifact("summary", videoId),
      queryFn: () => ipc.ai.getSummary(videoId),
    }),
  notes: (videoId: string) =>
    queryOptions({
      queryKey: qk.artifact("notes", videoId),
      queryFn: () => ipc.ai.getNotes(videoId),
    }),
  quiz: (videoId: string) =>
    queryOptions({
      queryKey: qk.artifact("quiz", videoId),
      queryFn: () => ipc.ai.getQuiz(videoId),
    }),
};
