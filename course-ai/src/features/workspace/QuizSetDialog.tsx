import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Brain, Check, Lightbulb, PenLine, Scale, Sparkles, type LucideIcon } from "lucide-react";
import { Modal } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { ipc } from "@/lib/ipc";
import type { QuizStyle } from "@/lib/types";
import { QUIZ_STYLES } from "@/lib/quizStyles";

const STYLE_ICONS: Record<QuizStyle, LucideIcon> = {
  recall: Brain,
  apply: Lightbulb,
  correct: PenLine,
  contrast: Scale,
};

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
      <fieldset className="mt-2">
        <legend className="ca-t-2xs mb-2 font-medium text-[var(--text-faint)]">{t("quiz.dialog.styleLabel")}</legend>
        <div className="grid grid-cols-2 gap-2">
          {QUIZ_STYLES.map((value) => {
            const Icon = STYLE_ICONS[value];
            const on = style === value;
            return (
              <label
                key={value}
                className={`ca-touch-44 relative flex cursor-pointer flex-col gap-1 rounded-xl border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--focus-ring)] ${
                  on
                    ? "border-[var(--accent)] bg-[var(--accent-weak)]"
                    : "border-[var(--border-subtle)] hover:bg-[var(--surface-card-hover)]"
                }`}
              >
                <input
                  type="radio"
                  name="quiz-style"
                  value={value}
                  checked={on}
                  onChange={() => setStyle(value)}
                  className="sr-only"
                />
                <span className="flex items-center gap-2">
                  <Icon className={`h-4 w-4 ${on ? "text-[var(--accent-text)]" : "text-[var(--text-muted)]"}`} aria-hidden="true" />
                  <span className="text-sm font-semibold text-[var(--text-strong)]">{t(`quiz.styles.${value}`)}</span>
                  {on && <Check className="ml-auto h-3.5 w-3.5 text-[var(--accent-text)]" aria-hidden="true" />}
                </span>
                <span className="ca-t-xs leading-snug text-[var(--text-muted)]">{t(`quiz.styleHints.${value}`)}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <label className="ca-t-2xs mt-4 block font-medium text-[var(--text-faint)]" htmlFor="quiz-course-rules">
        {t("quiz.dialog.courseRules")}
      </label>
      <textarea
        id="quiz-course-rules"
        className="mt-1.5 min-h-[76px] w-full resize-y rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm leading-relaxed text-[var(--text-strong)] outline-none transition placeholder:text-[var(--text-faint)] focus:border-[var(--accent)]"
        value={rules}
        placeholder={t("quiz.dialog.courseRulesPlaceholder")}
        onChange={(event) => setRules(event.target.value)}
      />
      <p className="ca-t-2xs mt-1 text-[var(--text-faint)]">{t("quiz.dialog.courseRulesHint")}</p>
      <div className="mt-4 flex items-center justify-between gap-3 rounded-lg bg-[var(--surface-card-hover)] px-3 py-2.5">
        <span className="min-w-0">
          <span className="block text-sm text-[var(--text-strong)]">{t("quiz.dialog.replace")}</span>
          <span className="ca-t-2xs block text-[var(--text-faint)]">{t("quiz.dialog.replaceHint")}</span>
        </span>
        <Switch checked={replace} onCheckedChange={setReplace} aria-label={t("quiz.dialog.replace")} />
      </div>
      {saveError && <p className="mt-2 text-xs text-[var(--status-err)]">{saveError}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t("quiz.dialog.cancel")}
        </Button>
        <Button type="button" variant="primary" size="sm" onClick={() => void start()} disabled={saving} className="gap-1.5">
          <Sparkles className="h-3.5 w-3.5" />
          {t("quiz.dialog.start")}
        </Button>
      </div>
    </Modal>
  );
}
