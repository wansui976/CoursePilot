import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { qk } from "@/lib/queryKeys";
import { useTranslation } from "react-i18next";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import {
  Brain,
  ChevronDown,
  ChevronLeft,
  FileText,
  Layers,
  Lightbulb,
  MessageCircle,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Video,
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
import { useContainerWidth } from "@/lib/useContainerWidth";
import { ReviewSession } from "./ReviewSession";
import { CourseChatPanel } from "./CourseChatPanel";
import { VideoCover } from "./VideoCover";

// 知识点解释跨多个视频，没有单一当前视频可跳转；解释里也不含 [mm:ss]，故用空 seek。
const NO_SEEK = () => {};

type AnalyzeRequest = { requestId: string };
type SummarizeRequest = { requestId: string };

type AnalyzeSnapshot = {
  status: "idle" | "pending" | "error" | "success";
  submittedAt: number;
  data: number | undefined;
  error: unknown;
  variables: AnalyzeRequest | undefined;
};

type SummarizeSnapshot = {
  status: "idle" | "pending" | "error" | "success";
  submittedAt: number;
  error: unknown;
  variables: SummarizeRequest | undefined;
};

type AnalyzeProgressSnapshot = {
  requestId: string;
  progress: AnalyzeProgress | null;
};

const analyzeProgressByCourse = new Map<string, AnalyzeProgressSnapshot>();
const analyzeProgressListeners = new Map<string, Set<() => void>>();

function notifyAnalyzeProgress(courseId: string) {
  analyzeProgressListeners.get(courseId)?.forEach((listener) => listener());
}

function startAnalyzeProgress(courseId: string, requestId: string) {
  analyzeProgressByCourse.set(courseId, { requestId, progress: null });
  notifyAnalyzeProgress(courseId);
}

function updateAnalyzeProgress(
  courseId: string,
  requestId: string,
  progress: AnalyzeProgress,
) {
  if (analyzeProgressByCourse.get(courseId)?.requestId !== requestId) return;
  analyzeProgressByCourse.set(courseId, { requestId, progress: { ...progress } });
  notifyAnalyzeProgress(courseId);
}

function finishAnalyzeProgress(courseId: string, requestId: string) {
  if (analyzeProgressByCourse.get(courseId)?.requestId !== requestId) return;
  analyzeProgressByCourse.delete(courseId);
  notifyAnalyzeProgress(courseId);
}

function subscribeAnalyzeProgress(courseId: string, listener: () => void) {
  const listeners = analyzeProgressListeners.get(courseId) ?? new Set<() => void>();
  listeners.add(listener);
  analyzeProgressListeners.set(courseId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) analyzeProgressListeners.delete(courseId);
  };
}

function useAnalyzeProgress(courseId: string) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeAnalyzeProgress(courseId, listener),
    [courseId],
  );
  const getSnapshot = useCallback(
    () => analyzeProgressByCourse.get(courseId) ?? null,
    [courseId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

function analyzeMutationKey(courseId: string) {
  return ["concepts-panel", courseId, "analyze"] as const;
}

function summarizeMutationKey(courseId: string) {
  return ["concepts-panel", courseId, "summarize"] as const;
}

/**
 * mutation observer 属于当前挂载的面板，但分析在离开页面后仍会继续。
 * 从 MutationCache 读取该课程最新任务，避免重开面板后误回 idle。
 */
function useLatestAnalyze(mutationKey: ReturnType<typeof analyzeMutationKey>) {
  const snapshots = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => ({
      status: mutation.state.status,
      submittedAt: mutation.state.submittedAt,
      data: mutation.state.data as number | undefined,
      error: mutation.state.error,
      variables: mutation.state.variables as AnalyzeRequest | undefined,
    }),
  });
  return snapshots.reduce<AnalyzeSnapshot | undefined>(
    (latest, snapshot) =>
      !latest || snapshot.submittedAt >= latest.submittedAt ? snapshot : latest,
    undefined,
  );
}

