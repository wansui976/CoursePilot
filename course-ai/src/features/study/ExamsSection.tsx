import { useQueries, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { examPlan, upcomingExams, useCourseExams } from "@/lib/exams";
import { isWatchedThrough } from "@/lib/playback";
import { queries } from "@/lib/queries";

const SECTION_TITLE = "mb-2 text-xs font-medium tracking-wide text-[var(--text-muted)]";
const FLAT_LIST = "divide-y divide-[var(--border-faint)] border-y border-[var(--border-faint)]";
const FLAT_ROW =
  "group -mx-3 flex w-[calc(100%+1.5rem)] items-center gap-3 rounded-md px-3 py-3 text-left transition hover:bg-[var(--surface-card-hover)]";

/**
 * 学习面板里的「考试倒计时」：设了考试日期的课程按日子近远排，每门写还剩几天、
 * 还有几讲没看、每天约看几讲。没有即将到来的考试时整节不出现。
 */
export function ExamsSection({ onOpenCourse }: { onOpenCourse: (courseId: string) => void }) {
  const { t } = useTranslation();
  const exams = useCourseExams((s) => s.exams);
  const { data: courses = [] } = useQuery(queries.courses());
  const upcoming = upcomingExams(exams).filter((item) => courses.some((c) => c.id === item.courseId));
  const videoLists = useQueries({
    queries: upcoming.map((item) => queries.videos(item.courseId)),
  });
  if (upcoming.length === 0) return null;
  return (
    <section aria-labelledby="dashboard-exams-title">
      <div id="dashboard-exams-title" className={SECTION_TITLE}>
        {t("exam.sectionTitle")}
      </div>
      <ul className={FLAT_LIST}>
        {upcoming.map((item, index) => {
          const course = courses.find((c) => c.id === item.courseId)!;
          const videos = videoLists[index]?.data;
          const total = videos?.length ?? course.video_count;
          const watched = videos ? videos.filter((video) => isWatchedThrough(video.id)).length : 0;
          const plan = examPlan(item.daysLeft, total, watched);
          return (
            <li key={item.courseId}>
              <button type="button" className={FLAT_ROW} onClick={() => onOpenCourse(item.courseId)}>
                <div className="flex w-14 flex-none flex-col items-center">
                  <span className="font-[var(--font-display)] text-[28px] leading-8 text-[var(--text-strong)] [font-variant-numeric:lining-nums]">
                    {item.daysLeft}
                  </span>
                  <span className="text-[12px] text-[var(--text-muted)]">
                    {item.daysLeft === 0 ? t("exam.todayShort") : t("exam.daysUnit")}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-[var(--text-strong)]">
                    {course.name} · {item.exam.name}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                    <span className="font-[var(--font-mono)]">{item.exam.date}</span>
                    {" · "}
                    {plan.remaining === 0
                      ? t("exam.allWatched")
                      : t("exam.planLine", { remaining: plan.remaining, perDay: plan.perDay })}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
