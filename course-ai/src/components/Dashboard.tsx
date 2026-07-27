import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Brain,
  Check,
  ChevronLeft,
  Clock,
  Flame,
  LayoutDashboard,
  Play,
  TrendingDown,
} from "lucide-react";
import { ipc, type DueCard } from "@/lib/ipc";
import { isWatchedThrough, readPlaybackProgress } from "@/lib/playback";
import { formatCountdown } from "@/lib/time";
import { displayTitle } from "@/lib/videoTitle";
import { ProgressRing } from "@/components/ui/ProgressRing";
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
// 覆盖热力图所需的历史范围（含今天所在周的补位），略放宽。
const LOOKBACK_DAYS = HEATMAP_WEEKS.wide * 7 + 7;

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

function useHeatmapWeeks(): number {
  const [weeks, setWeeks] = useState(() => weeksForViewport(viewportWidth()));

  useEffect(() => {
    const update = () => setWeeks(weeksForViewport(viewportWidth()));
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return weeks;
}

function heatCellLabel(cell: NonNullable<HeatCell>, reached: boolean): string {
  const parts = [cell.day];
  if (cell.ms > 0) parts.push(`学习 ${formatDuration(cell.ms)}`);
  if (cell.reviews > 0) parts.push(`复习 ${cell.reviews} 张`);
  if (parts.length === 1) parts.push("未学习");
  if (reached) parts.push("已达标");
  return parts.join(" · ");
}

/** 一段连续的周列 + 它们所属的月份，用来把月份标签摆在整段的中间。 */
type MonthSegment = { label: string; span: number };

function monthSegments(columns: HeatCell[][]): MonthSegment[] {
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
    segments.push({ label: `${Number(day.slice(5, 7))}月`, span: 1 });
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
}: {
  cell: HeatCell;
  today: string;
  active: boolean;
  goalMs: number;
  onSelect: (day: string) => void;
  onNavigate: (day: string, offsetDays: number) => void;
}) {
  if (!cell) return <span className="h-3 w-3" aria-hidden="true" />;
  // 目标只存当前值、没有按天留存，所以过去的达标是按「今天的目标」回看的。
  const reached = goalMs > 0 && cell.ms >= goalMs;
  const label = heatCellLabel(cell, reached);
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
      className={`h-3 w-3 flex-none cursor-pointer rounded-[2px] ${HEAT_LEVEL_BG[cell.level]} transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-card)] ${
        isToday
          ? "outline outline-2 outline-offset-1 outline-primary"
          : active
            ? "outline outline-1 outline-offset-1 outline-[var(--text-muted)]"
            : reached
              ? "outline outline-1 outline-offset-1 outline-primary/60"
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
  const today = localDay(new Date());
  const fromTs = Date.now() - LOOKBACK_DAYS * 86_400_000;
  const heatmapWeeks = useHeatmapWeeks();
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

  const { data: weak = [] } = useQuery({
    queryKey: ["weak-concepts"],
    queryFn: () => ipc.srs.weakConcepts(),
  });

  // 概念复习结束：刷新薄弱榜与待复习计数。
  function closeWeakReview() {
    setWeakReview(null);
    queryClient.invalidateQueries({ queryKey: ["weak-concepts"] });
    queryClient.invalidateQueries({ queryKey: ["srs-count-due"] });
  }

  const { data: dueCount = 0 } = useQuery({
    queryKey: ["srs-count-due"],
    queryFn: () => ipc.srs.countDue(),
  });

  // 下一批到期时刻：没有到期卡时用它代替一个点不动的禁用按钮。
  const { data: nextDueAt = null } = useQuery({
    queryKey: ["srs-next-due"],
    queryFn: () => ipc.stats.nextDueAt(),
  });

  const { data: continueRows = [] } = useQuery({
    queryKey: ["stats-continue"],
    queryFn: () => ipc.stats.continueLearning(),
  });

  const { data: daily = [] } = useQuery({
    queryKey: ["stats-daily", today],
    queryFn: () => ipc.stats.dailyTotals(fromTs, Date.now()),
  });
  const { data: courseTotals = [] } = useQuery({
    queryKey: ["stats-courses"],
    queryFn: () => ipc.stats.courseTotals(),
  });
  const { data: courses = [] } = useQuery({
    queryKey: ["courses"],
    queryFn: ipc.courses.list,
  });
  const { data: courseVideoIds = [] } = useQuery({
    queryKey: ["stats-course-video-ids"],
    queryFn: () => ipc.stats.courseVideoIds(),
  });
  const { data: dueByCourse = [] } = useQuery({
    queryKey: ["srs-due-by-course"],
    queryFn: () => ipc.srs.dueByCourse(),
  });
  const { data: progressRows = [] } = useQuery({
    queryKey: ["stats-video-progress"],
    queryFn: () => ipc.stats.videoProgress(),
  });

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
  const heatMonths = useMemo(() => monthSegments(heatmap), [heatmap]);
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
    recentReviews.reviews > 0
      ? `最近 7 天复习 ${recentReviews.reviews} 张 · 良好率 ${goodRate}%`
      : "间隔重复 · 出题自动生成卡片";
  const nameOf = useMemo(() => {
    const map = new Map(courses.map((c) => [c.id, c.name]));
    return (id: string) => map.get(id) ?? "（已删除课程）";
  }, [courses]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-[var(--surface-app)] text-[var(--text-normal)]">
      <header className="flex flex-none items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-header)] px-7 py-4">
        <button
          aria-label="返回"
          onClick={onClose}
          className="ca-icon-btn ca-touch-44 ml-0"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text-strong)]">
          <LayoutDashboard className="h-4 w-4" />
          学习面板
        </h2>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-2xl space-y-6">
          {continueRows.length > 0 && (
            <div>
              <div className="mb-2 text-sm font-semibold text-[var(--text-strong)]">
                继续学习
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
                        <span className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-primary/15 text-primary transition group-hover:bg-primary group-hover:text-white">
                          <Play className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-[var(--text-strong)]">
                            {displayTitle(row.video_title)}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                            {row.course_name}
                            {ratio > 0 && ` · 已看 ${Math.round(ratio * 100)}%`}
                          </div>
                          {ratio > 0 && (
                            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--surface-card-active)]">
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{ width: `${Math.round(ratio * 100)}%` }}
                              />
                            </div>
                          )}
                        </div>
                        <span className="flex-none text-xs font-medium text-[var(--text-muted)] transition group-hover:text-[var(--text-strong)]">
                          {ratio > 0 ? "继续" : "开始"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {dueCount > 0 ? (
            <button
              onClick={() => setReviewing(true)}
              className="flex w-full items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3 text-left transition hover:bg-[var(--surface-card-hover)]"
            >
              <span className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-primary/15 text-primary">
                <Brain className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-[var(--text-strong)]">
                  今日复习 {dueCount} 张
                </span>
                <span className="block text-xs text-[var(--text-muted)]">{reviewOutputLine}</span>
              </span>
              <span className="flex-none rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white">
                开始复习
              </span>
            </button>
          ) : (
            // 没有到期卡时不摆一个点不动的禁用按钮（读屏也读不到它）：改成说明下一批什么时候来。
            <div className="flex w-full items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
              <span className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-[var(--surface-card-active)] text-[var(--text-muted)]">
                <Clock className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-[var(--text-strong)]">
                  今天没有到期卡片
                </div>
                <div className="text-xs text-[var(--text-muted)]">
                  {nextDueAt != null
                    ? `下一批 ${formatCountdown(nextDueAt)}到期`
                    : "还没有排期中的卡片，在视频页出题后会自动生成"}
                </div>
                {recentReviews.reviews > 0 && (
                  <div className="mt-0.5 text-xs text-[var(--text-faint)]">{reviewOutputLine}</div>
                )}
              </div>
            </div>
          )}

          <div
            role="group"
            aria-label="学习统计"
            className="grid grid-cols-3 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)]"
          >
            <section aria-label="今日学习" className="min-w-0 px-3 py-3">
              <div className="flex min-h-7 items-center justify-between gap-1">
                <span className="text-xs text-[var(--text-muted)]">今日学习</span>
                <DailyGoalDialog value={goalMin} onSave={saveGoal} />
              </div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-[var(--text-strong)]">
                {formatDuration(todayWatched)}
              </div>
              {goalReached ? (
                <div className="mt-1 flex items-center gap-1 text-xs font-medium text-[var(--accent-text)]">
                  <Check className="h-3.5 w-3.5 flex-none" />
                  已达标 · {goalMin} 分钟
                </div>
              ) : (
                <div className="mt-1 text-xs text-[var(--text-muted)]">目标 {goalMin} 分钟</div>
              )}
              <div
                aria-hidden="true"
                className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--surface-card-active)]"
              >
                <div
                  className={`h-full rounded-full ${goalReached ? "bg-[var(--accent-text)]" : "bg-primary"}`}
                  style={{ width: `${goalPercent}%` }}
                />
              </div>
            </section>

            <section
              aria-label="本周学习"
              className="min-w-0 border-l border-[var(--border-subtle)] px-3 py-3"
            >
              <div className="min-h-7 text-xs leading-7 text-[var(--text-muted)]">本周学习</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-[var(--text-strong)]">
                {formatDuration(week)}
              </div>
              <div className="mt-1 text-xs leading-tight text-[var(--text-muted)]">
                目标 {formatDuration(weekGoalMs)} · {weekGoalPercent}%
              </div>
            </section>

            <section
              aria-label="连续学习"
              className="min-w-0 border-l border-[var(--border-subtle)] px-3 py-3"
            >
              <div className="min-h-7 text-xs leading-7 text-[var(--text-muted)]">连续学习</div>
              <div className="mt-1 flex items-center gap-1.5 text-lg font-semibold tabular-nums text-[var(--text-strong)]">
                <Flame
                  className={`h-4 w-4 flex-none ${streak > 0 ? "text-[var(--status-warn,#e08a00)]" : "text-[var(--text-faint)]"}`}
                />
                {streak} 天
              </div>
              <div className="mt-1 text-xs leading-tight text-[var(--text-muted)]">
                {todayWatched > 0 || todayReviews > 0 ? "今天已学习" : "今天尚未学习"}
              </div>
            </section>
          </div>

          {weak.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-[var(--text-strong)]">
                <TrendingDown className="h-4 w-4 text-[var(--status-warn,#e08a00)]" />
                薄弱主题
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
                          {w.course_name} · 差评率 {Math.round(w.again_rate * 100)}%（{w.fails}/
                          {w.reviews}）
                        </div>
                      </div>
                      <span className="flex-none rounded-md bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary">
                        复习
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold text-[var(--text-strong)]">学习热力图</div>
              <div className="flex items-center gap-1 text-[11px] text-[var(--text-faint)]">
                <span>少</span>
                {HEAT_LEVEL_BG.map((bg, i) => (
                  <span key={i} className={`h-3 w-3 rounded-[2px] ${bg}`} />
                ))}
                <span>多</span>
              </div>
            </div>
            <div className="overflow-x-auto pb-1">
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
                      <span className="absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap text-[10px] leading-4 text-[var(--text-faint)]">
                        {segment.label}
                      </span>
                    </span>
                  ))}
                </div>

                <div
                  ref={heatmapRef}
                  role="group"
                  aria-label={`最近 ${heatmapWeeks} 周学习热力图`}
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
                ? heatCellLabel(activeHeatCell, goalMs > 0 && activeHeatCell.ms >= goalMs)
                : "暂无学习记录"}
            </div>
          </div>

          <div>
            <div className="mb-2 text-sm font-semibold text-[var(--text-strong)]">
              各课程
            </div>
            {courseTotals.length === 0 ? (
              <p className="rounded-lg border border-[var(--border-faint)] bg-[var(--surface-card)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
                还没有学习记录。
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
                            <span className="text-[10px] font-semibold tabular-nums text-[var(--text-strong)]">
                              {watched}/{total}
                            </span>
                          </ProgressRing>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-[var(--text-strong)]">
                            {nameOf(c.course_id)}
                          </div>
                          <div className="mt-0.5 text-xs text-[var(--text-muted)]">
                            已学 {formatDuration(c.watched_ms)} · 上次{" "}
                            {relativeDay(c.last_ts, today)}
                            {total > 0 && ` · 完成 ${watched}/${total} 讲`}
                          </div>
                        </div>
                        {due > 0 && (
                          <span className="flex-none rounded-md bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary">
                            待复习 {due}
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
