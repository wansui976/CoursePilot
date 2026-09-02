import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { invalidateStaleArtifacts } from "@/lib/useStaleArtifacts";

export type GeneratedArtifact = "summary" | "chapters" | "quiz" | "mindmap";

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

  const mutation = useMutation<void, unknown, void>({
    mutationKey,
    mutationFn: () => ipc.ai.generate(videoId, artifact),
    gcTime: Infinity,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [artifact, videoId] });
      invalidateStaleArtifacts(queryClient, videoId);
    },
    onSettled: () => {
      starting.delete(guardKey);
    },
  });

  function start() {
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
    mutation.mutate();
  }

  return {
    start,
    isPending: latest?.status === "pending",
    isError: latest?.status === "error",
    error: latest?.status === "error" ? latest.error : null,
  };
}
