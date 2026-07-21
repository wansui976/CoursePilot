import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Flame, LayoutDashboard } from "lucide-react";
import { ipc } from "@/lib/ipc";
import {
  computeStreak,
  formatDuration,
  localDay,
  relativeDay,
  weeklyMs,
} from "@/lib/studyStats";

const LOOKBACK_DAYS = 40;

/** 学习仪表盘：本周时长 + 连续天数 + 各课程已学时长/上次学习（点击进入课程）。 */
export function Dashboard({
  onClose,
  onOpenCourse,
}: {
  onClose: () => void;
  onOpenCourse: (courseId: string) => void;
}) {
  const today = localDay(new Date());
  const fromTs = Date.now() - LOOKBACK_DAYS * 86_400_000;

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

  const streak = useMemo(
    () => computeStreak(new Set(daily.filter((d) => d.watched_ms > 0).map((d) => d.day)), today),
    [daily, today],
  );
  const week = useMemo(() => weeklyMs(daily, today), [daily, today]);
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
                {courseTotals.map((c) => (
                  <li key={c.course_id}>
                    <button
                      onClick={() => onOpenCourse(c.course_id)}
                      className="flex w-full items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3 text-left transition hover:bg-[var(--surface-card-hover)]"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-[var(--text-strong)]">
                          {nameOf(c.course_id)}
                        </div>
                        <div className="mt-0.5 text-xs text-[var(--text-muted)]">
                          已学 {formatDuration(c.watched_ms)} · 上次{" "}
                          {relativeDay(c.last_ts, today)}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