function useLatestSummarize(mutationKey: ReturnType<typeof summarizeMutationKey>) {
  const snapshots = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => ({
      status: mutation.state.status,
      submittedAt: mutation.state.submittedAt,
      error: mutation.state.error,
      variables: mutation.state.variables as SummarizeRequest | undefined,
    }),
  });
  return snapshots.reduce<SummarizeSnapshot | undefined>(
    (latest, snapshot) =>
      !latest || snapshot.submittedAt >= latest.submittedAt ? snapshot : latest,
    undefined,
  );
}

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

/** 主题 + 其在原始分组里的序号：主题色按原始序号取模轮换，搜索结果变化时颜色不漂。 */
type IndexedGroup = { group: CourseKnowledgeGroup; colorIndex: number };

function filterGroups(groups: CourseKnowledgeGroup[], query: string): IndexedGroup[] {
  const indexed = groups.map((group, colorIndex) => ({ group, colorIndex }));
  if (!query) return indexed;
  return indexed
    .map(({ group, colorIndex }) => {
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
      return { group: { ...group, concepts }, colorIndex };
    })
    .filter(({ group }) => group.concepts.length > 0);
}

const SOURCE_PREVIEW_LIMIT = 3;
/** 主题色板尺寸，与 globals.css 里的 --topic-0..N 一一对应。 */
const TOPIC_COLOR_COUNT = 6;
/** 搜索命中的概念自动展开的上限：宽泛词命中一大片时不展开，避免一次性渲染几十个 markdown 详情区。 */
const SEARCH_AUTO_EXPAND_LIMIT = 8;

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
                className="ca-touch-44 min-h-11 w-full px-1 py-2 text-left transition-colors hover:bg-[var(--surface-card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
              >
                <span className="flex min-w-0 items-start gap-2.5">
                  <VideoCover
                    videoId={occurrence.video_id}
                    className="mt-0.5 h-9 w-16 flex-none rounded-md"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2 text-xs">
                      <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-normal)]">
                        {highlightQuery(displayTitle(occurrence.video_title), query)}
                      </span>
                      <span className="flex-none rounded bg-[var(--accent-weak)] px-1.5 py-0.5 font-mono ca-t-2xs font-medium tabular-nums text-[var(--accent-text)]">
                        {formatMs(occurrence.start_ms)}
                      </span>
                    </span>
                    {excerpt && (
                      <span
                        id={excerptId}
                        className="mt-1 block line-clamp-2 text-xs leading-5 text-[var(--text-muted)]"
                      >
                        {highlightQuery(excerpt, query)}
                      </span>
                    )}
                  </span>
                </span>
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
          className="ca-touch-44 mt-1 inline-flex min-h-11 items-center gap-1 text-xs font-medium text-primary transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
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
  // 手风琴多开：可以同时摊开几个概念对比着看；跳转视频再回来时只带回目标那一个。
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    initialNavigationState?.expandedConceptId
      ? new Set([initialNavigationState.expandedConceptId])
      : new Set(),
  );
  const [search, setSearch] = useState(initialNavigationState?.search ?? "");
  const deferredSearch = useDeferredValue(search);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const mainScrollRef = useRef<HTMLDivElement>(null);
  const restoredScrollRef = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  // 拦住 mutation pending 状态渲染前的同一帧连点。
  const analyzeStartingCourse = useRef<string | null>(null);
  const summarizeStartingCourse = useRef<string | null>(null);
  // 正在按概念复习的目标（打开全屏 ReviewSession）。
  const [reviewing, setReviewing] = useState<{ conceptId: string; name: string } | null>(null);
  // 课程 AI 问答抽屉是否展开（背景为整门课的总览+知识点）。
  const [chatOpen, setChatOpen] = useState(false);
  const compactChat = useContainerWidth(panelRef) === "compact";
  const chatToggleRef = useRef<HTMLButtonElement>(null);
  const chatCloseRef = useRef<HTMLButtonElement>(null);

  const {
    data: knowledge,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: qk.courseKnowledge(courseId),
    queryFn: () => ipc.concepts.get(courseId),
  });

  // 每个概念的待复习卡数（现算），构成 conceptId -> due 映射。
  const {
    data: dueCounts = [],
    isPending: dueCountsPending,
    isError: dueCountsError,
  } = useQuery({
    queryKey: qk.srs.conceptDue.course(courseId),
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
    void queryClient.invalidateQueries({ queryKey: qk.courseKnowledge(courseId) });
    void queryClient.invalidateQueries({ queryKey: qk.courseConcepts(courseId) });
    void queryClient.invalidateQueries({ queryKey: qk.srs.conceptDue.course(courseId) });
  }

  const analyzeKey = analyzeMutationKey(courseId);
  const analyzeState = useLatestAnalyze(analyzeKey);
  const analyzePending = analyzeState?.status === "pending";
  const analyzeProgress = useAnalyzeProgress(courseId);
  const progress =
    analyzePending &&
    analyzeProgress &&
    analyzeProgress.requestId === analyzeState.variables?.requestId
      ? analyzeProgress.progress
      : null;

  const analyze = useMutation<number, unknown, AnalyzeRequest>({
    mutationKey: analyzeKey,
    mutationFn: async ({ requestId }) => {
      startAnalyzeProgress(courseId, requestId);
      try {
        return await ipc.concepts.analyze(courseId, requestId, (nextProgress) => {
          updateAnalyzeProgress(courseId, requestId, nextProgress);
        });
      } finally {
        // 迟到的旧请求不得清掉后来重试的新请求进度。
        finishAnalyzeProgress(courseId, requestId);
      }
    },
    onSuccess: (count) => {
      setAnnouncement(
        count > 0 ? t("concepts.updatedConcepts", { count }) : t("concepts.noConceptsFound"),
      );
      setExpanded(new Set());
    },
    onError: (error) => {
      if (error instanceof Error && error.message.includes("已取消")) {
        setAnnouncement(t("concepts.analysisCanceled"));
      }
    },
    onSettled: () => {
      if (analyzeStartingCourse.current === courseId) analyzeStartingCourse.current = null;
      invalidateKnowledge();
    },
  });

  // 取消进行中的分析：后台循环会在下个视频/片段前停下且不写库。
  function cancelAnalyze() {
    const requestId = analyzeState?.variables?.requestId;
    if (requestId) void ipc.concepts.cancelAnalyze(requestId);
  }

  // 取消导致的错误不当成失败展示（已在 announcement 提示）。
  const analyzeCancelled =
    analyzeState?.status === "error" &&
    analyzeState.error instanceof Error &&
    analyzeState.error.message.includes("已取消");

  const summarizeKey = summarizeMutationKey(courseId);
  const summarizeState = useLatestSummarize(summarizeKey);
  const summarizePending = summarizeState?.status === "pending";

  const summarize = useMutation<void, unknown, SummarizeRequest>({
    mutationKey: summarizeKey,
    mutationFn: () => ipc.concepts.summarize(courseId),
    onSuccess: () => setAnnouncement(t("concepts.summaryGenerated")),
    onSettled: () => {
      if (summarizeStartingCourse.current === courseId) summarizeStartingCourse.current = null;
      invalidateKnowledge();
    },
  });

  function hasPendingTask(mutationKey: readonly unknown[]) {
    return (
      queryClient.getMutationCache().findAll({ mutationKey, exact: true, status: "pending" })
        .length > 0
    );
  }

  function startAnalyze() {
    if (
      analyzePending ||
      summarizePending ||
      analyzeStartingCourse.current === courseId ||
      hasPendingTask(analyzeKey) ||
      hasPendingTask(summarizeKey)
    ) {
      return;
    }
    const requestId = crypto.randomUUID();
    analyzeStartingCourse.current = courseId;
    setAnnouncement("");
    analyze.mutate({ requestId });
  }

  function startSummarize() {
    if (
      analyzePending ||
      summarizePending ||
      summarizeStartingCourse.current === courseId ||
      hasPendingTask(analyzeKey) ||
      hasPendingTask(summarizeKey)
    ) {
      return;
    }
    summarizeStartingCourse.current = courseId;
    setAnnouncement("");
    summarize.mutate({ requestId: crypto.randomUUID() });
  }

  const recoveredAnalyzeAnnouncement =
    analyzeState?.status === "success"
      ? (analyzeState.data ?? 0) > 0
        ? t("concepts.updatedConcepts", { count: analyzeState.data })
        : t("concepts.noConceptsFound")
      : analyzeCancelled
        ? t("concepts.analysisCanceled")
        : "";
  const recoveredAnnouncement =
    summarizeState &&
    (!analyzeState || summarizeState.submittedAt >= analyzeState.submittedAt)
      ? summarizeState.status === "success"
        ? t("concepts.summaryGenerated")
        : ""
      : recoveredAnalyzeAnnouncement;

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
      void queryClient.invalidateQueries({ queryKey: qk.srs.conceptDue.course(courseId) });
      void queryClient.invalidateQueries({ queryKey: qk.srs.countDue() });
    },
  });

  // 复习结束（或退出）：刷新概念待复习数与仪表盘计数。
  function closeReview() {
    setReviewing(null);
    void queryClient.invalidateQueries({ queryKey: qk.srs.conceptDue.course(courseId) });
    void queryClient.invalidateQueries({ queryKey: qk.srs.countDue() });
  }

  const allConcepts = knowledge?.groups.flatMap((group) => group.concepts) ?? [];
  const sourceCount = allConcepts.reduce((total, concept) => total + concept.occurrences.length, 0);
  const topicCount = knowledge?.groups.length ?? 0;
  const query = deferredSearch.trim().toLocaleLowerCase();
  const groups = useMemo(() => filterGroups(knowledge?.groups ?? [], query), [knowledge?.groups, query]);
  const busy = analyzePending || summarizePending;
  const hasKnowledge = allConcepts.length > 0;
  // 过滤后仍在列的知识点数：搜索时告诉用户命中了多少，而不是只剩下一堆卡片。
  const matchedCount = groups.reduce((total, { group }) => total + group.concepts.length, 0);
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

  function toggleConcept(conceptId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(conceptId)) next.delete(conceptId);
      else next.add(conceptId);
      return next;
    });
  }

  // 搜索命中自动展开：匹配常落在折叠着的讲解/出处里，不展开用户根本看不到命中上下文。
  // 宽泛词命中一大片（超过上限）时不展开，避免一次性渲染几十个带 markdown 的详情区。
  useEffect(() => {
    if (!query || matchedCount > SEARCH_AUTO_EXPAND_LIMIT) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const { group } of groups) {
        for (const concept of group.concepts) next.add(concept.id);
      }
      return next;
    });
  }, [query, groups, matchedCount]);

  // 「/」从页面任意位置聚焦搜索框；焦点本就在输入控件里时不劫持按键。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      searchInputRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function scrollToTopic(index: number) {
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document
      .getElementById(`topic-section-${index}`)
      ?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }

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

  const chatBody = (
    <>
      <div className="flex flex-none items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-header)] px-3 py-2.5">
        <Sparkles className="h-4 w-4 flex-none text-primary" />
        <span className="text-sm font-semibold text-[var(--text-strong)]">{t("concepts.chatTitle")}</span>
        <span className="truncate text-xs text-[var(--text-faint)]">{t("concepts.chatSubtitle")}</span>
        <button
          ref={chatCloseRef}
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
    </>
  );

  return (
    <div
      ref={panelRef}
      className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--surface-app)] text-[var(--text-normal)]"
    >
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
            <Button
              ref={chatToggleRef}
              type="button"
              variant={chatOpen ? "primary" : "outline"}
              size="sm"
              onClick={() => setChatOpen((open) => !open)}
              aria-label={t("concepts.courseChat")}
              aria-pressed={chatOpen}
              title={t("concepts.courseChatTitle")}
              className="ca-touch-44 gap-1.5"
            >
              <MessageCircle className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("concepts.aiChat")}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={startAnalyze}
              disabled={busy}
              aria-label={analyzePending ? t("concepts.reanalyzing") : t("concepts.reanalyze")}
              title={analyzePending ? t("concepts.reanalyzing") : t("concepts.reanalyze")}
              className="ca-touch-44 gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${analyzePending ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">{analyzePending ? t("concepts.analyzing") : t("concepts.reanalyzeShort")}</span>
            </Button>
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
            {announcement || recoveredAnnouncement}
          </p>

          {analyzePending && (
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
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={cancelAnalyze}
                  className="ca-touch-44 flex-none gap-1"
                >
                  <X className="h-3.5 w-3.5" />
                  {t("concepts.cancelAnalysis")}
                </Button>
              </div>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-panel)]">
                <div
                  className="ca-fill-grad h-full rounded-full transition-[width] duration-300 ease-out"
                  style={{
                    width: `${progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 8}%`,
                  }}
                />
              </div>
            </div>
          )}
          {analyzeState?.status === "error" && !analyzeCancelled && (
            <ErrorNote error={analyzeState.error} onRetry={startAnalyze} />
          )}
          {summarizeState?.status === "error" && (
            <ErrorNote error={summarizeState.error} onRetry={startSummarize} />
          )}

          {isLoading ? (
            <div className="space-y-6" aria-label={t("concepts.loadingKnowledge")}>
              {/* 骨架对齐真实布局（概览卡 + 搜索框 + 主题列表），加载完成内容不跳。 */}
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4 sm:p-5">
                <Skeleton className="h-5 w-24" />
                <Skeleton className="mt-3 h-3.5 w-full" />
                <Skeleton className="mt-2 h-3.5 w-3/4" />
                <div className="mt-4 grid grid-cols-3 gap-3 border-t border-[var(--border-subtle)] pt-4">
                  <Skeleton className="h-9" />
                  <Skeleton className="h-9" />
                  <Skeleton className="h-9" />
                </div>
              </div>
              <Skeleton className="h-11 w-full rounded-lg" />
              <div>
                <Skeleton className="h-4 w-36" />
                <div className="mt-2.5 space-y-2">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              </div>
            </div>
          ) : isError ? (
            <ErrorNote error={error} onRetry={() => refetch()} />
          ) : !hasKnowledge ? (
            <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 px-2 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-lg ca-fill-brand text-[var(--on-accent)]">
                <Sparkles className="h-6 w-6" />
              </span>
              <h2 className="text-base font-semibold text-[var(--text-strong)]">{t("concepts.noKnowledge")}</h2>
              <p className="max-w-[340px] text-sm leading-relaxed text-[var(--text-muted)]">
                {t("concepts.noKnowledgeDesc")}
              </p>
              <Button
                type="button"
                variant="primary"
                onClick={startAnalyze}
                disabled={busy}
                className="ca-touch-44"
              >
                {analyzePending ? t("concepts.analyzing") : t("concepts.analyzeCourse")}
              </Button>
            </div>
          ) : (
            <>
              <section
                aria-labelledby="course-knowledge-overview"
                className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-[var(--shadow-card)]"
              >
                <div className="p-4 sm:p-5">
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
                        <div className="mt-3 rounded-lg border border-[var(--status-warn)]/40 bg-[var(--status-warn-bg)] px-3 py-2">
                          <p className="text-xs leading-5 text-[var(--status-warn)]">
                            {t("concepts.contentChanged")}
                            {missingVideos > 0
                              ? t("concepts.missingVideos", { count: missingVideos })
                              : t("concepts.noChangeSummaryOnly")}
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={startSummarize}
                            disabled={busy}
                            className="ca-touch-44 mt-1.5 gap-1.5 border-[var(--status-warn)]/50 text-[var(--status-warn)] hover:bg-[var(--status-warn-bg)]"
                          >
                            <FileText
                              className={`h-3.5 w-3.5 ${summarizePending ? "animate-pulse" : ""}`}
                            />
                            {summarizePending ? t("concepts.updatingSummary") : t("concepts.updateSummaryOnly")}
                          </Button>
                        </div>
                      )}
                    </div>
                    {!knowledge?.overview && (
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        onClick={startSummarize}
                        disabled={busy}
                        className="ca-touch-44 flex-none gap-1.5"
                      >
                        <FileText className={`h-3.5 w-3.5 ${summarizePending ? "animate-pulse" : ""}`} />
                        {summarizePending ? t("concepts.generatingSummary") : t("concepts.generateSummary")}
                      </Button>
                    )}
                  </div>
                </div>

                <dl className="grid grid-cols-3 divide-x divide-[var(--border-subtle)] border-t border-[var(--border-subtle)] bg-[var(--surface-panel)]">
                  <div className="min-w-0 px-4 py-3.5">
                    <dt className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                      <Layers aria-hidden="true" className="h-3.5 w-3.5 text-[var(--text-faint)]" />
                      {t("concepts.topicsLabel")}
                    </dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums text-[var(--text-strong)]">{topicCount}</dd>
                  </div>
                  <div className="min-w-0 px-4 py-3.5">
                    <dt className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                      <Lightbulb aria-hidden="true" className="h-3.5 w-3.5 text-[var(--text-faint)]" />
                      {t("concepts.conceptsLabel")}
                    </dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums text-[var(--text-strong)]">{allConcepts.length}</dd>
                  </div>
                  <div className="min-w-0 px-4 py-3.5">
                    <dt className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                      <Video aria-hidden="true" className="h-3.5 w-3.5 text-[var(--text-faint)]" />
                      {t("concepts.coveredVideos")}
                    </dt>
                    <dd className="mt-1 truncate text-lg font-semibold tabular-nums text-[var(--text-strong)]">
                      {knowledge?.covered_videos ?? 0}/{knowledge?.total_videos ?? 0}
                    </dd>
                  </div>
                </dl>
              </section>

              {/* 「下一步」行动条：全页唯一的主动作，用强调底色从内容流里抬出来。 */}
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--accent-weak-2)] bg-[var(--accent-weak)] px-4 py-3">
                <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-[var(--surface-card)] text-[var(--accent-text)] shadow-[var(--shadow-raise)]">
                  {nextReview ? (
                    <Brain aria-hidden="true" className="h-4 w-4" />
                  ) : (
                    <Play aria-hidden="true" className="h-4 w-4" />
                  )}
                </span>
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
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      jumpToOccurrence(
                        nextLearnConcept,
                        nextOccurrence.video_id,
                        nextOccurrence.start_ms,
                      )
                    }
                    className="ca-touch-44 flex-none gap-1.5 bg-[var(--surface-card)]"
                  >
                    <Play className="h-3.5 w-3.5 text-primary" />
                    {t("concepts.continueLearning")}
                  </Button>
                )}
              </div>

              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-faint)]" />
                <input
                  ref={searchInputRef}
                  type="search"
                  aria-label={t("concepts.searchKnowledge")}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("concepts.searchPlaceholder")}
                  className="ca-touch-44 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] py-2 pl-9 pr-9 text-sm text-[var(--text-strong)] placeholder:text-[var(--text-faint)] focus:border-[var(--focus-ring)] [&::-webkit-search-cancel-button]:appearance-none"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    aria-label={t("concepts.clearSearch")}
                    className="ca-touch-44 absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-[var(--text-faint)] transition-colors hover:text-[var(--text-strong)]"
                  >
                    <X aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {query && matchedCount > 0 && (
                <p aria-live="polite" className="-mt-4 text-xs text-[var(--text-muted)]">
                  {t("concepts.searchResults", { matched: matchedCount, total: allConcepts.length, groups: groups.length })}
                </p>
              )}

              {/* 主题锚点：主题多了一屏看不全时一键跳转；搜索时列表已按命中过滤，锚点隐藏。 */}
              {!query && groups.length > 1 && (
                <nav
                  aria-label={t("concepts.topicNav")}
                  className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                >
                  {groups.map(({ group, colorIndex }, index) => (
                    <button
                      key={`${index}-${group.title}`}
                      type="button"
                      onClick={() => scrollToTopic(index)}
                      className="inline-flex flex-none items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-1.5 text-xs font-medium text-[var(--text-normal)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-strong)]"
                    >
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: `var(--topic-${colorIndex % TOPIC_COLOR_COUNT})` }}
                      />
                      <span className="max-w-36 truncate">{group.title}</span>
                      <span className="tabular-nums text-[var(--text-faint)]">{group.concepts.length}</span>
                    </button>
                  ))}
                </nav>
              )}

              {groups.length === 0 ? (
                <div className="py-10 text-center text-sm text-[var(--text-muted)]">
                  {t("concepts.noSearchResults", { query: search.trim() })}
                </div>
              ) : (
                <div className="space-y-7">
                  {/* 主题标题由模型生成，可能重复；key 与 DOM id 用序号，避免同名主题互相顶掉。
                      主题色按原始序号轮换（--topic-color），标题色点、行左色条、锚点 chip 同源。 */}
                  {groups.map(({ group, colorIndex }, index) => (
                    <section
                      key={`${index}-${group.title}`}
                      id={`topic-section-${index}`}
                      aria-labelledby={`knowledge-topic-${index}`}
                      className="scroll-mt-4"
                      style={{ "--topic-color": `var(--topic-${colorIndex % TOPIC_COLOR_COUNT})` } as CSSProperties}
                    >
                      <div className="mb-2 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h2
                            id={`knowledge-topic-${index}`}
                            className="flex items-center gap-2 text-sm font-semibold text-[var(--text-strong)]"
                          >
                            <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full bg-[var(--topic-color)]" />
                            {highlightQuery(group.title, query)}
                          </h2>
                          {group.summary && (
                            <p className="mt-1 pl-4 text-xs leading-5 text-[var(--text-muted)]">
                              {highlightQuery(group.summary, query)}
                            </p>
                          )}
                        </div>
                        <span className="flex-none text-xs tabular-nums text-[var(--text-faint)]">
                          {t("concepts.conceptCount", { count: group.concepts.length })}
                        </span>
                      </div>

                      <ul className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] divide-y divide-[var(--border-subtle)]">
                        {group.concepts.map((concept) => {
                          const isExpanded = expanded.has(concept.id);
                          const due = dueCountByConcept.get(concept.id) ?? 0;
                          const detailId = `concept-detail-${concept.id}`;
                          return (
                            <li
                              key={concept.id}
                              className="shadow-[inset_3px_0_0_0_var(--topic-color)]"
                            >
                              <div className="flex min-w-0 items-stretch gap-1 pr-2">
                                <button
                                  type="button"
                                  onClick={() => toggleConcept(concept.id)}
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
                                    className="ca-touch-44 my-auto inline-flex flex-none items-center gap-1 rounded-lg bg-[var(--accent-weak-2)] px-2.5 py-1 text-xs font-medium text-[var(--accent-text)] transition hover:bg-[var(--accent)] hover:text-[var(--on-accent)]"
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
                                  className="ca-concept-expand border-t border-[var(--border-subtle)] bg-[var(--surface-panel)]"
                                >
                                  <div className="px-3 py-3">
                                    <p className="mb-1 text-xs font-medium text-[var(--text-faint)]">
                                      {t("concepts.explanationLabel")}
                                    </p>
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
                                        <p className="text-xs font-medium text-[var(--text-faint)]">
                                          {t("concepts.reviewSectionLabel")}
                                        </p>
                                        <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                                          {t("concepts.noReviewCards")}
                                        </p>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          onClick={() => makeCards.mutate(concept)}
                                          disabled={makeCards.isPending}
                                          className="ca-touch-44 mt-1.5 gap-1.5 bg-[var(--surface-card)]"
                                        >
                                          <Wand2 className="h-3.5 w-3.5" />
                                          {makeCards.isPending ? t("concepts.makingCards") : t("concepts.makeReviewCards")}
                                        </Button>
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

        {hasKnowledge && chatOpen &&
          (compactChat ? (
            <Dialog.Root open onOpenChange={setChatOpen}>
              <Dialog.Overlay className="absolute inset-0 z-20 bg-black/30" />
              <Dialog.Content
                aria-modal="true"
                aria-describedby={undefined}
                onOpenAutoFocus={(event) => {
                  event.preventDefault();
                  chatCloseRef.current?.focus();
                }}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  chatToggleRef.current?.focus();
                }}
                className="absolute inset-0 z-30 flex flex-col bg-[var(--surface-app)] shadow-[var(--shadow-pop)]"
              >
                <Dialog.Title className="sr-only">{t("concepts.chatLabel")}</Dialog.Title>
                {chatBody}
              </Dialog.Content>
            </Dialog.Root>
          ) : (
            <aside
              aria-label={t("concepts.chatLabel")}
              className="flex w-[380px] flex-none flex-col border-l border-[var(--border-subtle)] bg-[var(--surface-app)]"
            >
              {chatBody}
            </aside>
          ))}
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
