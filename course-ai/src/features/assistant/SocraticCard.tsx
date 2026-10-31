import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Eye, GraduationCap, Lightbulb, Plus } from "lucide-react";
import { withClickableTimestamps } from "@/lib/clickableTimestamps";
import { guidedCardSaved, markGuidedCardSaved } from "@/lib/guidedCards";
import { renderMarkdown } from "@/lib/renderMarkdown";
import type { SocraticBlock } from "./socratic";

/**
 * 引导模式一轮回答下面的那张卡：进度、可点的回答、分级提示、折叠的答案；
 * 推出结论后换成总结卡，可以一键做成复习卡。
 *
 * 只有最后一轮可交互（interactive）：旧轮次的选项点了也接不上现在的对话。
 */
export function SocraticCard({
  block,
  interactive,
  canMakeCard,
  cardKey,
  onPick,
  onSeek,
  onMakeCard,
}: {
  block: SocraticBlock;
  interactive: boolean;
  /** 有视频上下文时才能建卡（复习卡挂在视频上）。 */
  canMakeCard: boolean;
  /** 这一轮的 id：记住已经建过卡，切会话 / 重启后不重复建。 */
  cardKey?: string;
  onPick: (reply: string) => void;
  onSeek: (ms: number) => void;
  onMakeCard: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [hintsShown, setHintsShown] = useState(0);
  const [answerShown, setAnswerShown] = useState(false);
  const [cardState, setCardState] = useState<"idle" | "saving" | "saved" | "failed">(() =>
    cardKey && guidedCardSaved(cardKey) ? "saved" : "idle",
  );
  // 只有「说着说着推出来了」才有东西可做卡：空总结 + 空结论建出来是一张空白卡。
  const hasCardContent = block.summary.length > 0 || Boolean(block.answer);

  if (block.done) {
    return (
      <section
        aria-label={t("assistant.socratic.summaryTitle")}
        className="mt-2 rounded-xl border border-[var(--accent-weak-2)] bg-[var(--accent-weak)] px-3 py-2.5"
      >
        <p className="flex items-center gap-1.5 text-xs font-medium text-[var(--accent-text)]">
          <GraduationCap className="h-3.5 w-3.5" aria-hidden="true" />
          {t("assistant.socratic.summaryTitle")}
        </p>
        {block.summary.length > 0 && (
          <ol className="ca-prose mt-1.5 list-decimal space-y-1 pl-5 text-sm text-[var(--text-normal)]">
            {block.summary.map((point, index) => (
              <li key={point}>{withClickableTimestamps(point, onSeek, `summary-${index}`)}</li>
            ))}
          </ol>
        )}
        {canMakeCard && hasCardContent && (
          <button
            type="button"
            disabled={cardState === "saving" || cardState === "saved"}
            onClick={() => {
              setCardState("saving");
              onMakeCard().then(
                () => {
                  if (cardKey) markGuidedCardSaved(cardKey);
                  setCardState("saved");
                },
                () => setCardState("failed"),
              );
            }}
            className="ca-touch-44 mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-[var(--accent-text)] hover:bg-[var(--accent-weak-2)] disabled:cursor-default disabled:opacity-80"
          >
            {cardState === "saved" ? (
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {cardState === "saved"
              ? t("assistant.socratic.cardSaved")
              : cardState === "failed"
                ? t("assistant.socratic.cardFailed")
                : t("assistant.socratic.makeCard")}
          </button>
        )}
      </section>
    );
  }

  const progress =
    block.step && block.total
      ? t("assistant.socratic.progress", { step: block.step, total: block.total })
      : block.step
        ? t("assistant.socratic.stepOnly", { step: block.step })
        : null;

  return (
    <div className="mt-2 space-y-2" data-testid="socratic-card">
      {progress && (
        <div className="flex items-center gap-2 ca-t-2xs text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-1">
            <GraduationCap className="h-3 w-3" aria-hidden="true" />
            {progress}
          </span>
          {block.step && block.total && (
            <span
              aria-hidden="true"
              className="h-1 max-w-24 flex-1 overflow-hidden rounded-full bg-[var(--surface-card-active)]"
            >
              <span
                className="block h-full rounded-full bg-[var(--accent)]"
                style={{ width: `${Math.min(100, (block.step / block.total) * 100)}%` }}
              />
            </span>
          )}
        </div>
      )}
      {interactive && block.options.length > 0 && (
        <div role="group" aria-label={t("assistant.socratic.options")} className="flex flex-wrap gap-1.5">
          {block.options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onPick(option)}
              className="ca-touch-44 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2.5 py-1 text-xs text-[var(--text-normal)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-text)]"
            >
              {option}
            </button>
          ))}
          <button
            type="button"
            onClick={() => onPick(t("assistant.socratic.notSure"))}
            className="ca-touch-44 rounded-full border border-dashed border-[var(--border-subtle)] px-2.5 py-1 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-normal)]"
          >
            {t("assistant.socratic.notSure")}
          </button>
        </div>
      )}
      {block.hints.slice(0, hintsShown).map((hint, index) => (
        <p
          key={hint}
          className="ca-prose flex items-start gap-1.5 rounded-lg bg-[var(--surface-card)] px-2.5 py-1.5 text-xs text-[var(--text-normal)]"
        >
          <Lightbulb className="mt-0.5 h-3 w-3 flex-none text-[var(--status-warn)]" aria-hidden="true" />
          <span>
            <span className="mr-1 text-[var(--text-muted)]">{t("assistant.socratic.hintN", { n: index + 1 })}</span>
            {withClickableTimestamps(hint, onSeek, `hint-${index}`)}
          </span>
        </p>
      ))}
      {answerShown && block.answer && (
        <div className="ca-prose rounded-lg border border-[var(--border-faint)] px-2.5 py-1.5 text-sm text-[var(--text-normal)]">
          {renderMarkdown(block.answer, onSeek)}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {hintsShown < block.hints.length && (
          <button
            type="button"
            onClick={() => setHintsShown((n) => n + 1)}
            className="ca-touch-44 inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]"
          >
            <Lightbulb className="h-3 w-3" aria-hidden="true" />
            {hintsShown === 0
              ? t("assistant.socratic.showHint")
              : t("assistant.socratic.showNextHint", { n: hintsShown + 1 })}
          </button>
        )}
        {block.answer && !answerShown && (
          <button
            type="button"
            onClick={() => setAnswerShown(true)}
            className="ca-touch-44 inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]"
          >
            <Eye className="h-3 w-3" aria-hidden="true" />
            {t("assistant.socratic.revealAnswer")}
          </button>
        )}
      </div>
    </div>
  );
}
