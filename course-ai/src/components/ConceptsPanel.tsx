import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import {
  Brain,
  ChevronDown,
  ChevronLeft,
  FileText,
  Lightbulb,
  MessageCircle,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import {
  ipc,
  type AnalyzeProgress,
  type CourseConcept,
  type CourseKnowledgeGroup,
} from "@/lib/ipc";
import { formatMs, formatRelativeTime } from "@/lib/time";
import { displayTitle } from "@/lib/videoTitle";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Skeleton } from "@/components/ui/skeleton";
import { renderMarkdown } from "@/lib/renderMarkdown";
import { ReviewSession } from "./ReviewSession";
import { CourseChatPanel } from "./CourseChatPanel";

// 知识点解释跨多个视频，没有单一当前视频可跳转；解释里也不含 [mm:ss]，故用空 seek。
const NO_SEEK = () => {};

export type ConceptNavigationState = {
  conceptId: string;
  conceptName: string;
  search: string;
  expandedConceptId: string | null;
  scrollTop: number;
};

function sourceStats(concept: CourseConcept, t: TFunction) {
  const videos = new Set(concept.occurrences.map((occurrence) => occurrence.video_id)).size;
  return t("concepts.videoSources", { count: videos, occurrences: concept.occurrences.length });
}

function containsQuery(value: string | null | undefined, query: string) {
  return value?.toLocaleLowerCase().includes(query) ?? false;
}

/**
 * 把命中片段包成 <mark>：query 已是小写，按原文下标切片以保留原始大小写。
 * 大小写折叠会改变长度的极端场景（如 İ）下下标不再对齐，直接放弃高亮而不是切错字。
 */
