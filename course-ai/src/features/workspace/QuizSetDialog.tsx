import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { Modal } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { ipc } from "@/lib/ipc";
import type { QuizStyle } from "@/lib/types";
import { QUIZ_STYLES } from "@/lib/quizStyles";

/**
 * 「再出一套」：选风格、写本课程的出题要求（同一门课的视频共用），默认追加为新的一套。
 */
export function QuizSetDialog({
  videoId,
  open,
  onClose,
  onStart,
}: {
  videoId: string;
  open: boolean;
  onClose: () => void;
  onStart: (options: { style: QuizStyle; append: boolean }) => void;
}) {
  const { t } = useTranslation();
  const [style, setStyle] = useState<QuizStyle>("apply");
  const [replace, setReplace] = useState(false);
  const [rules, setRules] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saved = useQuery({
    queryKey: ["quiz-course-rules", videoId],
    queryFn: () => ipc.ai.getQuizCourseRules(videoId),
    enabled: open,
  });
  useEffect(() => {
    if (open && saved.data !== undefined) setRules(saved.data);
  }, [open, saved.data]);

  async function start() {
    setSaveError(null);
    if (rules.trim() !== (saved.data ?? "").trim()) {
      setSaving(true);
      try {
        await ipc.ai.setQuizCourseRules(videoId, rules);
        await saved.refetch();
      } catch (error) {
        setSaveError(String(error));
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    onStart({ style, append: !replace });
    onClose();
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("quiz.dialog.title")}
      icon={<Sparkles className="h-4 w-4" />}
      size="md"
    >
      <fieldset className="space-y-2">
        <legend className="mb-2 text-xs font-medium text-[var(--text-muted)]">{t("quiz.dialog.styleLabel")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {QUIZ_STYLES.map((value) => (
            <label
              key={value}
              className={`ca-touch-44 flex cursor-pointer flex-col gap-0.5 rounded-lg border p-2.5 text-left transition-colors ${
                style === value
                  ? "border-primary bg-primary/10"
                  : "border-[var(--border-subtle)] hover:bg-[var(--surface-card-hover)]"
              }`}
            >
              <span className="flex items-center gap-2 text-sm font-medium text-[var(--text-strong)]">
                <input
                  type="radio"
                  name="quiz-style"
                  value={value}
                  checked={style === value}
                  onChange={() => setStyle(value)}
                  className="accent-[var(--accent)]"
                />
                {t(`quiz.styles.${value}`)}
              </span>
              <span className="pl-6 text-xs text-[var(--text-muted)]">{t(`quiz.styleHints.${value}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="mt-4 block text-xs font-medium text-[var(--text-muted)]" htmlFor="quiz-course-rules">
        {t("quiz.dialog.courseRules")}
      </label>
      <textarea
        id="quiz-course-rules"
        className="mt-1.5 min-h-[76px] w-full resize-y rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-normal)] outline-none focus:border-primary"
        value={rules}
        placeholder={t("quiz.dialog.courseRulesPlaceholder")}
        onChange={(event) => setRules(event.target.value)}
      />
      <p className="mt-1 text-xs text-[var(--text-faint)]">{t("quiz.dialog.courseRulesHint")}</p>
      <label className="ca-touch-44 mt-3 flex items-center gap-2 text-sm text-[var(--text-normal)]">
        <input
          type="checkbox"
          checked={replace}
          onChange={(event) => setReplace(event.target.checked)}
          className="accent-[var(--accent)]"
        />
        {t("quiz.dialog.replace")}
      </label>
      {saveError && <p className="mt-2 text-xs text-[var(--status-err)]">{saveError}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          {t("quiz.dialog.cancel")}
        </Button>
        <Button type="button" variant="primary" size="sm" onClick={() => void start()} disabled={saving}>
          {t("quiz.dialog.start")}
        </Button>
      </div>
    </Modal>
  );
}
