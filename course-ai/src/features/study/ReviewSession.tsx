import { useEffect, useRef, useState } from "react";
import { qk } from "@/lib/queryKeys";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, LineChart, RotateCcw, X, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/ui/button";
import { ipc, type DueCard, type MistakeCard } from "@/lib/ipc";
import { formatStudyInterval } from "@/lib/time";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/lib/viewTransition";
import { MathText } from "@/ui/MathText";
import { renderInlineMarkdown } from "@/lib/renderMarkdown";
import { MemoryCurve } from "./MemoryCurve";

/** 评完分甩出去的时长（与 design.css 的 ca-toss 一致）。 */
const TOSS_MS = 320;

const GRADES: { rating: number; labelKey: string; key: string }[] = [
  { rating: 1, labelKey: "review.again", key: "1" },
  { rating: 2, labelKey: "review.hard", key: "2" },
  { rating: 3, labelKey: "review.good", key: "3" },
  { rating: 4, labelKey: "review.easy", key: "4" },
];
const SESSION_LIMIT = 50;
let reviewSessionSequence = 0;

type ChoiceData = {
  options: string[];
  correctOptions: string[];
  multiple: boolean;
};

function getChoiceData(card: DueCard | undefined): ChoiceData | null {
  const options = card?.options;
  const correctOptions = card?.correct_options;
  if (
    !options ||
    options.length < 2 ||
    !correctOptions ||
    correctOptions.length === 0 ||
    correctOptions.some((correct) => !options.includes(correct))
  ) {
    return null;
  }
  return {
    options,
    correctOptions,
    multiple: card.question_type === "multi",
  };
}

function sameAnswers(selected: string[], correct: string[]) {
  return (
    selected.length === correct.length &&
    selected.every((answer) => correct.includes(answer))
  );
}

function isInteractiveTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(target.closest("button, input, select, textarea, a, [contenteditable='true']"))
  );
}

/** 错题本里的卡没有排期预览（可能还没到期），按钮上就不显示间隔。 */
function mistakeToDueCard(card: MistakeCard): DueCard {
  return {
    id: card.card_id,
    video_id: card.video_id,
    course_id: card.course_id,
    front: card.front,
    back: card.back,
    source_ms: card.source_ms,
    preview_ms: [],
  };
}

/** 全屏、纯键盘的复习会话：空格翻面，1–4 打分，答错可回看出处。
 * 默认复习今日全部到期卡；给 `concept` 则只复习该课程该概念下的到期卡。 */
