import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";
import { PanelActions } from "./PanelActions";

export function ChaptersPanel({ videoId }: { videoId: string }) {
  const qc = useQueryClient();
  const requestSeek = usePlayer((s) => s.requestSeek);
  const { data: chapters = [] } = useQuery({
    queryKey: ["chapters", videoId],
    queryFn: () => ipc.ai.getChapters(videoId),
  });
  const generate = useMutation({
    mutationFn: () => ipc.ai.generate(videoId, "chapters"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["chapters", videoId] }),
  });

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pt-2 text-sm text-[var(--text-muted)]">重点章节</div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-12 pt-1">
        {generate.isError && (
          <p className="pb-1 text-xs text-[var(--status-err)]">{String(generate.error)}</p>
        )}
        {chapters.length === 0 && (
          <p className="text-sm text-[var(--text-faint)]">
            还没有章节，字幕就绪后会自动生成，也可点右下角重新生成。
          </p>
        )}
        {chapters.map((c) => (
          <button
            key={c.id}
            onClick={() => requestSeek(c.start_ms)}
            className="block w-full rounded px-2 py-2 text-left hover:bg-[var(--surface-card)]"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-primary">{formatMs(c.start_ms)}</span>
              <span className="text-sm">{c.title}</span>
            </div>
            {c.summary && (
              <p className="mt-0.5 text-xs text-[var(--text-faint)]">{c.summary}</p>
            )}
          </button>
        ))}
      </div>
      <PanelActions
        onRegenerate={() => generate.mutate()}
        regenerating={generate.isPending}
        hasContent={chapters.length > 0}
      />
    </div>
  );
}
