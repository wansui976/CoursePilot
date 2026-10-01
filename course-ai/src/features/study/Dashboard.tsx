import { useEffect, useMemo, useRef, useState } from "react";
import { queries } from "@/lib/queries";
import { qk } from "@/lib/queryKeys";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Brain,
  Check,
  Clock,
  Flame,
  Play,
  TrendingDown,
} from "lucide-react";
import { ipc, type DueCard } from "@/lib/ipc";
import { isWatchedThrough, readPlaybackProgress } from "@/lib/playback";
import { formatCountdown } from "@/lib/time";
import { displayTitle } from "@/lib/videoTitle";
import { ErrorNote } from "@/ui/ErrorNote";
import { ProgressRing } from "@/ui/ProgressRing";
import { Skeleton } from "@/ui/skeleton";
import { ViewHeader } from "@/ui/view-header";
import { DailyGoalDialog } from "./DailyGoalDialog";
import { ReviewSession } from "./ReviewSession";
import {
  computeStreak,
  dayMs,
  dayReviews,
  formatDuration,
  heatmapGrid,
  isStudiedDay,
  localDay,
  readDailyGoalMin,
  relativeDay,
  reviewTotals,
  weeklyMs,
  writeDailyGoalMin,
  type HeatCell,
} from "@/lib/studyStats";

const HEATMAP_WEEKS = {
  compact: 12,
  medium: 18,
  wide: 26,
} as const;
// 量得到容器宽度时铺满整行，最多一年（与 GitHub 贡献图同一尺度）。
const HEATMAP_MAX_WEEKS = 53;
// 每列 = 方块 w-3（12px）+ 列间 gap-1（4px）。
const HEAT_COLUMN_PX = 16;
const HEAT_GAP_PX = 4;
// 覆盖热力图所需的历史范围（含今天所在周的补位），略放宽。
const LOOKBACK_DAYS = HEATMAP_MAX_WEEKS * 7 + 7;

// 热力图各强度等级的背景（level 0–4）；用主题主色的不同透明度，深浅主题都成立。
const HEAT_LEVEL_BG = [
  "bg-[var(--surface-card-active)]",
  "bg-primary/30",
  "bg-primary/50",
  "bg-primary/75",
  "bg-primary",
];

function weeksForViewport(width: number): number {
  if (width < 600) return HEATMAP_WEEKS.compact;
  if (width < 900) return HEATMAP_WEEKS.medium;
  return HEATMAP_WEEKS.wide;
}

function viewportWidth(): number {
  if (typeof window === "undefined") return 1024;
  return window.innerWidth || 1024;
}

/** 热力图周数：量得到容器宽度就按宽度铺满（不留右侧空白），量不到（jsdom、
 *  旧 WebView 无 ResizeObserver）退回按窗口宽度分档。 */
