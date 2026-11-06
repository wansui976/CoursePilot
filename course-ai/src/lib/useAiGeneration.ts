import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { taskMeta } from "@/lib/backgroundTasks";
import { qk } from "@/lib/queryKeys";
import { ipc } from "@/lib/ipc";
import type { QuizStyle } from "@/lib/types";

/** 出题的附加选项：风格、是否接在已有题目后面。其余产物不带。 */
export type GenerateOptions = { style?: QuizStyle; append?: boolean };

export type GeneratedArtifact = "summary" | "chapters" | "quiz" | "mindmap" | "highlights";

type GenerationSnapshot = {
  id: number;
  status: "idle" | "pending" | "error" | "success";
  submittedAt: number;
  error: unknown;
};

const starting = new Set<string>();

function generationKey(videoId: string, artifact: GeneratedArtifact) {
  return ["ai-generation", videoId, artifact] as const;
}

function startingKey(videoId: string, artifact: GeneratedArtifact) {
  return `${videoId}\u0000${artifact}`;
}

/**
 * Keeps paid artifact generation visible across panel unmounts. React Query keeps
 * the mutation running after its observer disappears; reading MutationCache is
 * what prevents a remounted panel from presenting a second active Generate button.
 */
export function useAiGeneration(videoId: string, artifact: GeneratedArtifact) {
  const queryClient = useQueryClient();
  const mutationKey = generationKey(videoId, artifact);
  const guardKey = startingKey(videoId, artifact);
  const snapshots = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => ({
      id: mutation.mutationId,
      status: mutation.state.status,
      submittedAt: mutation.state.submittedAt,
      error: mutation.state.error,
    }),
  });
  const latest = snapshots.reduce<GenerationSnapshot | undefined>(
    (current, snapshot) =>
      !current ||
      snapshot.submittedAt > current.submittedAt ||
      (snapshot.submittedAt === current.submittedAt && snapshot.id > current.id)
        ? snapshot
        : current,
    undefined,
  );

  const mutation = useMutation<void, unknown, GenerateOptions | undefined>({
    mutationKey,
    meta: taskMeta(artifact, { videoId }),
    mutationFn: (options) =>
      options ? ipc.ai.generate(videoId, artifact, options) : ipc.ai.generate(videoId, artifact),
    gcTime: Infinity,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.artifact(artifact, videoId) });
    },
    onSettled: () => {
      starting.delete(guardKey);
    },
  });

  // start 不带参数：它常被直接交给 onClick，带参数的话点击事件会被当成选项传下去。
  function start() {
    startWith(undefined);
  }

  /** 出题用：带上风格、是否追加一套。 */
  function startWith(options: GenerateOptions | undefined) {
    if (
      latest?.status === "pending" ||
      starting.has(guardKey) ||
      queryClient
        .getMutationCache()
        .findAll({ mutationKey, exact: true, status: "pending" }).length > 0
    ) {
      return;
    }
    starting.add(guardKey);
    mutation.mutate(options);
  }

  return {
    start,
    startWith,
    isPending: latest?.status === "pending",
    isError: latest?.status === "error",
    error: latest?.status === "error" ? latest.error : null,
  };
}
