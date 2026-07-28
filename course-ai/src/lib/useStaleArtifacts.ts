import { useQuery, type QueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";

/** 产物名（与后端的 TRACKED_ARTIFACTS 一致）。 */
export type Artifact = "chapters" | "summary" | "notes" | "quiz" | "mindmap";

export const staleArtifactsKey = (videoId: string) => ["ai-stale", videoId] as const;

/**
 * 哪些 AI 产物是基于旧讲稿生成的。
 *
 * 只标记、不自动重跑：重跑要花钱，跑不跑由用户定。没有指纹记录的产物后端不会返回
 * （那是这套记录上线之前生成的，无从判断），所以升级后不会一屏都是「已过期」。
 */
export function useStaleArtifacts(videoId: string) {
  const { data } = useQuery({
    queryKey: staleArtifactsKey(videoId),
    queryFn: () => ipc.ai.staleArtifacts(videoId),
    // 讲稿变化由调用方显式失效（改字幕、重跑纠错、重新生成），不靠轮询。
    staleTime: Infinity,
  });
  return new Set<string>(data ?? []);
}

/** 讲稿或产物变化后调用，让「已过期」标记重新算一次。 */
export function invalidateStaleArtifacts(qc: QueryClient, videoId: string) {
  void qc.invalidateQueries({ queryKey: staleArtifactsKey(videoId) });
}
