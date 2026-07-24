import { useDeferredValue, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Brain,
  ChevronDown,
  ChevronLeft,
  FileText,
  Lightbulb,
  MessageCircle,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import {
  ipc,
  type AnalyzeProgress,
  type CourseConcept,
  type CourseKnowledgeGroup,
} from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { displayTitle } from "@/lib/videoTitle";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Skeleton } from "@/components/ui/skeleton";
import { renderMarkdown } from "@/lib/renderMarkdown";
import { ReviewSession } from "./ReviewSession";
import { CourseChatPanel } from "./CourseChatPanel";

// 知识点解释跨多个视频，没有单一当前视频可跳转；解释里也不含 [mm:ss]，故用空 seek。
const NO_SEEK = () => {};

function sourceStats(concept: CourseConcept) {
  const videos = new Set(concept.occurrences.map((occurrence) => occurrence.video_id)).size;
  return `${videos} 个视频 · ${concept.occurrences.length} 处来源`;
}

function containsQuery(value: string | null | undefined, query: string) {
  return value?.toLocaleLowerCase().includes(query) ?? false;
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

/** 课程级知识页：总览、主题分组、可核验出处与按概念复习。 */
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
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
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
  const { data: dueCounts = [] } = useQuery({
    queryKey: ["srs-concept-due", courseId],
    queryFn: () => ipc.srs.conceptDueCounts(courseId),
  });
  const dueCountByConcept = new Map(dueCounts.map((due) => [due.concept_id, due.due]));

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
        count > 0 ? `已更新 ${count} 个知识点和课程总结。` : "未发现可用知识点，请先确认课程已有文稿。",
      );
      setExpanded(null);
    },
    onError: (error) => {
      if (error instanceof Error && error.message.includes("已取消")) {
        setAnnouncement("已取消分析。");
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
    onSuccess: () => setAnnouncement("课程总结已生成。"),
    onSettled: invalidateKnowledge,
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

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--surface-app)] text-[var(--text-normal)]">
      <header className="flex flex-none items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-header)] px-4 py-3 sm:px-7 sm:py-4">
        <button
          aria-label="返回课程视频"
          onClick={onClose}
          className="ca-icon-btn ca-touch-44 ml-0"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-[var(--text-strong)]">
            <Lightbulb className="h-4 w-4 flex-none" />
            课程知识
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
              aria-label="课程 AI 问答"
              aria-pressed={chatOpen}
              title="课程 AI 问答"
              className={`ca-touch-44 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                chatOpen
                  ? "border-transparent bg-primary !text-white"
                  : "border-[var(--border-subtle)] text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)]"
              }`}
            >
              <MessageCircle className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">AI 问答</span>
            </button>
            <button
              type="button"
              onClick={() => analyze.mutate()}
              disabled={busy}
              aria-label={analyze.isPending ? "正在重新分析" : "重新分析课程知识"}
              title={analyze.isPending ? "正在重新分析" : "重新分析课程知识"}
              className="ca-touch-44 inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--text-normal)] transition hover:bg-[var(--surface-card-hover)] disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${analyze.isPending ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">{analyze.isPending ? "分析中…" : "重新分析"}</span>
            </button>
          </div>
        )}
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-7 sm:py-6">
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
                  <p className="text-sm font-medium text-[var(--text-strong)]">正在分析课程知识…</p>
                  <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                    {progress
                      ? `${progress.total ? `${Math.min(progress.done + 1, progress.total)}/${progress.total} · ` : ""}${displayTitle(progress.title)}`
                      : "正在准备…"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={cancelAnalyze}
                  className="ca-touch-44 inline-flex flex-none items-center gap-1 rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--text-normal)] transition hover:bg-[var(--surface-card-hover)]"
                >
                  <X className="h-3.5 w-3.5" />
                  取消
                </button>
              </div>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-panel)]">
                <div
                  className="h-full rounded-full bg-primary transition-all"
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
            <div className="space-y-5" aria-label="正在加载课程知识">
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
              <h2 className="text-base font-semibold text-[var(--text-strong)]">还没有课程知识</h2>
              <p className="max-w-[340px] text-sm leading-relaxed text-[var(--text-muted)]">
                分析会读取课程内已有字幕，抽取知识点并整理出课程主线与可回看的出处。
              </p>
              <button
                type="button"
                onClick={() => analyze.mutate()}
                disabled={busy}
                className="ca-touch-44 rounded-lg bg-primary px-4 py-2 text-sm font-medium !text-white transition hover:opacity-90 disabled:opacity-60"
              >
                {analyze.isPending ? "分析中…" : "分析本课程"}
              </button>
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
                      课程总览
                    </h2>
                    {knowledge?.overview ? (
                      <p className="mt-2 max-w-3xl whitespace-pre-wrap text-sm leading-6 text-[var(--text-normal)]">
                        {knowledge.overview}
                      </p>
                    ) : (
                      <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">
                        已有知识点索引。生成课程总结后，会按主题补充主线和一句话结论。
                      </p>
                    )}
                    {knowledge?.stale && (
                      <p className="mt-2 text-xs text-[var(--status-warn)]">
                        课程内容已有变化，当前总结仍可参考，建议重新分析。
                      </p>
                    )}
                  </div>
                  {!knowledge?.overview && (
                    <button
                      type="button"
                      onClick={() => summarize.mutate()}
                      disabled={busy}
                      className="ca-touch-44 inline-flex flex-none items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium !text-white transition hover:opacity-90 disabled:opacity-60"
                    >
                      <FileText className={`h-3.5 w-3.5 ${summarize.isPending ? "animate-pulse" : ""}`} />
                      {summarize.isPending ? "生成中…" : "生成课程总结"}
                    </button>
                  )}
                </div>

                <dl className="mt-4 grid grid-cols-3 divide-x divide-[var(--border-subtle)] border-y border-[var(--border-subtle)] py-3">
                  <div className="min-w-0 px-3 first:pl-0">
                    <dt className="text-xs text-[var(--text-muted)]">主题</dt>
                    <dd className="mt-1 text-lg font-semibold text-[var(--text-strong)]">{topicCount}</dd>
                  </div>
                  <div className="min-w-0 px-3">
                    <dt className="text-xs text-[var(--text-muted)]">知识点</dt>
                    <dd className="mt-1 text-lg font-semibold text-[var(--text-strong)]">{allConcepts.length}</dd>
                  </div>
                  <div className="min-w-0 px-3 last:pr-0">
                    <dt className="text-xs text-[var(--text-muted)]">已覆盖视频</dt>
                    <dd className="mt-1 truncate text-lg font-semibold text-[var(--text-strong)]">
                      {knowledge?.covered_videos ?? 0}/{knowledge?.total_videos ?? 0}
                    </dd>
                  </div>
                </dl>
              </section>

              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-faint)]" />
                <input
                  type="search"
                  aria-label="搜索课程知识"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索知识点、结论或来源"
                  className="ca-touch-44 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] py-2 pl-9 pr-3 text-sm text-[var(--text-strong)] placeholder:text-[var(--text-faint)] focus:border-primary"
                />
              </div>

              {groups.length === 0 ? (
                <div className="py-10 text-center text-sm text-[var(--text-muted)]">
                  没有匹配“{search.trim()}”的知识点。
                </div>
              ) : (
                <div className="space-y-7">
                  {groups.map((group) => (
                    <section key={group.title} aria-labelledby={`knowledge-topic-${group.title}`}>
                      <div className="mb-2 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h2
                            id={`knowledge-topic-${group.title}`}
                            className="text-sm font-semibold text-[var(--text-strong)]"
                          >
                            {group.title}
                          </h2>
                          {group.summary && (
                            <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                              {group.summary}
                            </p>
                          )}
                        </div>
                        <span className="flex-none text-xs text-[var(--text-faint)]">
                          {group.concepts.length} 个知识点
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
                                      {concept.name}
                                    </span>
                                    {concept.summary && (
                                      <span className="mt-1 block line-clamp-1 text-xs leading-5 text-[var(--text-muted)]">
                                        {concept.summary}
                                      </span>
                                    )}
                                    <span className="mt-1 block text-xs text-[var(--text-faint)]">
                                      {sourceStats(concept)}
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
                                    复习 {due}
                                  </button>
                                )}
                              </div>
                              {isExpanded && (
                                <div
                                  id={detailId}
                                  role="region"
                                  aria-label={`${concept.name}的解释与来源`}
                                  className="border-t border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-3"
                                >
                                  {concept.explanation ? (
                                    <div className="text-sm leading-6 text-[var(--text-normal)]">
                                      {renderMarkdown(concept.explanation, NO_SEEK)}
                                    </div>
                                  ) : (
                                    <p className="text-xs leading-5 text-[var(--text-muted)]">
                                      暂无 AI 解释，重新分析课程后会依据字幕片段生成。
                                    </p>
                                  )}
                                  <div className="mt-3">
                                    <p className="mb-1.5 text-xs font-medium text-[var(--text-faint)]">
                                      来源片段
                                    </p>
                                    <ul className="flex flex-wrap gap-2">
                                      {concept.occurrences.map((occurrence) => (
                                        <li key={`${occurrence.video_id}-${occurrence.start_ms}`}>
                                          <button
                                            type="button"
                                            onClick={() => onJump(occurrence.video_id, occurrence.start_ms)}
                                            aria-label={`回看 ${displayTitle(occurrence.video_title)} ${formatMs(occurrence.start_ms)}`}
                                            className="inline-flex max-w-[240px] items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-2.5 py-1.5 text-xs transition hover:bg-[var(--surface-card-hover)]"
                                          >
                                            <span className="min-w-0 truncate text-[var(--text-muted)]">
                                              {displayTitle(occurrence.video_title)}
                                            </span>
                                            <span className="flex-none text-primary">
                                              {formatMs(occurrence.start_ms)}
                                            </span>
                                          </button>
                                        </li>
                                      ))}
                                    </ul>
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
              <p className="sr-only">共 {sourceCount} 处可回看来源。</p>
            </>
          )}
        </main>
        </div>

        {hasKnowledge && chatOpen && (
          <>
            {/* 窄屏：抽屉浮层覆盖，半透明背板点击关闭；宽屏：在流内占 380px，左侧知识缩窄但仍可见。 */}
            <button
              type="button"
              aria-label="关闭 AI 问答"
              onClick={() => setChatOpen(false)}
              className="absolute inset-0 z-20 bg-black/30 sm:hidden"
            />
            <aside
              aria-label="课程 AI 问答"
              className="absolute inset-y-0 right-0 z-30 flex w-full max-w-full flex-col border-l border-[var(--border-subtle)] bg-[var(--surface-app)] shadow-xl sm:static sm:z-auto sm:w-[380px] sm:flex-none sm:shadow-none"
            >
              <div className="flex flex-none items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-header)] px-3 py-2.5">
                <Sparkles className="h-4 w-4 flex-none text-primary" />
                <span className="text-sm font-semibold text-[var(--text-strong)]">AI 问答</span>
                <span className="truncate text-xs text-[var(--text-faint)]">· 基于本课程知识</span>
                <button
                  type="button"
                  onClick={() => setChatOpen(false)}
                  aria-label="关闭 AI 问答"
                  title="关闭"
                  className="ca-icon-btn ca-touch-44 ml-auto"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <CourseChatPanel courseId={courseId} />
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
              closeReview();
              onJump(card.video_id, card.source_ms);
            }
          }}
        />
      )}
    </div>
  );
}
