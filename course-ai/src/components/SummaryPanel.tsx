import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { renderMarkdown } from "@/lib/renderMarkdown";
import { usePlayer } from "@/stores/player";
import { TextSkeleton } from "@/components/ui/skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { PanelActions } from "./PanelActions";

export function SummaryPanel({ videoId }: { videoId: string }) {
  const qc = useQueryClient();
  const requestSeek = usePlayer((s) => s.requestSeek);
  const { data: summary, isLoading } = useQuery({
    queryKey: ["summary", videoId],
    queryFn: () => ipc.ai.getSummary(videoId),
  });
  const generate = useMutation({
    mutationFn: () => ipc.ai.generate(videoId, "summary"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["summary", videoId] }),
  });

  return (
    <div className="relative flex max-h-[45%] shrink-0 flex-col border-b border-[var(--border-subtle)]">
      <div className="shrink-0 px-3 pt-2 text-sm text-[var(--text-muted)]">整体摘要</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-12 pt-1">
        {generate.isError && (
          <ErrorNote
            className="mb-2"
            error={generate.error}
            onRetry={() => generate.mutate()}
          />
        )}
        {isLoading ? (
          <TextSkeleton lines={5} className="p-0" />
        ) : summary ? (
          renderMarkdown(summary, requestSeek)
        ) : (
          <p className="text-sm text-[var(--text-faint)]">
            还没有摘要，字幕就绪后会自动生成，也可点右下角重新生成。
          </p>
        )}
      </div>
      <PanelActions
        onRegenerate={() => generate.mutate()}
        regenerating={generate.isPending}
        hasContent={!!summary}
      />
    </div>
  );
}
