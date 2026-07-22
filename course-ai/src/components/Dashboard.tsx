import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, ChevronLeft, Flame, LayoutDashboard, Play, TrendingDown } from "lucide-react";
import { ipc, type DueCard } from "@/lib/ipc";
import { WATCHED_RATIO, readPlaybackProgress } from "@/lib/playback";
import { ProgressRing } from "@/components/ui/ProgressRing";
import { ReviewSession } from "./ReviewSession";
import {
  computeStreak,
  dayMs,
  formatDuration,
  heatmapGrid,
  localDay,
  readDailyGoalMin,
  relativeDay,
  weeklyMs,
  writeDailyGoalMin,
  type HeatCell,
} from "@/lib/studyStats";

const HEATMAP_WEEKS = 18;
// 覆盖热力图所需的历史范围（含今天所在周的补位），略放宽。
const LOOKBACK_DAYS = HEATMAP_WEEKS * 7 + 7;

// 热力图各强度等级的背景（level 0–4）；用主题主色的不同透明度，深浅主题都成立。
const HEAT_LEVEL_BG = [
  "bg-[var(--surface-card-active)]",
  "bg-primary/30",
  "bg-primary/50",
  "bg-primary/75",
  "bg-primary",
];

/** 热力图一格：空位（未来）留透明占位保持网格对齐；有日期的格按等级上色并带悬浮说明。 */
function HeatSquare({ cell }: { cell: HeatCell }) {
  if (!cell) return <span className="h-2.5 w-2.5" aria-hidden="true" />;
  const label =
    cell.ms > 0 ? `${cell.day} · ${formatDuration(cell.ms)}` : `${cell.day} · 未学习`;
  return <span title={label} className={`h-2.5 w-2.5 rounded-sm ${HEAT_LEVEL_BG[cell.level]}`} />;
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
  const queryClient = useQueryClient();
  const [reviewing, setReviewing] = useState(false);
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

  // 每门课的完成度（已看完/总数，「已看完」按本地播放进度 ≥ WATCHED_RATIO 判定）。
  const completionOf = useMemo(() => {
    const idsByCourse = new Map<string, string[]>();
    for (const [cid, vid] of courseVideoIds) {
      const arr = idsByCourse.get(cid);
      if (arr) arr.push(vid);
      else idsByCourse.set(cid, [vid]);
    }
    return (courseId: string): { watched: number; total: number } => {
      const ids = idsByCourse.get(courseId) ?? [];
      const watched = ids.filter(
        (id) => readPlaybackProgress(id).ratio >= WATCHED_RATIO,
      ).length;
      return { watched, total: ids.length };
    };
  }, [courseVideoIds]);
  const dueOf = useMemo(() => new Map(dueByCourse), [dueByCourse]);

  const streak = useMemo(
    () => computeStreak(new Set(daily.filter((d) => d.watched_ms > 0).map((d) => d.day)), today),
    [daily, today],
  );
  const week = useMemo(() => weeklyMs(daily, today), [daily, today]);
  const heatmap = useMemo(() => heatmapGrid(daily, today, HEATMAP_WEEKS), [daily, today]);
  // 每日学习目标：今日已学分钟 vs 目标分钟（本地存储，可编辑）。
  const [goalMin, setGoalMin] = useState(() => readDailyGoalMin());
  const [editingGoal, setEditingGoal] = useState(false);
  const todayMin = Math.round(dayMs(daily, today) / 60000);
  function saveGoal(value: string) {
    const n = Math.round(Number(value));
    if (Number.isFinite(n) && n > 0) {
      writeDailyGoalMin(n);
      setGoalMin(n);
    }
    setEditingGoal(false);
  }
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
          <button
            onClick={() => setReviewing(true)}
            disabled={dueCount === 0}
            className="flex w-full items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3 text-left transition hover:bg-[var(--surface-card-hover)] disabled:cursor-default disabled:opacity-60 disabled:hover:bg-[var(--surface-card)]"
          >
            <span className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-primary/15 text-primary">
              <Brain className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-[var(--text-strong)]">
                {dueCount > 0 ? `今日复习 ${dueCount} 张` : "今天没有待复习"}
              </span>
              <span className="block text-xs text-[var(--text-muted)]">
                间隔重复 · 出题自动生成卡片
              </span>
            </span>
            {dueCount > 0 && (
              <span className="flex-none rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white">
                开始复习
              </span>
            )}
          </button>

          <div className="flex items-center gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
            <ProgressRing value={goalMin > 0 ? todayMin / goalMin : 0} size={52} stroke={5}>
              <span className="text-[11px] font-semibold tabular-nums text-[var(--text-strong)]">
                {Math.round((goalMin > 0 ? todayMin / goalMin : 0) * 100)}%
              </span>
            </ProgressRing>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-[var(--text-strong)]">今日目标</div>
              <div className="mt-0.5 text-xs text-[var(--text-muted)]">
                今日已学 {todayMin} 分钟 / 目标 {goalMin} 分钟
              </div>
            </div>
            {editingGoal ? (
              <input
                type="number"
                min={1}
                aria-label="每日目标（分钟）"
                defaultValue={goalMin}
                autoFocus
                onBlur={(e) => saveGoal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveGoal((e.target as HTMLInputElement).value);
                  if (e.key === "Escape") setEditingGoal(false);
                }}
                className="ca-touch-44 w-16 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)]"
              />
            ) : (
              <button
                onClick={() => setEditingGoal(true)}
                className="ca-touch-44 flex-none rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--text-normal)] transition hover:bg-[var(--surface-card-hover)]"
              >
                编辑目标
              </button>
            )}
          </div>

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
                            {row.video_title}
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

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
              <div className="text-xs text-[var(--text-muted)]">本周学习</div>
              <div className="mt-1 text-xl font-semibold text-[var(--text-strong)]">
                {formatDuration(week)}
              </div>
            </div>
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
              <div className="text-xs text-[var(--text-muted)]">连续学习</div>
              <div className="mt-1 flex items-center gap-1.5 text-xl font-semibold text-[var(--text-strong)]">
                <Flame
                  className={`h-5 w-5 ${streak > 0 ? "text-[var(--status-warn,#e08a00)]" : "text-[var(--text-faint)]"}`}
                />
                {streak} 天
              </div>
            </div>
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
                  <span key={i} className={`h-2.5 w-2.5 rounded-sm ${bg}`} />
                ))}
                <span>多</span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <div
                role="img"
                aria-label={`最近 ${HEATMAP_WEEKS} 周学习热力图`}
                className="flex gap-1"
              >
                {heatmap.map((col, ci) => (
                  <div key={ci} className="flex flex-col gap-1">
                    {col.map((cell, ri) => (
                      <HeatSquare key={ri} cell={cell} />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div>
            <div className="mb-2 text-sm font-semibold text-[var(--text-strong)]">
              各课程
            </div>
            {courseTotals.length === 0 ? (
              <p className="rounded-lg border border-[var(--border-faint)] bg-[var(--surface-card)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
                还没有学习记录，去看几节课，这里就会显示进度。
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
