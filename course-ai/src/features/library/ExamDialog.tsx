import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { daysUntil, examPlan, toLocalDate, useCourseExams } from "@/lib/exams";
import { Button } from "@/ui/button";
import { Modal } from "@/ui/dialog";

const FIELD =
  "w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-strong)] outline-none transition-colors placeholder:text-[var(--text-faint)] hover:border-[var(--border-strong)] focus-visible:border-[var(--focus-ring)] focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--focus-ring)_22%,transparent)]";

/** 课程菜单「考试日期…」：给这门课记一个考试名和日期；清除就不再倒数。 */
export function ExamDialog({
  course,
  onClose,
}: {
  course: { id: string; name: string };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const saved = useCourseExams((s) => s.exams[course.id]);
  const setExam = useCourseExams((s) => s.setExam);
  const [name, setName] = useState(saved?.name ?? t("exam.defaultName"));
  const [date, setDate] = useState(saved?.date ?? "");
  const today = toLocalDate(Date.now());
  const days = date ? daysUntil(date) : null;
  const valid = Boolean(date) && days != null && days >= 0;

  const save = () => {
    if (!valid) return;
    setExam(course.id, { name: name.trim() || t("exam.defaultName"), date });
    onClose();
  };

  return (
    <Modal
      open
      size="sm"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("exam.dialogTitle")}
      description={t("exam.dialogDescription", { course: course.name })}
    >
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <label className="flex flex-col gap-1.5 text-[13px] text-[var(--text-muted)]" htmlFor={`${id}-name`}>
          {t("exam.name")}
          <input
            id={`${id}-name`}
            className={FIELD}
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-[var(--text-muted)]" htmlFor={`${id}-date`}>
          {t("exam.date")}
          <input
            id={`${id}-date`}
            type="date"
            className={`${FIELD} font-[var(--font-mono)]`}
            min={today}
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <p className="min-h-5 text-[13px] text-[var(--text-muted)]" aria-live="polite">
          {date && days != null
            ? days < 0
              ? t("exam.inPast")
              : days === 0
                ? t("exam.today")
                : t("exam.daysLeft", { count: days })
            : null}
        </p>
        <div className="mt-1 flex items-center justify-end gap-2">
          {saved && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="mr-auto"
              onClick={() => {
                setExam(course.id, null);
                onClose();
              }}
            >
              {t("exam.clear")}
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={!valid}>
            {t("exam.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * 课程页标题下的一小段：「距期末考试 23 天 · 每天约 2 讲」。今天考就写「今天考试」，
 * 都看完了就只倒数。点它可以改日期。没设考试时什么都不画。
 */
export function ExamCountdown({
  courseId,
  total,
  watched,
  onEdit,
}: {
  courseId: string;
  total: number;
  watched: number;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const exam = useCourseExams((s) => s.exams[courseId]);
  if (!exam) return null;
  const days = daysUntil(exam.date);
  if (days < 0) return null;
  const plan = examPlan(days, total, watched);
  return (
    <>
      <span aria-hidden="true"> · </span>
      <button
        type="button"
        onClick={onEdit}
        title={t("exam.edit")}
        className="ca-exam-countdown rounded-[var(--r-xs)] text-inherit underline decoration-[var(--border-strong)] decoration-dotted underline-offset-[3px] hover:text-[var(--text-strong)]"
      >
        {days === 0
          ? t("exam.todayNamed", { name: exam.name })
          : t("exam.countdown", { name: exam.name, count: days })}
        {plan.perDay > 0 && (
          <span className="text-[var(--text-faint)]">
            {" · "}
            {t("exam.perDay", { count: plan.perDay })}
          </span>
        )}
      </button>
    </>
  );
}