function highlightQuery(text: string, query: string): ReactNode {
  if (!query) return text;
  const lowered = text.toLocaleLowerCase();
  if (lowered.length !== text.length) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (let at = lowered.indexOf(query); at !== -1; at = lowered.indexOf(query, cursor)) {
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(
      <mark key={at} className="rounded bg-[var(--accent-weak-2)] text-[var(--accent-text)]">
        {text.slice(at, at + query.length)}
      </mark>,
    );
    cursor = at + query.length;
  }
  if (cursor === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function filterGroups(groups: CourseKnowledgeGroup[], query: string) {
  if (!query) return groups;
  return groups
    .map((group) => {
      const groupMatches = containsQuery(group.title, query) || containsQuery(group.summary, query);
      const concepts = groupMatches
        ? group.concepts
        : group.concepts.filter(
            (concept) =>
              containsQuery(concept.name, query) ||
              containsQuery(concept.summary, query) ||
              containsQuery(concept.explanation, query) ||
              concept.occurrences.some(
                (occurrence) =>
                  containsQuery(occurrence.video_title, query) ||
                  containsQuery(occurrence.excerpt, query),
              ),
          );
      return { ...group, concepts };
    })
    .filter((group) => group.concepts.length > 0);
}

const SOURCE_PREVIEW_LIMIT = 3;

function ConceptSources({
  concept,
  query,
  onJump,
}: {
  concept: CourseConcept;
  query: string;
  onJump: (videoId: string, startMs: number) => void;
}) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const sourceListId = `concept-sources-${concept.id}`;
  const hasMore = concept.occurrences.length > SOURCE_PREVIEW_LIMIT;
  const occurrences = showAll
    ? concept.occurrences
    : concept.occurrences.slice(0, SOURCE_PREVIEW_LIMIT);

  return (
    <div className="mt-3 border-t border-[var(--border-subtle)] pt-2.5">
      <p className="mb-1 text-xs font-medium text-[var(--text-faint)]">{t("concepts.subtitleEvidence")}</p>
      <ul id={sourceListId} className="divide-y divide-[var(--border-subtle)]">
        {occurrences.map((occurrence) => {
          const sourceKey = `${occurrence.video_id}-${occurrence.start_ms}`;
          const excerpt = occurrence.excerpt?.trim() || null;
          const excerptId = excerpt ? `${sourceListId}-${sourceKey}-excerpt` : undefined;
          return (
            <li key={sourceKey}>
              <button
                type="button"
                onClick={() => onJump(occurrence.video_id, occurrence.start_ms)}
                aria-label={t("concepts.reviewSource", { title: displayTitle(occurrence.video_title), time: formatMs(occurrence.start_ms) })}
                aria-describedby={excerptId}
                className="ca-touch-44 min-h-11 w-full px-1 py-2 text-left transition-colors hover:bg-[var(--surface-card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
              >
                <span className="flex min-w-0 items-baseline gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-normal)]">
                    {highlightQuery(displayTitle(occurrence.video_title), query)}
                  </span>
                  <span className="flex-none font-medium text-primary">
                    {formatMs(occurrence.start_ms)}
                  </span>
                </span>
                {excerpt && (
                  <span
                    id={excerptId}
                    className="mt-0.5 block line-clamp-2 text-xs leading-5 text-[var(--text-muted)]"
                  >
                    {highlightQuery(excerpt, query)}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          aria-expanded={showAll}
          aria-controls={sourceListId}
          className="ca-touch-44 mt-1 inline-flex min-h-11 items-center gap-1 text-xs font-medium text-primary transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ChevronDown
            aria-hidden="true"
            className={`h-3.5 w-3.5 transition-transform ${showAll ? "rotate-180" : ""}`}
          />
          {showAll
            ? t("concepts.collapseSource")
            : t("concepts.expandSource", { count: concept.occurrences.length - SOURCE_PREVIEW_LIMIT })}
        </button>
      )}
    </div>
  );
}

/** 课程级知识页：总览、主题分组、可核验出处与按概念复习。 */
export function ConceptsPanel({
  courseId,
  courseName,
  onClose,
  onJump,
  initialNavigationState,
}: {
  courseId: string;
  courseName?: string;
  onClose: () => void;
  onJump: (
    videoId: string,
    startMs: number,
    navigationState?: ConceptNavigationState,
  ) => void;
  initialNavigationState?: ConceptNavigationState | null;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(
    initialNavigationState?.expandedConceptId ?? null,
  );
  const [search, setSearch] = useState(initialNavigationState?.search ?? "");
  const deferredSearch = useDeferredValue(search);
  const mainScrollRef = useRef<HTMLDivElement>(null);
  const restoredScrollRef = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  // 分析进度（逐视频事件驱动）；null 表示尚未收到进度。
  const [progress, setProgress] = useState<AnalyzeProgress | null>(null);
  // 本轮分析的 requestId，供「取消」定位后台任务。
  const analyzeRequest = useRef<string | null>(null);
  // 正在按概念复习的目标（打开全屏 ReviewSession）。
  const [reviewing, setReviewing] = useState<{ conceptId: string; name: string } | null>(null);
  // 课程 AI 问答抽屉是否展开（背景为整门课的总览+知识点）。
  const [chatOpen, setChatOpen] = useState(false);

  const {
    data: knowledge,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["course-knowledge", courseId],
    queryFn: () => ipc.concepts.get(courseId),
  });

  // 每个概念的待复习卡数（现算），构成 conceptId -> due 映射。
  const {
    data: dueCounts = [],
    isPending: dueCountsPending,
    isError: dueCountsError,
  } = useQuery({
    queryKey: ["srs-concept-due", courseId],
    queryFn: () => ipc.srs.conceptDueCounts(courseId),
  });
  const dueCountByConcept = useMemo(
    () => new Map(dueCounts.map((due) => [due.concept_id, due.due])),
    [dueCounts],
  );

  useEffect(() => {
    if (!initialNavigationState || isLoading || restoredScrollRef.current) return;
    restoredScrollRef.current = true;
    const frame = requestAnimationFrame(() => {
      if (mainScrollRef.current) {
        mainScrollRef.current.scrollTop = initialNavigationState.scrollTop;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [initialNavigationState, isLoading]);

  function invalidateKnowledge() {
    void queryClient.invalidateQueries({ queryKey: ["course-knowledge", courseId] });
    void queryClient.invalidateQueries({ queryKey: ["course-concepts", courseId] });
    void queryClient.invalidateQueries({ queryKey: ["srs-concept-due", courseId] });
  }

  const analyze = useMutation({
    mutationFn: () => {
      const requestId = crypto.randomUUID();
      analyzeRequest.current = requestId;
      setProgress(null);
      return ipc.concepts.analyze(courseId, requestId, setProgress);
    },
    onSuccess: (count) => {
      setAnnouncement(
        count > 0 ? t("concepts.updatedConcepts", { count }) : t("concepts.noConceptsFound"),
      );
      setExpanded(null);
    },
    onError: (error) => {
      if (error instanceof Error && error.message.includes("已取消")) {
        setAnnouncement(t("concepts.analysisCanceled"));
      }
    },
    onSettled: () => {
      analyzeRequest.current = null;
      setProgress(null);
      invalidateKnowledge();
    },
  });

  // 取消进行中的分析：后台循环会在下个视频/片段前停下且不写库。
  function cancelAnalyze() {
    const requestId = analyzeRequest.current;
    if (requestId) void ipc.concepts.cancelAnalyze(requestId);
  }

  // 取消导致的错误不当成失败展示（已在 announcement 提示）。
  const analyzeCancelled =
    analyze.isError &&
    analyze.error instanceof Error &&
    analyze.error.message.includes("已取消");

  const summarize = useMutation({
    mutationFn: () => ipc.concepts.summarize(courseId),
    onSuccess: () => setAnnouncement(t("concepts.summaryGenerated")),
    onSettled: invalidateKnowledge,
  });

  // 为某知识点补复习卡：后端只写入确实落在该概念时间范围内的题目。
  // 后端对已有卡只更新正反面、不动排期，所以重复点不会打乱复习计划。
  const makeCards = useMutation({
    mutationFn: (concept: CourseConcept) => ipc.srs.generateForConcept(courseId, concept.id),
    onSuccess: (count) => {
      setAnnouncement(
        count > 0
          ? t("concepts.madeCards", { count })
          : t("concepts.noCardsAvailable"),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["srs-concept-due", courseId] });
      void queryClient.invalidateQueries({ queryKey: ["srs-count-due"] });
    },
  });

  // 复习结束（或退出）：刷新概念待复习数与仪表盘计数。
  function closeReview() {
    setReviewing(null);
    void queryClient.invalidateQueries({ queryKey: ["srs-concept-due", courseId] });
    void queryClient.invalidateQueries({ queryKey: ["srs-count-due"] });
  }

  const allConcepts = knowledge?.groups.flatMap((group) => group.concepts) ?? [];
  const sourceCount = allConcepts.reduce((total, concept) => total + concept.occurrences.length, 0);
  const topicCount = knowledge?.groups.length ?? 0;
  const query = deferredSearch.trim().toLocaleLowerCase();
  const groups = useMemo(() => filterGroups(knowledge?.groups ?? [], query), [knowledge?.groups, query]);
  const busy = analyze.isPending || summarize.isPending;
  const hasKnowledge = allConcepts.length > 0;
  // 过滤后仍在列的知识点数：搜索时告诉用户命中了多少，而不是只剩下一堆卡片。
  const matchedCount = groups.reduce((total, group) => total + group.concepts.length, 0);
  // 知识点实际覆盖到的视频数。它小于「有字幕的视频数」说明有视频还没被分析过 ——
  // 这种过时只能靠重新分析补上，只更新总结不会凭空长出新知识点。
  const analyzedVideos = new Set(
    allConcepts.flatMap((concept) => concept.occurrences.map((occurrence) => occurrence.video_id)),
  ).size;
  const missingVideos = Math.max(0, (knowledge?.covered_videos ?? 0) - analyzedVideos);
  const dueConcepts = allConcepts.flatMap((concept) => {
    const due = dueCountByConcept.get(concept.id) ?? 0;
    return due > 0 ? [{ concept, due }] : [];
  });
  const totalDue = dueConcepts.reduce((total, item) => total + item.due, 0);
  const nextReview = dueConcepts[0];
  const nextLearnConcept = allConcepts.find((concept) => concept.occurrences.length > 0);
  const nextOccurrence = nextLearnConcept?.occurrences[0];

  function navigationStateFor(concept: CourseConcept): ConceptNavigationState {
    return {
      conceptId: concept.id,
      conceptName: concept.name,
      search,
      expandedConceptId: concept.id,
      scrollTop: mainScrollRef.current?.scrollTop ?? 0,
    };
  }

  function jumpToOccurrence(concept: CourseConcept, videoId: string, startMs: number) {
    onJump(videoId, startMs, navigationStateFor(concept));
  }

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--surface-app)] text-[var(--text-normal)]">
      <header className="flex flex-none items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-header)] px-4 py-3 sm:px-7 sm:py-4">
        <button
          aria-label={t("concepts.backToVideos")}
          onClick={onClose}
          className="ca-icon-btn ca-touch-44 ml-0"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-[var(--text-strong)]">
            <Lightbulb className="h-4 w-4 flex-none" />
            {t("concepts.title")}
          </h1>
          {courseName && (
            <p className="truncate text-xs text-[var(--text-muted)]" title={courseName}>
              {courseName}
            </p>
          )}
        </div>
        {hasKnowledge && (
          <div className="ml-auto flex flex-none items-center gap-2">
            <button
              type="button"
              onClick={() => setChatOpen((open) => !open)}
              aria-label={t("concepts.courseChat")}
              aria-pressed={chatOpen}
              title={t("concepts.courseChatTitle")}
              className={`ca-touch-44 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                chatOpen
                  ? "border-transparent bg-primary !text-white"
                  : "border-[var(--border-subtle)] text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)]"
              }`}
            >
              <MessageCircle className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("concepts.aiChat")}</span>
            </button>
            <button
              type="button"
              onClick={() => analyze.mutate()}
              disabled={busy}
              aria-label={analyze.isPending ? t("concepts.reanalyzing") : t("concepts.reanalyze")}
              title={analyze.isPending ? t("concepts.reanalyzing") : t("concepts.reanalyze")}
              className="ca-touch-44 inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--text-normal)] transition hover:bg-[var(--surface-card-hover)] disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${analyze.isPending ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">{analyze.isPending ? t("concepts.analyzing") : t("concepts.reanalyzeShort")}</span>
            </button>
          </div>
        )}
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div
          ref={mainScrollRef}
          className="min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-7 sm:py-6"
        >
        <main className="mx-auto max-w-4xl space-y-6">
          <p className="sr-only" aria-live="polite">
            {announcement}
          </p>

          {analyze.isPending && (
            <div
              role="status"
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--text-strong)]">{t("concepts.analyzingKnowledge")}</p>
                  <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                    {progress
                      ? `${progress.total ? `${Math.min(progress.done + 1, progress.total)}/${progress.total} · ` : ""}${displayTitle(progress.title)}`
                      : t("concepts.preparing")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={cancelAnalyze}
                  className="ca-touch-44 inline-flex flex-none items-center gap-1 rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--text-normal)] transition hover:bg-[var(--surface-card-hover)]"
                >
                  <X className="h-3.5 w-3.5" />
                  {t("concepts.cancelAnalysis")}
                </button>
              </div>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-panel)]">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                  style={{
                    width: `${progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 8}%`,
                  }}
                />
              </div>
            </div>
          )}
          {analyze.isError && !analyzeCancelled && (
            <ErrorNote error={analyze.error} onRetry={() => analyze.mutate()} />
          )}
          {summarize.isError && (
            <ErrorNote error={summarize.error} onRetry={() => summarize.mutate()} />
          )}

          {isLoading ? (
            <div className="space-y-5" aria-label={t("concepts.loadingKnowledge")}>
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : isError ? (
            <ErrorNote error={error} onRetry={() => refetch()} />
          ) : !hasKnowledge ? (
            <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 px-2 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/12 text-primary">
                <Sparkles className="h-6 w-6" />
              </span>
              <h2 className="text-base font-semibold text-[var(--text-strong)]">{t("concepts.noKnowledge")}</h2>
              <p className="max-w-[340px] text-sm leading-relaxed text-[var(--text-muted)]">
                {t("concepts.noKnowledgeDesc")}
              </p>
              <Button
                type="button"
                variant="primary"
                onClick={() => analyze.mutate()}
                disabled={busy}
                className="ca-touch-44"
              >
                {analyze.isPending ? t("concepts.analyzing") : t("concepts.analyzeCourse")}
              </Button>
            </div>
          ) : (
            <>
              <section
                aria-labelledby="course-knowledge-overview"
                className="border-b border-[var(--border-subtle)] pb-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2
                      id="course-knowledge-overview"
                      className="text-base font-semibold text-[var(--text-strong)]"
                    >
                      {t("concepts.courseOverview")}
                    </h2>
                    {knowledge?.overview ? (
                      <p className="mt-2 max-w-3xl whitespace-pre-wrap text-sm leading-6 text-[var(--text-normal)]">
                        {knowledge.overview}
                      </p>
                    ) : (
                      <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">
                        {t("concepts.knowledgeIndexNote")}
                      </p>
                    )}
                    {knowledge?.generated_at != null && (
                      <p className="mt-2 text-xs text-[var(--text-faint)]">
                        {t("concepts.generatedAt", { time: formatRelativeTime(knowledge.generated_at) })}
                      </p>
                    )}
                    {/* 有总结才提供「只更新总结」；没有总结的过时（快照损坏）走下面的首次生成按钮。 */}
                    {knowledge?.stale && knowledge.overview && (
                      <div className="mt-2 rounded-lg border border-[var(--status-warn)]/40 bg-[var(--status-warn-bg)] px-3 py-2">
                        <p className="text-xs leading-5 text-[var(--status-warn)]">
                          {t("concepts.contentChanged")}
                          {missingVideos > 0
                            ? t("concepts.missingVideos", { count: missingVideos })
                            : t("concepts.noChangeSummaryOnly")}
                        </p>
                        <button
                          type="button"
                          onClick={() => summarize.mutate()}
                          disabled={busy}
                          className="ca-touch-44 mt-1.5 inline-flex items-center gap-1.5 rounded-lg border border-[var(--status-warn)]/50 px-2.5 py-1 text-xs font-medium text-[var(--status-warn)] transition hover:opacity-80 disabled:opacity-60"
                        >
                          <FileText
                            className={`h-3.5 w-3.5 ${summarize.isPending ? "animate-pulse" : ""}`}
                          />
                          {summarize.isPending ? t("concepts.updatingSummary") : t("concepts.updateSummaryOnly")}
                        </button>
                      </div>
                    )}
                  </div>
                  {!knowledge?.overview && (
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={() => summarize.mutate()}
                      disabled={busy}
                      className="ca-touch-44 flex-none gap-1.5"
                    >
                      <FileText className={`h-3.5 w-3.5 ${summarize.isPending ? "animate-pulse" : ""}`} />
                      {summarize.isPending ? t("concepts.generatingSummary") : t("concepts.generateSummary")}
                    </Button>
                  )}
                </div>

                <dl className="mt-4 grid grid-cols-3 divide-x divide-[var(--border-subtle)] border-y border-[var(--border-subtle)] py-3">
                  <div className="min-w-0 px-3 first:pl-0">
                    <dt className="text-xs text-[var(--text-muted)]">{t("concepts.topicsLabel")}</dt>
                    <dd className="mt-1 text-lg font-semibold text-[var(--text-strong)]">{topicCount}</dd>
                  </div>
                  <div className="min-w-0 px-3">
                    <dt className="text-xs text-[var(--text-muted)]">{t("concepts.conceptsLabel")}</dt>
                    <dd className="mt-1 text-lg font-semibold text-[var(--text-strong)]">{allConcepts.length}</dd>
                  </div>
                  <div className="min-w-0 px-3 last:pr-0">
                    <dt className="text-xs text-[var(--text-muted)]">{t("concepts.coveredVideos")}</dt>
                    <dd className="mt-1 truncate text-lg font-semibold text-[var(--text-strong)]">
                      {knowledge?.covered_videos ?? 0}/{knowledge?.total_videos ?? 0}
                    </dd>
                  </div>
                </dl>

                <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[var(--border-subtle)] pt-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-[var(--text-muted)]">{t("concepts.nextStep")}</p>
                    {dueCountsPending ? (
                      <p className="mt-1 text-sm text-[var(--text-faint)]">{t("concepts.loadingReviewPlan")}</p>
                    ) : nextReview ? (
                      <p className="mt-1 truncate text-sm text-[var(--text-strong)]">
                        {t("concepts.reviewFirst", { name: nextReview.concept.name })}
                        <span className="ml-2 text-xs text-[var(--text-muted)]">
                          {t("concepts.courseDueCards", { count: totalDue })}
                        </span>
                      </p>
                    ) : nextLearnConcept && nextOccurrence ? (
                      <p className="mt-1 truncate text-sm text-[var(--text-strong)]">
                        {t("concepts.reviewConcept", { name: nextLearnConcept.name })}
                        <span className="ml-2 text-xs text-[var(--text-muted)]">
                          {dueCountsError ? t("concepts.reviewUnavailable") : t("concepts.noDueCards")}
                        </span>
                      </p>
                    ) : (
                      <p className="mt-1 text-sm text-[var(--text-faint)]">{t("concepts.noNextContent")}</p>
                    )}
                  </div>
                  {!dueCountsPending && nextReview && (
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={() =>
                        setReviewing({
                          conceptId: nextReview.concept.id,
                          name: nextReview.concept.name,
                        })
                      }
                      className="ca-touch-44 flex-none gap-1.5"
                    >
                      <Brain className="h-3.5 w-3.5" />
                      {t("concepts.startReview")}
                    </Button>
                  )}
                  {!dueCountsPending && !nextReview && nextLearnConcept && nextOccurrence && (
                    <button
                      type="button"
                      onClick={() =>
                        jumpToOccurrence(
                          nextLearnConcept,
                          nextOccurrence.video_id,
                          nextOccurrence.start_ms,
                        )
                      }
                      className="ca-touch-44 inline-flex flex-none items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--text-normal)] transition hover:bg-[var(--surface-card-hover)]"
                    >
                      <Play className="h-3.5 w-3.5 text-primary" />
                      {t("concepts.continueLearning")}
                    </button>
                  )}
                </div>
              </section>

              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-faint)]" />
                <input
                  type="search"
                  aria-label={t("concepts.searchKnowledge")}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("concepts.searchPlaceholder")}
                  className="ca-touch-44 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] py-2 pl-9 pr-3 text-sm text-[var(--text-strong)] placeholder:text-[var(--text-faint)] focus:border-primary"
                />
              </div>
              {query && matchedCount > 0 && (
                <p aria-live="polite" className="-mt-4 text-xs text-[var(--text-muted)]">
                  {t("concepts.searchResults", { matched: matchedCount, total: allConcepts.length, groups: groups.length })}
                </p>
              )}

              {groups.length === 0 ? (
                <div className="py-10 text-center text-sm text-[var(--text-muted)]">
                  {t("concepts.noSearchResults", { query: search.trim() })}
                </div>
              ) : (
                <div className="space-y-7">
                  {/* 主题标题由模型生成，可能重复；key 与 DOM id 用序号，避免同名主题互相顶掉。 */}
                  {groups.map((group, index) => (
                    <section key={`${index}-${group.title}`} aria-labelledby={`knowledge-topic-${index}`}>
                      <div className="mb-2 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h2
                            id={`knowledge-topic-${index}`}
                            className="text-sm font-semibold text-[var(--text-strong)]"
                          >
                            {highlightQuery(group.title, query)}
                          </h2>
                          {group.summary && (
                            <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                              {highlightQuery(group.summary, query)}
                            </p>
                          )}
                        </div>
                        <span className="flex-none text-xs text-[var(--text-faint)]">
                          {t("concepts.conceptCount", { count: group.concepts.length })}
                        </span>
                      </div>

                      <ul className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] divide-y divide-[var(--border-subtle)]">
                        {group.concepts.map((concept) => {
                          const isExpanded = expanded === concept.id;
                          const due = dueCountByConcept.get(concept.id) ?? 0;
                          const detailId = `concept-detail-${concept.id}`;
                          return (
                            <li key={concept.id}>
                              <div className="flex min-w-0 items-stretch gap-1 pr-2">
                                <button
                                  type="button"
                                  onClick={() => setExpanded((value) => (value === concept.id ? null : concept.id))}
                                  aria-expanded={isExpanded}
                                  aria-controls={detailId}
                                  className={`flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left transition hover:bg-[var(--surface-card-hover)] ${
                                    isExpanded ? "bg-[var(--accent-weak)]" : ""
                                  }`}
                                >
                                  <span className="min-w-0 flex-1">
                                    <span className="block break-words text-sm font-medium text-[var(--text-strong)]">
                                      {highlightQuery(concept.name, query)}
                                    </span>
                                    {concept.summary && (
                                      <span className="mt-1 block line-clamp-1 text-xs leading-5 text-[var(--text-muted)]">
                                        {highlightQuery(concept.summary, query)}
                                      </span>
                                    )}
                                    <span className="mt-1 block text-xs text-[var(--text-faint)]">
                                      {sourceStats(concept, t)}
                                    </span>
                                  </span>
                                  <ChevronDown
                                    className={`h-4 w-4 flex-none text-[var(--text-muted)] transition-transform ${
                                      isExpanded ? "rotate-180" : ""
                                    }`}
                                  />
                                </button>
                                {due > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => setReviewing({ conceptId: concept.id, name: concept.name })}
                                    className="ca-touch-44 my-auto inline-flex flex-none items-center gap-1 rounded-lg bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary transition hover:bg-primary hover:!text-white"
                                  >
                                    <Brain className="h-3.5 w-3.5" />
                                    {t("concepts.reviewDue", { count: due })}
                                  </button>
                                )}
                              </div>
                              {isExpanded && (
                                <div
                                  id={detailId}
                                  role="region"
                                  aria-label={t("concepts.conceptExplanation", { name: concept.name })}
                                  className="border-t border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-3"
                                >
                                  {concept.explanation ? (
                                    <div className="text-sm leading-6 text-[var(--text-normal)]">
                                      {renderMarkdown(concept.explanation, NO_SEEK)}
                                    </div>
                                  ) : (
                                    <p className="text-xs leading-5 text-[var(--text-muted)]">
                                      {t("concepts.noExplanation")}
                                    </p>
                                  )}
                                  <ConceptSources
                                    concept={concept}
                                    query={query}
                                    onJump={(videoId, startMs) =>
                                      jumpToOccurrence(concept, videoId, startMs)
                                    }
                                  />
                                  {due === 0 && (
                                    <div className="mt-3 border-t border-[var(--border-subtle)] pt-2.5">
                                      <p className="text-xs leading-5 text-[var(--text-muted)]">
                                        {t("concepts.noReviewCards")}
                                      </p>
                                      <button
                                        type="button"
                                        onClick={() => makeCards.mutate(concept)}
                                        disabled={makeCards.isPending}
                                        className="ca-touch-44 mt-1.5 inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-2.5 py-1 text-xs font-medium text-[var(--text-normal)] transition hover:bg-[var(--surface-card-hover)] disabled:opacity-60"
                                      >
                                        <Wand2 className="h-3.5 w-3.5" />
                                        {makeCards.isPending ? t("concepts.makingCards") : t("concepts.makeReviewCards")}
                                      </button>
                                      {/* 结果只贴在发起的那个知识点下，换知识点后不跟着走。 */}
                                      {makeCards.variables?.id === concept.id &&
                                        makeCards.isSuccess && (
                                          <p className="mt-1.5 text-xs text-[var(--text-muted)]">
                                            {makeCards.data > 0
                                              ? t("concepts.madeCards", { count: makeCards.data })
                                              : t("concepts.noCardsAvailable")}
                                          </p>
                                        )}
                                      {makeCards.variables?.id === concept.id &&
                                        makeCards.isError && (
                                          <ErrorNote
                                            className="mt-1.5"
                                            error={makeCards.error}
                                            onRetry={() => makeCards.mutate(concept)}
                                          />
                                        )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
              <p className="sr-only">{t("concepts.sourceCount", { count: sourceCount })}</p>
            </>
          )}
        </main>
        </div>

        {hasKnowledge && chatOpen && (
          <>
            {/* 窄屏：抽屉浮层覆盖，半透明背板点击关闭；宽屏：在流内占 380px，左侧知识缩窄但仍可见。 */}
            <button
              type="button"
              aria-label={t("concepts.closeChat")}
              onClick={() => setChatOpen(false)}
              className="absolute inset-0 z-20 bg-black/30 sm:hidden"
            />
            <aside
              aria-label={t("concepts.chatLabel")}
              className="absolute inset-y-0 right-0 z-30 flex w-full max-w-full flex-col border-l border-[var(--border-subtle)] bg-[var(--surface-app)] shadow-[var(--shadow-pop)] sm:static sm:z-auto sm:w-[380px] sm:flex-none sm:shadow-none"
            >
              <div className="flex flex-none items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-header)] px-3 py-2.5">
                <Sparkles className="h-4 w-4 flex-none text-primary" />
                <span className="text-sm font-semibold text-[var(--text-strong)]">{t("concepts.chatTitle")}</span>
                <span className="truncate text-xs text-[var(--text-faint)]">{t("concepts.chatSubtitle")}</span>
                <button
                  type="button"
                  onClick={() => setChatOpen(false)}
                  aria-label={t("concepts.closeChat")}
                  title={t("concepts.closeChatButton")}
                  className="ca-icon-btn ca-touch-44 ml-auto"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <CourseChatPanel courseId={courseId} onJump={onJump} />
              </div>
            </aside>
          </>
        )}
      </div>

      {reviewing && (
        <ReviewSession
          concept={{ courseId, conceptId: reviewing.conceptId, name: reviewing.name }}
          onClose={closeReview}
          onJump={(card) => {
            if (card.video_id && card.source_ms != null) {
              const concept = allConcepts.find((item) => item.id === reviewing.conceptId);
              closeReview();
              onJump(
                card.video_id,
                card.source_ms,
                concept ? navigationStateFor(concept) : undefined,
              );
            }
          }}
        />
      )}
    </div>
  );
}
