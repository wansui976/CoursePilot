import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, X } from "lucide-react";
import { ipc, type ReviewChapter, type ReviewOutcome, type ReviewProgress } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { taskMeta } from "@/lib/backgroundTasks";
import { renderMarkdown, type SourceRef } from "@/lib/renderMarkdown";
import { formatMs, formatRelativeTime } from "@/lib/time";
import { useContainerWidth } from "@/lib/useContainerWidth";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { Select } from "@/ui/select";
import { Skeleton } from "@/ui/skeleton";

const NO_SEEK = () => {};

const generateKey = (courseId: string) => ["review-book-generate", courseId] as const;

/** 按「## 小节」切开，每节单独渲染（出处标签的视频名按节重新显示一次）。 */
function splitSections(markdown: string): string[] {
  return markdown.split(/\n(?=## )/);
}

/**
 * 课程知识页的「复习资料」：整门课的笔记按知识逻辑重排成的分章复习资料。
 *
 * 生成在后台跑（React Query 的 mutation，切走页面照常跑，后台任务列表里看得到）；
 * 每写完一章就刷新一次，写好的章节立刻能读。应用重开后若后端还在跑，按课程 id 轮询接上。
 */
export function ReviewBookPanel({
  courseId,
  onJump,
}: {
  courseId: string;
  onJump: (videoId: string, startMs: number) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wide = useContainerWidth(rootRef) === "wide";
  const [progress, setProgress] = useState<ReviewProgress | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);

  const bookKey = qk.reviewBook(courseId);
  const key = generateKey(courseId);
  const pendingHere =
    useMutationState({ filters: { mutationKey: key, exact: true, status: "pending" } }).length > 0;
  // 应用重开过、这一端没有对应的 mutation：问后端是不是还在跑，在跑就轮询到它结束。
  const { data: runningInBackend } = useQuery({
    queryKey: [...bookKey, "running"],
    queryFn: () => ipc.reviewBook.running(courseId),
    enabled: !pendingHere,
    refetchInterval: (query) => (query.state.data ? 3000 : false),
  });
  const running = pendingHere || Boolean(runningInBackend);
  const {
    data: book,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: bookKey,
    queryFn: () => ipc.reviewBook.get(courseId),
    refetchInterval: runningInBackend && !pendingHere ? 3000 : false,
  });

  // 后台那一趟跑完了：最后几章是在两次轮询之间写完的，再取一次。
  const wasRunningInBackend = useRef(false);
  useEffect(() => {
    if (wasRunningInBackend.current && !runningInBackend) void queryClient.invalidateQueries({ queryKey: bookKey });
    wasRunningInBackend.current = Boolean(runningInBackend);
  }, [runningInBackend, queryClient, bookKey]);

  const generate = useMutation<ReviewOutcome, unknown, number | null>({
    mutationKey: key,
    meta: taskMeta("review-book", { courseId }),
    mutationFn: (rewrite) => {
      setProgress(null);
      return ipc.reviewBook.generate(courseId, rewrite, (next) => {
        setProgress(next);
        // 每写完一章就刷新，写好的章节马上能读。
        if (next.stage === "chapters" && next.done > 0) void queryClient.invalidateQueries({ queryKey: bookKey });
      });
    },
    onSuccess: (outcome) =>
      setAnnouncement(
        outcome.canceled
          ? t("reviewBook.canceled")
          : outcome.failed > 0
            ? t("reviewBook.finishedWithFailures", { written: outcome.written, failed: outcome.failed })
            : outcome.written > 0
              ? t("reviewBook.finished", { count: outcome.written })
              : t("reviewBook.upToDate"),
      ),
    onSettled: () => {
      setProgress(null);
      void queryClient.invalidateQueries({ queryKey: bookKey });
    },
  });

  function start(rewrite: number | null = null) {
    if (running) return;
    setAnnouncement("");
    generate.mutate(rewrite);
  }

  const chapters = useMemo(() => book?.chapters ?? [], [book]);
  const staleCount = chapters.filter((chapter) => chapter.stale).length;
  const failedCount = chapters.filter((chapter) => chapter.error && !chapter.content_md).length;
  const unwritten = chapters.some((chapter) => !chapter.content_md);
  const needsUpdate = Boolean(book?.outline_stale) || staleCount > 0 || failedCount > 0 || unwritten;

  // 目录高亮：滚动时取「顶端已经越过」的最后一章。
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || chapters.length === 0) return;
    const onScroll = () => {
      const top = scroller.getBoundingClientRect().top + 96;
      let current = 0;
      chapters.forEach((chapter, index) => {
        const el = document.getElementById(`review-chapter-${chapter.idx}`);
        if (el && el.getBoundingClientRect().top <= top) current = index;
      });
      setActiveIdx(current);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [chapters]);

  function scrollToChapter(index: number) {
    setActiveIdx(index);
    const reduceMotion =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document
      .getElementById(`review-chapter-${chapters[index]?.idx}`)
      ?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }

  /**
   * 出处标签。同一节里接连出自同一个视频时只写时间，换了视频才写视频名——一节十来条要点
   * 条条挂着同一个长视频名，正文就淹没了。完整名字始终在 title / 读屏标签里。
   * renderMarkdown 按文档顺序同步渲染，所以「上一个标签是哪个视频」记在闭包里就行；每节一个闭包。
   */
  function sourceRenderer(chapter: ReviewChapter) {
    let lastVideo = "";
    return (refs: SourceRef[], key: string): ReactNode => (
      <span key={key} className="ca-review-sources">
        {refs.map((ref, index) => {
          const source = chapter.sources[ref.id];
          if (!source) return null;
          const ms = ref.ms ?? source.start_ms;
          const time = ms != null ? formatMs(ms) : "";
          const label = t("reviewBook.jumpToSource", { title: source.video_title, time });
          const showTitle = source.video_id !== lastVideo || !time;
          lastVideo = source.video_id;
          return (
            <button
              key={`${ref.id}-${index}`}
              type="button"
              className="ca-review-source"
              onClick={() => onJump(source.video_id, ms ?? 0)}
              aria-label={label}
              title={label}
            >
              {showTitle && <span className="ca-review-source-title">{source.video_title}</span>}
              {time && <span className="tabular-nums">{time}</span>}
            </button>
          );
        })}
      </span>
    );
  }

  const progressText = !progress
    ? pendingHere
      ? t("reviewBook.preparing")
      : t("reviewBook.runningElsewhere")
    : progress.stage === "outline"
      ? t("reviewBook.outlining")
      : t("reviewBook.writing", { done: progress.done, total: progress.total });
  const progressPercent =
    progress?.stage === "chapters" && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 8;

  return (
    <div ref={rootRef} className="relative flex min-h-0 flex-1">
      {wide && chapters.length > 0 && (
        <nav
          aria-label={t("reviewBook.toc")}
          className="w-60 flex-none overflow-y-auto border-r border-[var(--border-subtle)] px-3 py-5"
        >
          <p className="ca-nav-label px-2.5 pb-1">{t("reviewBook.toc")}</p>
          <ol className="space-y-0.5">
            {chapters.map((chapter, index) => (
              <li key={chapter.idx}>
                <button
                  type="button"
                  onClick={() => scrollToChapter(index)}
                  aria-current={activeIdx === index ? "location" : undefined}
                  className={`flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] leading-5 transition-colors ${
                    activeIdx === index
                      ? "bg-[var(--surface-card-active)] font-medium text-[var(--text-strong)]"
                      : "text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
                  }`}
                >
                  <span className="flex-none tabular-nums text-[var(--text-faint)]">{index + 1}</span>
                  <span className="min-w-0 flex-1">{chapter.title}</span>
                  {(chapter.stale || (chapter.error && !chapter.content_md)) && (
                    <span aria-hidden="true" className="h-1.5 w-1.5 flex-none self-center rounded-full bg-[var(--status-warn)]" />
                  )}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}

      <div ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-7 sm:py-6">
        <main className="mx-auto max-w-3xl space-y-6">
          <p className="sr-only" aria-live="polite">
            {announcement}
          </p>

          {running && (
            <div role="status" className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 truncate text-sm font-medium text-[var(--text-strong)]">{progressText}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void ipc.reviewBook.cancel(courseId)}
                  className="ca-touch-44 flex-none gap-1"
                >
                  <X className="h-3.5 w-3.5" />
                  {t("reviewBook.cancel")}
                </Button>
              </div>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-panel)]">
                <div
                  className="ca-fill-grad h-full rounded-full transition-[width] duration-300 ease-out"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}
          {generate.isError && <ErrorNote error={generate.error} onRetry={() => start()} />}
          {!running && announcement && (
            <p className="text-sm text-[var(--text-muted)]">{announcement}</p>
          )}

          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-28 w-full rounded-xl" />
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          ) : isError ? (
            <ErrorNote error={error} onRetry={() => void refetch()} />
          ) : chapters.length === 0 ? (
            !running && (
              <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 px-2 text-center">
                <h2 className="text-base font-semibold text-[var(--text-strong)]">{t("reviewBook.emptyTitle")}</h2>
                <p className="max-w-[360px] text-sm leading-relaxed text-[var(--text-muted)]">
                  {book && book.videos_with_notes === 0 ? t("reviewBook.noNotesDesc") : t("reviewBook.emptyDesc")}
                </p>
                {book && book.videos_with_notes > 0 && (
                  <>
                    <Button type="button" variant="primary" onClick={() => start()} className="ca-touch-44">
                      {t("reviewBook.generate")}
                    </Button>
                    <p className="max-w-[360px] text-xs leading-relaxed text-[var(--text-faint)]">
                      {t("reviewBook.costHint")}
                    </p>
                  </>
                )}
              </div>
            )
          ) : (
            <>
              <section
                aria-labelledby="review-book-title"
                className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4 shadow-[var(--shadow-card)] sm:p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 id="review-book-title" className="text-base font-semibold text-[var(--text-strong)]">
                      {book?.title ?? t("reviewBook.tabReview")}
                    </h2>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                      {t("reviewBook.meta", { chapters: chapters.length, videos: book?.videos_with_notes ?? 0 })}
                      {book?.generated_at != null &&
                        ` · ${t("reviewBook.generatedAt", { time: formatRelativeTime(book.generated_at) })}`}
                    </p>
                  </div>
                  {needsUpdate && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => start()}
                      disabled={running}
                      className="ca-touch-44 gap-1.5"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
                      {t("reviewBook.update")}
                    </Button>
                  )}
                </div>
                {(book?.outline_stale || staleCount > 0 || failedCount > 0) && (
                  <p className="mt-3 rounded-lg border border-[var(--status-warn)]/40 bg-[var(--status-warn-bg)] px-3 py-2 text-xs leading-5 text-[var(--status-warn)]">
                    {book?.outline_stale
                      ? t("reviewBook.outlineStale")
                      : [
                          staleCount > 0 ? t("reviewBook.staleChapters", { count: staleCount }) : "",
                          failedCount > 0 ? t("reviewBook.failedChapters", { count: failedCount }) : "",
                        ].join("")}
                  </p>
                )}
                {(book?.videos_without_notes.length ?? 0) > 0 && (
                  <p className="mt-3 text-xs leading-5 text-[var(--text-faint)]">
                    {t("reviewBook.missingNotes", {
                      count: book!.videos_without_notes.length,
                      titles: book!.videos_without_notes.join("、"),
                    })}
                  </p>
                )}
              </section>

              {!wide && (
                <Select
                  aria-label={t("reviewBook.jumpToChapter")}
                  value={String(activeIdx)}
                  onChange={(event) => scrollToChapter(Number(event.target.value))}
                >
                  {chapters.map((chapter, index) => (
                    <option key={chapter.idx} value={index}>
                      {`${index + 1}. ${chapter.title}`}
                    </option>
                  ))}
                </Select>
              )}

              {chapters.map((chapter, index) => {
                const failed = chapter.error && !chapter.content_md;
                return (
                  <section
                    key={chapter.idx}
                    id={`review-chapter-${chapter.idx}`}
                    aria-labelledby={`review-chapter-title-${chapter.idx}`}
                    className="scroll-mt-4 border-t border-[var(--border-subtle)] pt-6 first-of-type:border-t-0"
                  >
                    <p className="text-xs font-medium text-[var(--text-faint)]">
                      {t("reviewBook.chapterLabel", { n: index + 1 })}
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      <h2
                        id={`review-chapter-title-${chapter.idx}`}
                        className="min-w-0 flex-1 text-lg font-semibold leading-snug text-[var(--text-strong)]"
                      >
                        {chapter.title}
                        {chapter.stale && (
                          <span className="ml-2 inline-block rounded-full border border-[var(--status-warn)]/40 px-2 align-middle text-[11px] font-medium leading-5 text-[var(--status-warn)]">
                            {t("reviewBook.staleBadge")}
                          </span>
                        )}
                      </h2>
                      {chapter.content_md && (
                        <button
                          type="button"
                          onClick={() => start(chapter.idx)}
                          disabled={running}
                          aria-label={t("reviewBook.rewrite")}
                          title={t("reviewBook.rewrite")}
                          className="ca-icon-btn ca-touch-44 flex-none"
                        >
                          <RefreshCw className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                    {chapter.intro && (
                      <p className="mt-1.5 text-sm leading-relaxed text-[var(--text-muted)]">{chapter.intro}</p>
                    )}
                    {chapter.content_md ? (
                      <div className="ca-reading ca-review-chapter mt-3">
                        {splitSections(chapter.content_md).map((part, partIndex) => (
                          <Fragment key={partIndex}>
                            {renderMarkdown(part, NO_SEEK, undefined, { renderSource: sourceRenderer(chapter) })}
                          </Fragment>
                        ))}
                      </div>
                    ) : failed ? (
                      <div className="mt-3 rounded-lg border border-[var(--status-err)]/40 px-3 py-2.5">
                        <p className="text-sm leading-relaxed text-[var(--status-err)]">
                          {t("reviewBook.chapterFailed", { error: chapter.error })}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => start(chapter.idx)}
                          disabled={running}
                          className="ca-touch-44 mt-2"
                        >
                          {t("reviewBook.retry")}
                        </Button>
                      </div>
                    ) : running ? (
                      <div className="mt-4 space-y-2.5" aria-hidden="true">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-11/12" />
                        <Skeleton className="h-4 w-4/5" />
                      </div>
                    ) : (
                      <p className="mt-3 text-sm text-[var(--text-muted)]">{t("reviewBook.notWritten")}</p>
                    )}
                  </section>
                );
              })}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
