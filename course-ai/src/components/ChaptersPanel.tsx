import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";

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
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2">
        <span className="text-sm text-[var(--text-muted)]">重点章节</span>
        <Button
          size="sm"
          variant="outline"
          disabled={generate.isPending}
          onClick={() => generate.mutate()}
        >
          {generate.isPending
            ? "生成中…"
            : chapters.length
              ? "重新生成"
              : "AI 生成"}
        </Button>
      </div>
      {generate.isError && (
        <p className="px-3 py-2 text-xs text-red-400">
          {String(generate.error)}
        </p>
      )}
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {chapters.length === 0 && (
          <p className="text-sm text-[var(--text-faint)]">还没有章节，点右上角「AI 生成」。</p>
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
    </div>
  );
}