function useHeatmapWeeks(container: HTMLElement | null): number {
  const [fallback, setFallback] = useState(() => weeksForViewport(viewportWidth()));
  const [fitted, setFitted] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setFallback(weeksForViewport(viewportWidth()));
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (!container || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = container.clientWidth;
      setFitted(width > 0 ? Math.floor((width + HEAT_GAP_PX) / HEAT_COLUMN_PX) : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);

  return fitted == null
    ? fallback
    : Math.min(HEATMAP_MAX_WEEKS, Math.max(HEATMAP_WEEKS.compact, fitted));
}

function heatCellLabel(cell: NonNullable<HeatCell>, reached: boolean, t: TFunction): string {
  const parts = [cell.day];
  if (cell.ms > 0) parts.push(t("dashboard.studyDuration", { duration: formatDuration(cell.ms) }));
  if (cell.reviews > 0) parts.push(t("dashboard.reviewCount", { count: cell.reviews }));
  if (parts.length === 1) parts.push(t("dashboard.noStudy"));
  if (reached) parts.push(t("dashboard.reached"));
  return parts.join(" · ");
}

/** 一段连续的周列 + 它们所属的月份，用来把月份标签摆在整段的中间。 */
type MonthSegment = { label: string; span: number };

function monthSegments(columns: HeatCell[][], t: (k: string) => string): MonthSegment[] {
  const segments: MonthSegment[] = [];
  for (const column of columns) {
    const monthStart = column.find(
      (cell): cell is NonNullable<HeatCell> => cell !== null && cell.day.endsWith("-01"),
    );
    const first = column.find((cell): cell is NonNullable<HeatCell> => cell !== null);
    const last = segments[segments.length - 1];
    // 只有跨月的那一列开新段；其余列（含整列都是补位的）并进当前段。
    if (last && !monthStart) {
      last.span += 1;
      continue;
    }
    const day = monthStart?.day ?? first?.day;
    if (!day) continue;
    const month = Number(day.slice(5, 7));
    segments.push({ label: t(`dashboard.month${month}`), span: 1 });
  }
  return segments;
}

/** 可聚焦的热力图格：今天保持描边，达标日描细边，方向键按时间矩阵移动。 */
function HeatSquare({
  cell,
  today,
  active,
  goalMs,
  onSelect,
  onNavigate,
  t,
}: {
  cell: HeatCell;
  today: string;
  active: boolean;
  goalMs: number;
  onSelect: (day: string) => void;
  onNavigate: (day: string, offsetDays: number) => void;
  t: TFunction;
}) {
  if (!cell) return <span className="h-3 w-3" aria-hidden="true" />;
  // 目标只存当前值、没有按天留存，所以过去的达标是按「今天的目标」回看的。
  const reached = goalMs > 0 && cell.ms >= goalMs;
  const label = heatCellLabel(cell, reached, t);
  const isToday = cell.day === today;

  return (
    <button
      type="button"
      data-heat-day={cell.day}
      aria-label={label}
      aria-current={isToday ? "date" : undefined}
      title={label}
      tabIndex={active ? 0 : -1}
      onClick={() => onSelect(cell.day)}
      onFocus={() => onSelect(cell.day)}
      onKeyDown={(event) => {
        const offsets: Partial<Record<string, number>> = {
          ArrowLeft: -7,
          ArrowRight: 7,
          ArrowUp: -1,
          ArrowDown: 1,
        };
        const offset = offsets[event.key];
        if (offset == null) return;
        event.preventDefault();
        onNavigate(cell.day, offset);
      }}
      className={`h-3 w-3 flex-none cursor-pointer rounded-[2px] ${HEAT_LEVEL_BG[cell.level]} transition-colors focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-card)] ${
        isToday
          ? "outline outline-2 outline-offset-1 outline-[var(--accent-text)]"
          : active
            ? "outline outline-1 outline-offset-1 outline-[var(--text-muted)]"
            : reached
              ? "outline outline-1 outline-offset-1 outline-[var(--accent-text)] opacity-80"
              : ""
      }`}
    />
  );
}

/** 学习仪表盘：本周时长 + 连续天数 + 热力图 + 各课程已学时长/上次学习（点击进入课程）。 */
export function Dashboard({
  onClose,
  onOpenCourse,
  onResume,
  onJump,
}: {
  onClose: () => void;
  onOpenCourse: (courseId: string) => void;
  onResume: (courseId: string, videoId: string, positionSec: number) => void;
  onJump: (card: DueCard) => void;
}) {
  const { t } = useTranslation();
  const today = localDay(new Date());
  const fromTs = Date.now() - LOOKBACK_DAYS * 86_400_000;
  const [heatmapBox, setHeatmapBox] = useState<HTMLDivElement | null>(null);
  const heatmapWeeks = useHeatmapWeeks(heatmapBox);
  const queryClient = useQueryClient();
  const [reviewing, setReviewing] = useState(false);
  const [activeHeatDay, setActiveHeatDay] = useState(today);
  const heatmapRef = useRef<HTMLDivElement>(null);
  // 按薄弱概念复习的目标（打开概念作用域的 ReviewSession）。
  const [weakReview, setWeakReview] = useState<{
    courseId: string;
    conceptId: string;
    name: string;
  } | null>(null);

  const weakQuery = useQuery({
    queryKey: qk.weakConcepts(),
    queryFn: () => ipc.srs.weakConcepts(),
  });

  // 概念复习结束：刷新薄弱榜与待复习计数。
  function closeWeakReview() {
    setWeakReview(null);
    queryClient.invalidateQueries({ queryKey: qk.weakConcepts() });
    queryClient.invalidateQueries({ queryKey: qk.srs.countDue() });
  }

  const dueCountQuery = useQuery({
    queryKey: qk.srs.countDue(),
    queryFn: () => ipc.srs.countDue(),
  });

  // 下一批到期时刻：没有到期卡时用它代替一个点不动的禁用按钮。
  const nextDueAtQuery = useQuery({
    queryKey: qk.srs.nextDue(),
    queryFn: () => ipc.stats.nextDueAt(),
  });

  const continueQuery = useQuery({
    queryKey: qk.stats.continue(),
    queryFn: () => ipc.stats.continueLearning(),
  });

  const dailyQuery = useQuery({
    queryKey: qk.stats.daily(today),
    queryFn: () => ipc.stats.dailyTotals(fromTs, Date.now()),
  });
  const courseTotalsQuery = useQuery({
    queryKey: qk.stats.courses(),
    queryFn: () => ipc.stats.courseTotals(),
  });
  const coursesQuery = useQuery(queries.courses());
  const courseVideoIdsQuery = useQuery({
    queryKey: qk.stats.courseVideoIds(),
    queryFn: () => ipc.stats.courseVideoIds(),
  });
  const dueByCourseQuery = useQuery({
    queryKey: qk.srs.dueByCourse(),
    queryFn: () => ipc.srs.dueByCourse(),
  });
  const progressRowsQuery = useQuery({
    queryKey: qk.stats.videoProgress(),
    queryFn: () => ipc.stats.videoProgress(),
  });

  const weak = weakQuery.data ?? [];
  const dueCount = dueCountQuery.data ?? 0;
  const nextDueAt = nextDueAtQuery.data ?? null;
  const continueRows = continueQuery.data ?? [];
  const daily = useMemo(() => dailyQuery.data ?? [], [dailyQuery.data]);
  const courseTotals = courseTotalsQuery.data ?? [];
  const courses = useMemo(() => coursesQuery.data ?? [], [coursesQuery.data]);
  const courseVideoIds = useMemo(
    () => courseVideoIdsQuery.data ?? [],
    [courseVideoIdsQuery.data],
  );
  const dueByCourse = useMemo(
    () => dueByCourseQuery.data ?? [],
    [dueByCourseQuery.data],
  );
  const progressRows = useMemo(
    () => progressRowsQuery.data ?? [],
    [progressRowsQuery.data],
  );

  const courseStatsQueries = [
    courseTotalsQuery,
    coursesQuery,
    courseVideoIdsQuery,
    dueByCourseQuery,
    progressRowsQuery,
  ];
  const courseStatsFailed = courseStatsQueries.some((query) => query.isError);
  const courseStatsError = courseStatsQueries.find((query) => query.isError)?.error;
  const courseStatsPending = courseStatsQueries.some((query) => query.isPending);

  // 每门课的完成度（已看完/总数）。「已看完」优先看库里的播放进度，没有那条记录
  // 才回落到本地记录——清缓存/换设备后完成度不会再凭空归零。
  // 一次性算完：以前是每次渲染都为每个视频读两次 localStorage。
  const completion = useMemo(() => {
    const stored = new Map(progressRows.map((row) => [row.video_id, row]));
    const tally = new Map<string, { watched: number; total: number }>();
    for (const [courseId, videoId] of courseVideoIds) {
      const entry = tally.get(courseId) ?? { watched: 0, total: 0 };
      entry.total += 1;
      if (isWatchedThrough(videoId, stored.get(videoId))) entry.watched += 1;
      tally.set(courseId, entry);
    }
    return tally;
  }, [courseVideoIds, progressRows]);
  const completionOf = (courseId: string) =>
    completion.get(courseId) ?? { watched: 0, total: 0 };
  const dueOf = useMemo(() => new Map(dueByCourse), [dueByCourse]);

  const streak = useMemo(
    () => computeStreak(new Set(daily.filter(isStudiedDay).map((d) => d.day)), today),
    [daily, today],
  );
  const week = useMemo(() => weeklyMs(daily, today), [daily, today]);
  const heatmap = useMemo(
    () => heatmapGrid(daily, today, heatmapWeeks),
    [daily, heatmapWeeks, today],
  );
  const heatMonths = useMemo(() => monthSegments(heatmap, t), [heatmap, t]);
  const heatDays = useMemo(
    () =>
      new Set(
        heatmap
          .flat()
          .filter((cell): cell is NonNullable<HeatCell> => cell !== null)
          .map((cell) => cell.day),
      ),
    [heatmap],
  );
  const activeHeatCell = useMemo(
    () =>
      heatmap.flat().find((cell) => cell?.day === activeHeatDay) ??
      heatmap.flat().find((cell) => cell?.day === today) ??
      null,
    [activeHeatDay, heatmap, today],
  );

  useEffect(() => {
    if (!heatDays.has(activeHeatDay)) setActiveHeatDay(today);
  }, [activeHeatDay, heatDays, today]);

  function navigateHeatDay(day: string, offsetDays: number) {
    const target = new Date(`${day}T00:00:00`);
    target.setDate(target.getDate() + offsetDays);
    const targetDay = localDay(target);
    if (!heatDays.has(targetDay)) return;
    setActiveHeatDay(targetDay);
    const focusTarget = () => {
      heatmapRef.current
        ?.querySelector<HTMLButtonElement>(`[data-heat-day="${targetDay}"]`)
        ?.focus();
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(focusTarget);
    } else {
      focusTarget();
    }
  }

  // 每日学习目标：今日已学分钟 vs 目标分钟（本地存储，可编辑）。
  const [goalMin, setGoalMin] = useState(() => readDailyGoalMin());
  const todayWatched = dayMs(daily, today);
  const todayReviews = dayReviews(daily, today);
  const goalMs = goalMin * 60_000;
  const goalPercent = goalMs > 0 ? Math.min(100, Math.round((todayWatched / goalMs) * 100)) : 0;
  const goalReached = goalMs > 0 && todayWatched >= goalMs;
  const weekGoalMs = goalMin * 7 * 60_000;
  const weekGoalPercent = weekGoalMs > 0 ? Math.round((week / weekGoalMs) * 100) : 0;
  function saveGoal(value: number) {
    const n = Math.round(value);
    if (Number.isFinite(n) && n > 0) {
      writeDailyGoalMin(n);
      setGoalMin(n);
    }
  }

  // 复习产出：观看时长只说明投入，这行说明「有没有学会」。
  const recentReviews = useMemo(() => reviewTotals(daily, today), [daily, today]);
  const goodRate =
    recentReviews.reviews > 0
      ? Math.round((recentReviews.good / recentReviews.reviews) * 100)
      : 0;
  const reviewOutputLine =
    dailyQuery.isPending || dailyQuery.isError
      ? null
      : recentReviews.reviews > 0
        ? t("dashboard.recentReviews", { reviews: recentReviews.reviews, rate: goodRate })
        : t("dashboard.srsIntro");
  const nameOf = useMemo(() => {
    const map = new Map(courses.map((c) => [c.id, c.name]));
    return (id: string) => map.get(id) ?? t("dashboard.deletedCourse");
  }, [courses, t]);

  function retryCourseStats() {
    void Promise.all([
      courseTotalsQuery.refetch(),
      coursesQuery.refetch(),
      courseVideoIdsQuery.refetch(),
      dueByCourseQuery.refetch(),
      progressRowsQuery.refetch(),
    ]);
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-[var(--surface-app)] text-[var(--text-normal)]">
      <ViewHeader
        title={t("dashboard.title")}
        onBack={onClose}
        backLabel={t("dashboard.back")}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-2xl space-y-6">
          {continueQuery.isError ? (
            <section aria-labelledby="dashboard-continue-title">
              <div
                id="dashboard-continue-title"
                className="mb-2 text-sm font-semibold text-[var(--text-strong)]"
              >
                {t("dashboard.continueLearning")}
              </div>
              <ErrorNote
                error={continueQuery.error}
                onRetry={() => void continueQuery.refetch()}
              />
            </section>
          ) : continueRows.length > 0 ? (
            <section aria-labelledby="dashboard-continue-title">
              <div
                id="dashboard-continue-title"
                className="mb-2 text-sm font-semibold text-[var(--text-strong)]"
              >
                {t("dashboard.continueLearning")}
              </div>
              <ul className="space-y-2">
                {continueRows.map((row) => {
                  const { positionSec, ratio } = readPlaybackProgress(row.video_id);
                  return (
                    <li key={row.course_id}>
                      <button
                        onClick={() => onResume(row.course_id, row.video_id, positionSec)}
                        className="group flex w-full items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3 text-left transition hover:bg-[var(--surface-card-hover)]"
                      >
                        <span className="grid h-9 w-9 flex-none place-items-center rounded-lg ca-fill-brand text-[var(--on-accent)] transition-transform group-hover:scale-105">
                <Play className="h-4 w-4" />
              </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-[var(--text-strong)]">
                            {displayTitle(row.video_title)}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                            {row.course_name}
                            {ratio > 0 && t("dashboard.watchedPercent", { percent: Math.round(ratio * 100) })}
                          </div>
                          {ratio > 0 && (
                            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--surface-card-active)]">
                              <div
                                className="ca-fill-grad h-full rounded-full"
                                style={{ width: `${Math.round(ratio * 100)}%` }}
                              />
                            </div>
                          )}
                        </div>
                        <span className="flex-none text-xs font-medium text-[var(--text-muted)] transition group-hover:text-[var(--text-strong)]">
                          {ratio > 0 ? t("dashboard.continue") : t("dashboard.start")}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          {dueCountQuery.isPending ? (
            <Skeleton aria-label={t("common.loading")} className="h-14 w-full rounded-xl" />
          ) : dueCountQuery.isError ? (
            <ErrorNote
              error={dueCountQuery.error}
              onRetry={() => void dueCountQuery.refetch()}
            />
          ) : dueCount > 0 ? (
            <button
              onClick={() => setReviewing(true)}
              className="flex w-full items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3 text-left transition hover:bg-[var(--surface-card-hover)]"
            >
              <span className="grid h-9 w-9 flex-none place-items-center rounded-lg ca-fill-brand text-[var(--on-accent)]">
                <Brain className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-[var(--text-strong)]">
                  {t("dashboard.reviewDue", { count: dueCount })}
                </span>
                {reviewOutputLine && (
                  <span className="block text-xs text-[var(--text-muted)]">
                    {reviewOutputLine}
                  </span>
                )}
              </span>
              <span className="ca-sheen flex-none rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white">
                {t("dashboard.startReview")}
              </span>
            </button>
          ) : nextDueAtQuery.isPending ? (
            <Skeleton aria-label={t("common.loading")} className="h-14 w-full rounded-xl" />
          ) : nextDueAtQuery.isError ? (
            <ErrorNote
              error={nextDueAtQuery.error}
              onRetry={() => void nextDueAtQuery.refetch()}
            />
          ) : (
            // 没有到期卡时不摆一个点不动的禁用按钮（读屏也读不到它）：改成说明下一批什么时候来。
            <div className="flex w-full items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
              <span className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-[var(--surface-card-active)] text-[var(--text-muted)]">
                <Clock className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-[var(--text-strong)]">
                  {t("dashboard.noDueToday")}
                </div>
                <div className="text-xs text-[var(--text-muted)]">
                  {nextDueAt != null
                    ? t("dashboard.nextDue", { time: formatCountdown(nextDueAt) })
                    : t("dashboard.noScheduledCards")}
                </div>
                {reviewOutputLine && recentReviews.reviews > 0 && (
                  <div className="mt-0.5 text-xs text-[var(--text-faint)]">{reviewOutputLine}</div>
                )}
              </div>
            </div>
          )}

          {dailyQuery.isPending ? (
            <Skeleton aria-label={t("common.loading")} className="h-28 w-full rounded-xl" />
          ) : dailyQuery.isError ? (
            <section aria-label={t("dashboard.stats")}>
              <ErrorNote
                error={dailyQuery.error}
                onRetry={() => void dailyQuery.refetch()}
              />
            </section>
          ) : (
            <div
              role="group"
              aria-label={t("dashboard.stats")}
              className="ca-dashboard-stats grid grid-cols-2 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] min-[400px]:grid-cols-3"
            >
            <section
              aria-label={t("dashboard.todayStudy")}
              className="ca-dashboard-stat-today col-span-2 min-w-0 px-3 py-3 min-[400px]:col-span-1"
            >
              <div className="flex min-h-7 items-center justify-between gap-1">
                <span className="text-xs text-[var(--text-muted)]">{t("dashboard.todayStudy")}</span>
                <DailyGoalDialog value={goalMin} onSave={saveGoal} />
              </div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-[var(--text-strong)]">
                {formatDuration(todayWatched)}
              </div>
              {goalReached ? (
                <div className="mt-1 flex items-center gap-1 text-xs font-medium text-[var(--accent-text)]">
                  <Check className="h-3.5 w-3.5 flex-none" />
                  {t("dashboard.goalReached", { min: goalMin })}
                </div>
              ) : (
                <div className="mt-1 text-xs text-[var(--text-muted)]">{t("dashboard.goalTarget", { min: goalMin })}</div>
              )}
              <div
                aria-hidden="true"
                className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--surface-card-active)]"
              >
                <div
                  className={`h-full rounded-full ${goalReached ? "bg-[var(--accent-text)]" : "ca-fill-grad"}`}
                  style={{ width: `${goalPercent}%` }}
                />
              </div>
            </section>

            <section
              aria-label={t("dashboard.weekStudy")}
              className="ca-dashboard-stat-week min-w-0 border-l border-[var(--border-subtle)] px-3 py-3 max-[399px]:border-l-0 max-[399px]:border-t"
            >
              <div className="min-h-7 text-xs leading-7 text-[var(--text-muted)]">{t("dashboard.weekStudy")}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-[var(--text-strong)]">
                {formatDuration(week)}
              </div>
              <div className="mt-1 text-xs leading-tight text-[var(--text-muted)]">
                {t("dashboard.weekGoal", { duration: formatDuration(weekGoalMs), percent: weekGoalPercent })}
              </div>
            </section>

            <section
              aria-label={t("dashboard.streak")}
              className="ca-dashboard-stat-streak min-w-0 border-l border-[var(--border-subtle)] px-3 py-3 max-[399px]:border-t"
            >
              <div className="min-h-7 text-xs leading-7 text-[var(--text-muted)]">{t("dashboard.streak")}</div>
              <div className="mt-1 flex items-center gap-1.5 text-lg font-semibold tabular-nums text-[var(--text-strong)]">
                <Flame
                  className={`h-4 w-4 flex-none ${streak > 0 ? "text-[var(--status-warn,#e08a00)]" : "text-[var(--text-faint)]"}`}
                />
                {t("dashboard.streakDays", { days: streak })}
              </div>
              <div className="mt-1 text-xs leading-tight text-[var(--text-muted)]">
                {todayWatched > 0 || todayReviews > 0 ? t("dashboard.studiedToday") : t("dashboard.notStudiedToday")}
              </div>
            </section>
            </div>
          )}

          {weakQuery.isError ? (
            <section aria-labelledby="dashboard-weak-title">
              <div
                id="dashboard-weak-title"
                className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-[var(--text-strong)]"
              >
                <TrendingDown className="h-4 w-4 text-[var(--status-warn,#e08a00)]" />
                {t("dashboard.weakTopics")}
              </div>
              <ErrorNote
                error={weakQuery.error}
                onRetry={() => void weakQuery.refetch()}
              />
            </section>
          ) : weak.length > 0 ? (
            <section aria-labelledby="dashboard-weak-title">
              <div
                id="dashboard-weak-title"
                className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-[var(--text-strong)]"
              >
                <TrendingDown className="h-4 w-4 text-[var(--status-warn,#e08a00)]" />
                {t("dashboard.weakTopics")}
              </div>
              <ul className="space-y-2">
                {weak.map((w) => (
                  <li key={`${w.course_id}-${w.concept_id}`}>
                    <button
                      onClick={() =>
                        setWeakReview({
                          courseId: w.course_id,
                          conceptId: w.concept_id,
                          name: w.name,
                        })
                      }
                      className="flex w-full items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3 text-left transition hover:bg-[var(--surface-card-hover)]"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-[var(--text-strong)]">
                          {w.name}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                          {t("dashboard.weakDetail", {
                            course: w.course_name,
                            rate: Math.round(w.again_rate * 100),
                            fails: w.fails,
                            reviews: w.reviews,
                          })}
                        </div>
                      </div>
                      <span className="flex-none rounded-md bg-[var(--accent-weak-2)] px-3 py-1.5 text-xs font-medium text-[var(--accent-text)]">
                        {t("dashboard.reviewButton")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {!dailyQuery.isPending && !dailyQuery.isError && (
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold text-[var(--text-strong)]">{t("dashboard.heatmap")}</div>
              <div className="flex items-center gap-1 ca-t-2xs text-[var(--text-faint)]">
                <span>{t("dashboard.less")}</span>
                {HEAT_LEVEL_BG.map((bg, i) => (
                  <span key={i} className={`h-3 w-3 rounded-[2px] ${bg}`} />
                ))}
                <span>{t("dashboard.more")}</span>
              </div>
            </div>
            <div ref={setHeatmapBox} className="overflow-x-auto pb-1">
              <div className="grid min-w-max grid-cols-[auto] grid-rows-[1rem_auto] gap-y-1">
                <div aria-hidden="true" className="flex h-4 gap-1">
                  {heatMonths.map((segment, index) => (
                    <span
                      key={index}
                      className="relative h-4 flex-none"
                      // 段宽 = 列宽 w-3 × 列数 + 列间 gap-1
                      style={{
                        width: `calc(${segment.span} * 0.75rem + ${segment.span - 1} * 0.25rem)`,
                      }}
                    >
                      <span className="absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap ca-t-2xs leading-4 text-[var(--text-faint)]">
                        {segment.label}
                      </span>
                    </span>
                  ))}
                </div>

                <div
                  ref={heatmapRef}
                  role="group"
                  aria-label={t("dashboard.heatmapAria", { weeks: heatmapWeeks })}
                  className="flex gap-1"
                >
                  {heatmap.map((column, columnIndex) => {
                    const startsMonth =
                      columnIndex > 0 && column.some((cell) => cell?.day.endsWith("-01"));
                    return (
                      <div key={columnIndex} className="relative flex flex-col gap-1">
                        {startsMonth && (
                          <span
                            aria-hidden="true"
                            data-month-divider
                            className="pointer-events-none absolute inset-y-0 -left-0.5 border-l border-dashed border-[var(--border-strong)] opacity-60"
                          />
                        )}
                        {column.map((cell, rowIndex) => (
                          <HeatSquare
                            key={cell?.day ?? `future-${rowIndex}`}
                            cell={cell}
                            today={today}
                            goalMs={goalMs}
                            active={cell?.day === activeHeatDay}
                            onSelect={setActiveHeatDay}
                            onNavigate={navigateHeatDay}
                            t={t}
                          />
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <div
              role="status"
              aria-live="polite"
              className="mt-2 min-h-4 text-xs text-[var(--text-muted)]"
            >
              {activeHeatCell
                ? heatCellLabel(activeHeatCell, goalMs > 0 && activeHeatCell.ms >= goalMs, t)
                : t("dashboard.noRecords")}
            </div>
            </div>
          )}

          <div>
            <div className="mb-2 text-sm font-semibold text-[var(--text-strong)]">
              {t("dashboard.courses")}
            </div>
            {courseStatsFailed ? (
              <ErrorNote error={courseStatsError} onRetry={retryCourseStats} />
            ) : courseStatsPending ? (
              <Skeleton aria-label={t("common.loading")} className="h-16 w-full rounded-xl" />
            ) : courseTotals.length === 0 ? (
              <p className="rounded-lg border border-[var(--border-faint)] bg-[var(--surface-card)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
                {t("dashboard.noStudyRecords")}
              </p>
            ) : (
              <ul className="space-y-2">
                {courseTotals.map((c) => {
                  const { watched, total } = completionOf(c.course_id);
                  const due = dueOf.get(c.course_id) ?? 0;
                  return (
                    <li key={c.course_id}>
                      <button
                        onClick={() => onOpenCourse(c.course_id)}
                        className="flex w-full items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3 text-left transition hover:bg-[var(--surface-card-hover)]"
                      >
                        {total > 0 && (
                          <ProgressRing value={watched / total}>
                            <span className="ca-t-2xs font-semibold tabular-nums text-[var(--text-strong)]">
                              {watched}/{total}
                            </span>
                          </ProgressRing>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-[var(--text-strong)]">
                            {nameOf(c.course_id)}
                          </div>
                          <div className="mt-0.5 text-xs text-[var(--text-muted)]">
                            {t("dashboard.courseWatched", { duration: formatDuration(c.watched_ms) })}
                            {relativeDay(c.last_ts, today)}
                            {total > 0 && t("dashboard.courseCompletion", { watched, total })}
                          </div>
                        </div>
                        {due > 0 && (
                          <span className="flex-none rounded-md bg-[var(--accent-weak-2)] px-2.5 py-1 text-xs font-medium text-[var(--accent-text)]">
                            {t("dashboard.courseDue", { count: due })}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>

      {reviewing && (
        <ReviewSession
          onClose={() => setReviewing(false)}
          onJump={(card) => {
            setReviewing(false);
            onJump(card);
          }}
        />
      )}

      {weakReview && (
        <ReviewSession
          concept={weakReview}
          onClose={closeWeakReview}
          onJump={(card) => {
            closeWeakReview();
            onJump(card);
          }}
        />
      )}
    </div>
  );
}