export function ReviewSession({
  onClose,
  onJump,
  concept,
  mistakes,
}: {
  onClose: () => void;
  onJump: (card: DueCard) => void;
  concept?: { courseId: string; conceptId: string; name: string };
  /** 只复习错题本：答错过、还没连对三次的卡（可以提前复习）。null 表示全部课程。 */
  mistakes?: { courseId: string | null };
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // 每次打开都是一副新的到期牌组。会话内锁定列表避免卡片位移，重新打开时
  // 则必须重新查库，不能复用上一轮已经评分过的卡。
  const [sessionId] = useState(() => ++reviewSessionSequence);
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: concept
      ? qk.srs.conceptSession(concept.courseId, concept.conceptId, sessionId)
      : mistakes
        ? [...qk.srs.mistakes(mistakes.courseId), sessionId]
        : qk.srs.session(sessionId),
    queryFn: (): Promise<DueCard[]> =>
      concept
        ? ipc.srs.dueByConcept(concept.courseId, concept.conceptId)
        : mistakes
          ? ipc.srs.mistakes(mistakes.courseId).then((list) => list.map(mistakeToDueCard))
          : ipc.srs.due(SESSION_LIMIT),
    // 会话期间锁定这批卡，复习不即时刷新列表（避免卡片在脚下位移）。
    staleTime: Infinity,
    // 关闭后立刻丢弃这副牌；下一次打开必须按最新排期重新取数。
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  /** 评完分的这张正被甩向右边（做完的那摞），动画结束才换下一张。 */
  const [tossing, setTossing] = useState(false);
  const [showCurve, setShowCurve] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const exitButtonRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const selectedOptionsRef = useRef<string[]>([]);
  const gradingRef = useRef(false);
  const cards = data ?? [];
  const card: DueCard | undefined = cards[index];
  const choiceData = getChoiceData(card);
  const done = !isLoading && !isError && index >= cards.length;

  const review = useMutation({
    mutationFn: ({ cardId, rating }: { cardId: string; rating: number }) =>
      mistakes ? ipc.srs.reviewMistake(cardId, rating) : ipc.srs.review(cardId, rating),
  });

  async function grade(rating: number) {
    if (!card || gradingRef.current) return;
    gradingRef.current = true;
    try {
      await review.mutateAsync({ cardId: card.id, rating });
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.srs.countDue() }),
        queryClient.invalidateQueries({ queryKey: qk.srs.nextDue() }),
        queryClient.invalidateQueries({ queryKey: qk.srs.dueByCourse() }),
        queryClient.invalidateQueries({ queryKey: qk.srs.conceptDue.all() }),
        queryClient.invalidateQueries({ queryKey: qk.weakConcepts() }),
        queryClient.invalidateQueries({ queryKey: ["srs-mistakes"] }),
      ]);
      // 不论评几分都往右甩：放到「做完的那摞」上。等级只看按钮，不看方向。
      if (!prefersReducedMotion()) {
        setTossing(true);
        await new Promise((resolve) => window.setTimeout(resolve, TOSS_MS));
      }
      setTossing(false);
      setRevealed(false);
      selectedOptionsRef.current = [];
      setSelectedOptions([]);
      setIndex((i) => i + 1);
    } catch {
      // useMutation keeps the error for the inline retry state below.
    } finally {
      gradingRef.current = false;
    }
  }

  function selectOption(option: string) {
    if (!choiceData || revealed) return;
    setSelectedOptions((selected) => {
      const next = choiceData.multiple
        ? selected.includes(option)
          ? selected.filter((item) => item !== option)
          : [...selected, option]
        : [option];
      selectedOptionsRef.current = next;
      return next;
    });
  }

  function revealAnswer() {
    if (choiceData && selectedOptionsRef.current.length === 0) return;
    setRevealed(true);
  }

  useEffect(() => {
    selectedOptionsRef.current = [];
    setSelectedOptions([]);
    setRevealed(false);
    setShowCurve(false);
  }, [card?.id]);

  // 会话结束刷新待复习计数（仪表盘据此更新）。
  useEffect(() => {
    if (done) queryClient.invalidateQueries({ queryKey: qk.srs.countDue() });
  }, [done, queryClient]);

  // 键盘：有选项时 A–Z 选答案，空格/回车翻面；翻面后 1–4 打分。
  // Esc 和焦点约束交给 Dialog，避免全局监听与模态关闭重复触发。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!card) return;
      if (!revealed && choiceData && e.key.length === 1) {
        const optionIndex = e.key.toLowerCase().charCodeAt(0) - 97;
        if (optionIndex >= 0 && optionIndex < choiceData.options.length) {
          e.preventDefault();
          selectOption(choiceData.options[optionIndex]);
          return;
        }
      }
      if (!revealed && (e.key === " " || e.key === "Enter")) {
        if (isInteractiveTarget(e.target)) return;
        e.preventDefault();
        revealAnswer();
        return;
      }
      if (revealed) {
        const g = GRADES.find((x) => x.key === e.key);
        if (g) grade(g.rating);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card, revealed]);

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !review.isPending) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--surface-app)]" />
        <Dialog.Content
          aria-modal="true"
          aria-describedby={undefined}
          // 焦点放在整屏容器上，不放在「退出」按钮上：界面提示「空格显示答案」，
          // 而空格落在已聚焦的按钮上会直接按下它——一进来按空格就退出了复习。
          ref={contentRef}
          tabIndex={-1}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocusRef.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (review.isPending) event.preventDefault();
          }}
          aria-busy={review.isPending}
          // 整屏覆盖：退出按钮和翻卡按钮都得让开状态栏、刘海和底部指示条。
          style={{ padding: "var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left)" }}
          className="fixed inset-0 z-50 flex flex-col bg-[var(--surface-app)] outline-none"
        >
      {/* 会话完成度：渐变进度承载「复习到哪了」，与全应用的进度语义一致。 */}
      {cards.length > 0 && !done && (
        <div role="progressbar" aria-label={t("review.title")} aria-valuemin={0} aria-valuemax={cards.length} aria-valuenow={index} className="h-1 w-full flex-none bg-[var(--surface-card-active)]">
          <div
            className="ca-fill-grad h-full transition-[width] duration-300 ease-out"
            style={{ width: `${Math.min(100, Math.round((index / cards.length) * 100))}%` }}
          />
        </div>
      )}
      <Dialog.Title className="sr-only">
        {concept ? `${t("review.title")}: ${concept.name}` : t("review.title")}
      </Dialog.Title>
      <header className="flex flex-none items-center justify-between border-b border-[var(--border-subtle)] px-6 py-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-[var(--text-strong)]">
            {concept ? concept.name : t("review.title")}
          </span>
          {cards.length > 0 && !done && (
            <span className="flex-none text-xs tabular-nums text-[var(--text-muted)]">
              {index + 1} / {cards.length}
            </span>
          )}
        </span>
        <button
          ref={exitButtonRef}
          type="button"
          aria-label={t("review.exit")}
          onClick={onClose}
          disabled={review.isPending}
          className="ca-icon-btn ca-touch-44"
        >
          <X className="h-5 w-5" />
        </button>
      </header>

      <div className="ca-review-stage min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="ca-review-center mx-auto flex min-h-full w-full max-w-xl flex-col">
          <div className="w-full">
          {isLoading ? (
            <p className="text-center text-sm text-[var(--text-faint)]">{t("review.loading")}</p>
          ) : isError ? (
            <div className="text-center">
              <p role="alert" className="text-sm text-[var(--status-err)]">
                {t("review.loadError", { error: String(error) })}
              </p>
              <button
                type="button"
                disabled={isFetching}
                onClick={() => void refetch()}
                className="ca-touch-44 mt-4 rounded-lg border border-[var(--border-subtle)] px-4 py-2 text-sm text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)] disabled:opacity-50"
              >
                {isFetching ? t("review.retrying") : t("review.retry")}
              </button>
            </div>
          ) : done ? (
            <div className="text-center">
              <div className="text-lg font-semibold text-[var(--text-strong)]">
                {cards.length === 0
                  ? concept
                    ? t("review.noConceptCards")
                    : t("review.noDueCards")
                  : t("review.completed")}
              </div>
              <Button
                variant="primary"
                onClick={onClose}
                className="ca-touch-44 mt-4"
              >
                {t("review.done")}
              </Button>
            </div>
          ) : card ? (
            <div className="ca-review-pile">
              {/* 卡下垫着的几张纸：剩得越少垫得越薄。 */}
              {Array.from({ length: Math.min(2, cards.length - index - 1) }, (_, depth) => (
                <span
                  key={depth}
                  aria-hidden="true"
                  className="ca-review-under"
                  style={{ "--d": depth + 1 } as React.CSSProperties}
                />
              ))}
            <div
              key={card.id}
              // 一张纸卡：翻面时绕竖轴转一下，评完分甩向右边。
              className="ca-review-card ca-card-enter"
              data-revealed={revealed ? "" : undefined}
              data-tossing={tossing ? "" : undefined}
            >
              <div className="ca-reading whitespace-pre-wrap text-center text-[length:calc(1.6rem*var(--reading-scale,1))] font-semibold leading-snug text-[var(--text-strong)]">
                {renderInlineMarkdown(card.front)}
              </div>

              {choiceData && (
                <div
                  className="mt-5 space-y-2"
                  role="group"
                  aria-label={choiceData.multiple ? t("review.choiceOptions") : t("review.singleOptions")}
                >
                  <div className="text-xs font-medium text-[var(--text-muted)]">
                    {choiceData.multiple ? t("review.multipleChoice") : t("review.singleChoice")}
                  </div>
                  {choiceData.options.map((option, optionIndex) => {
                    const selected = selectedOptions.includes(option);
                    const correct =
                      revealed && choiceData.correctOptions.includes(option);
                    const selectedWrong = revealed && selected && !correct;
                    const optionKey = String.fromCharCode(65 + optionIndex);
                    return (
                      <button
                        key={`${optionKey}-${option}`}
                        type="button"
                        aria-pressed={selected}
                        aria-label={t("review.optionLabel", { key: optionKey, option })}
                        onClick={() => selectOption(option)}
                        className={cn(
                          "ca-touch-44 flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition",
                          !revealed && selected
                            ? "border-[var(--accent-text)] bg-[var(--accent-weak)] text-[var(--text-strong)]"
                            : "border-[var(--border-subtle)] bg-[var(--surface-panel)] text-[var(--text-normal)]",
                          !revealed &&
                            "hover:border-[var(--border-strong)] hover:bg-[var(--surface-card-hover)]",
                          correct &&
                            "border-[var(--status-ok)] bg-[var(--status-ok-bg)] text-[var(--text-strong)]",
                          selectedWrong &&
                            "border-[var(--status-err)] bg-[var(--status-err-bg)] text-[var(--text-strong)]",
                        )}
                      >
                        <span
                          className={cn(
                            "grid h-7 w-7 flex-none place-items-center rounded-md border text-xs font-semibold",
                            selected && !revealed
                              ? "border-[var(--accent)] bg-[var(--accent)] !text-[var(--on-accent)]"
                              : "border-[var(--border-strong)] text-[var(--text-muted)]",
                            correct &&
                              "border-[var(--status-ok)] bg-[var(--status-ok)] !text-[var(--on-status-ok)]",
                            selectedWrong &&
                              "border-[var(--status-err)] bg-[var(--status-err)] !text-[var(--on-status-err)]",
                          )}
                        >
                          {revealed && (correct || selectedWrong) ? (
                            correct ? (
                              <Check className="h-4 w-4" aria-hidden="true" />
                            ) : (
                              <X className="h-4 w-4" aria-hidden="true" />
                            )
                          ) : (
                            optionKey
                          )}
                        </span>
                        <span className="min-w-0 flex-1 break-words">
                          <MathText text={option} />
                        </span>
                        {revealed && correct && (
                          <span className="flex-none text-xs font-medium text-[var(--status-ok)]">
                            {t("review.correctAnswer")}
                          </span>
                        )}
                        {selectedWrong && (
                          <span className="flex-none text-xs font-medium text-[var(--status-err)]">
                            {t("review.yourAnswer")}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {revealed ? (
                <div className="ca-reveal-enter">
                  {choiceData && (
                    <div
                      role="status"
                      className={cn(
                        "mt-4 flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium",
                        sameAnswers(selectedOptions, choiceData.correctOptions)
                          ? "bg-[var(--status-ok-bg)] text-[var(--status-ok)]"
                          : "bg-[var(--status-err-bg)] text-[var(--status-err)]",
                      )}
                    >
                      {sameAnswers(selectedOptions, choiceData.correctOptions) ? (
                        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <XCircle className="h-4 w-4" aria-hidden="true" />
                      )}
                      {sameAnswers(selectedOptions, choiceData.correctOptions)
                        ? t("review.answerCorrect")
                        : t("review.answerIncorrect")}
                    </div>
                  )}
                  <div className="mt-4 border-t border-[var(--border-subtle)] pt-4 text-center">
                    <div className="ca-reading whitespace-pre-wrap text-[length:calc(1rem*var(--reading-scale,1))] text-[var(--text-normal)]">
                      {renderInlineMarkdown(card.back)}
                    </div>
                    {card.source_ms != null && card.video_id && (
                      <button
                        onClick={() => onJump(card)}
                        disabled={review.isPending}
                        className="ca-touch-44 mt-3 inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {t("review.reviewSource")}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-expanded={showCurve}
                      onClick={() => setShowCurve((open) => !open)}
                      className="ca-touch-44 ml-3 mt-3 inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)] hover:underline"
                    >
                      <LineChart className="h-3.5 w-3.5" />
                      {t("memoryCurve.toggle")}
                    </button>
                    {showCurve && <MemoryCurve cardId={card.id} />}
                  </div>
                  <div className="mt-5 grid grid-cols-4 gap-2">
                    {GRADES.map((g) => {
                      // 该档按下去会推到多久之后。后端与真正落库的排期同源，这里只负责显示；
                      // 缺失（老后端）时整行不出现，不猜一个数字糊上去。
                      const interval = card.preview_ms?.[g.rating - 1];
                      return (
                        <button
                          key={g.rating}
                          type="button"
                          onClick={() => grade(g.rating)}
                          disabled={review.isPending}
                          aria-label={
                            interval == null
                              ? t(g.labelKey)
                              : t("review.nextReviewIn", { label: t(g.labelKey), interval: formatStudyInterval(interval) })
                          }
                          data-grade={g.rating}
                          className="ca-grade ca-touch-44"
                        >
                          <span className="ca-grade-label">{t(g.labelKey)}</span>
                          {interval != null && (
                            <span className="ca-grade-interval">{formatStudyInterval(interval)}</span>
                          )}
                          <kbd className="ca-grade-key">{g.key}</kbd>
                        </button>
                      );
                    })}
                  </div>
                  {review.isError && (
                    <p
                      role="alert"
                      className="mt-3 rounded-lg bg-[var(--status-err-bg)] px-3 py-2 text-center text-xs text-[var(--status-err)]"
                    >
                      {t("review.ratingError", { error: String(review.error) })}
                    </p>
                  )}
                </div>
              ) : (
                // 次要按钮、按文字宽：不再是一条横贯整张卡的蓝色长条（空格键同样能翻面）。
                <Button
                  variant={choiceData ? "primary" : "outline"}
                  onClick={revealAnswer}
                  disabled={Boolean(choiceData && selectedOptions.length === 0)}
                  className="ca-touch-44 mx-auto mt-10 flex min-w-40"
                >
                  {/* 包成一段：按钮是 flex，提示若单独成项会被 gap 拉开，和全角括号叠出一大块空白。 */}
                  <span>
                    {choiceData ? t("review.submitAnswer") : t("review.showAnswer")}
                    <span className="ca-kbd-hint">{t("review.spaceHint")}</span>
                  </span>
                </Button>
              )}
            </div>
            </div>
          ) : null}
          </div>
        </div>
      </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
