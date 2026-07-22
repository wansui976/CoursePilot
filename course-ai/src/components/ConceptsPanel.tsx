import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Lightbulb, Sparkles } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Skeleton } from "@/components/ui/skeleton";

/** 课程级「知识点」面板：分析并浏览本课程概念，点出处跨视频跳转。 */
export function ConceptsPanel({
  courseId,
  courseName,
  onClose,
  onJump,
}: {
  courseId: string;
  courseName?: string;
  onClose: () => void;
  onJump: (videoId: string, startMs: number) => void;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: concepts = [], isLoading } = useQuery({
    queryKey: ["course-concepts", courseId],
    queryFn: () => ipc.concepts.list(courseId),
  });

  const analyze = useMutation({
    mutationFn: () => ipc.concepts.analyze(courseId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["course-concepts", courseId] }),
  });

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-[var(--surface-app)] text-[var(--text-normal)]">
      <header className="flex flex-none items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-header)] px-7 py-4">
        <button aria-label="返回" onClick={onClose} className="ca-icon-btn ca-touch-44 ml-0">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text-strong)]">
          <Lightbulb className="h-4 w-4" />
          知识点{courseName ? ` · ${courseName}` : ""}
        </h2>
        {concepts.length > 0 && (
          <button
            onClick={() => analyze.mutate()}
            disabled={analyze.isPending}
            className="ca-touch-44 ml-auto rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--text-normal)] transition hover:bg-[var(--surface-card-hover)] disabled:opacity-60"
          >
            {analyze.isPending ? "分析中…" : "重新分析"}
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-2xl space-y-3">
          {analyze.isError && (
            <ErrorNote error={analyze.error} onRetry={() => analyze.mutate()} />
          )}

          {isLoading ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          ) : concepts.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-2 pt-10 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/12 text-primary">
                <Sparkles className="h-6 w-6" />
              </span>
              <p className="max-w-[320px] text-sm leading-relaxed text-[var(--text-muted)]">
                还没有分析过这门课的知识点。分析会读取各节字幕，用 AI 抽取主题级概念，
                可能需要一会儿。
              </p>
              <button
                onClick={() => analyze.mutate()}
                disabled={analyze.isPending}
                className="ca-touch-44 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60"
              >
                {analyze.isPending ? "分析中…" : "分析本课程概念"}
              </button>
            </div>
          ) : (
            <ul className="space-y-2">
              {concepts.map((c) => (
                <li
                  key={c.id}
                  className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)]"
                >
                  <button
                    onClick={() => setExpanded((e) => (e === c.id ? null : c.id))}
                    aria-expanded={expanded === c.id}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-[var(--surface-card-hover)]"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-strong)]">
                      {c.name}
                    </span>
                    <span className="flex-none rounded-full bg-[var(--surface-card-active)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
                      {c.occurrences.length}
                    </span>
                  </button>
                  {expanded === c.id && (
                    <div className="border-t border-[var(--border-subtle)] px-2 py-1.5">
                      {c.occurrences.map((o) => (
                        <button
                          key={`${o.video_id}-${o.start_ms}`}
                          onClick={() => onJump(o.video_id, o.start_ms)}
                          className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-[var(--surface-card-hover)]"
                        >
                          <span className="mr-1.5 text-[var(--text-faint)]">{o.video_title} ·</span>
                          <span className="text-primary">{formatMs(o.start_ms)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
