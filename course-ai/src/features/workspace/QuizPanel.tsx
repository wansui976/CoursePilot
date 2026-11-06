import { useMemo, useState } from "react";
import { queries } from "@/lib/queries";
import { qk } from "@/lib/queryKeys";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { Brain, Check, CheckCircle2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";
import type { QuizGrade, QuizQuestion, QuizStyle } from "@/lib/types";
import { PanelEmptyState } from "@/ui/empty-state";
import { ErrorNote } from "@/ui/ErrorNote";
import { Skeleton } from "@/ui/skeleton";
import { Button } from "@/ui/button";
import { MathText } from "@/ui/MathText";
import { PanelActions, GenerateEmptyAction, panelActionButtonClass } from "./PanelActions";
import { useAiGeneration } from "@/lib/useAiGeneration";
import { QUIZ_STYLES } from "@/lib/quizStyles";
import { QuizSetDialog } from "./QuizSetDialog";

const TYPES = ["single", "multi", "judge", "correct", "short"] as const;

function answerText(answer: QuizQuestion["answer"], t: (key: string) => string): string {
  if (Array.isArray(answer)) return answer.join("、");
  if (typeof answer === "boolean") return answer ? t("quiz.correct") : t("quiz.incorrect");
  return answer;
}

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((one) => typeof one === "string") ? (value as string[]) : undefined;

/**
 * 把库里存的一条题目收敛成能安全渲染的形状；不合格返回 null。
 *
 * 后端现在逐题校验了，但**已经存在库里的**题库是在那之前生成的，里面可能有
 * `{}`、`stem: null`、options 写成字符串这些东西。渲染时 `options.map` 撞上字符串
 * 就是 TypeError，整个面板白屏——一道坏题不该毁掉整套题。
 */
function sanitizeQuestion(raw: unknown): QuizQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const stem = typeof item.stem === "string" ? item.stem.trim() : "";
  if (!stem) return null;

  const answer = item.answer;
  const answerOk =
    typeof answer === "string" ||
    typeof answer === "boolean" ||
    (Array.isArray(answer) && answer.every((one) => typeof one === "string"));
  if (!answerOk) return null;

  // 没有 options 是正常的（判断、改错、简答就没有）；有但不是字符串数组，说明这道题本身坏了：
  // 渲染出来是一道选不了的选择题，不如不显示。
  const hasOptions = item.options !== undefined && item.options !== null;
  const options = stringList(item.options);
  if (hasOptions && !options) return null;
  const type = TYPES.find((one) => one === item.type) ?? "single";
  const notes = stringList(item.option_notes);

  return {
    type,
    stem,
    options,
    answer: answer as QuizQuestion["answer"],
    explanation: typeof item.explanation === "string" ? item.explanation : undefined,
    ref_ms: typeof item.ref_ms === "number" && item.ref_ms >= 0 ? item.ref_ms : undefined,
    option_notes: options && notes && notes.length === options.length ? notes : undefined,
    key_points: stringList(item.key_points),
    set_id: typeof item.set_id === "string" ? item.set_id : undefined,
    style: QUIZ_STYLES.find((one) => one === item.style),
    set_at: typeof item.set_at === "number" ? item.set_at : undefined,
  };
}

/** 一套题：「再出一套」追加的题按 set_id 分组；旧题库里没有 set_id 的算一套（id 为空串）。 */
type QuizSet = { id: string; style?: QuizStyle; at?: number; questions: QuizQuestion[] };

function groupSets(questions: QuizQuestion[]): QuizSet[] {
  const sets: QuizSet[] = [];
  for (const question of questions) {
    const id = question.set_id ?? "";
    let set = sets.find((one) => one.id === id);
    if (!set) {
      set = { id, style: question.style, at: question.set_at, questions: [] };
      sets.push(set);
    }
    set.questions.push(question);
  }
  return sets;
}

/** 一道题的作答情况。选择题前端判，改错 / 简答交给模型判。看了答案没作答算 skip。 */
type Outcome = "correct" | "partial" | "wrong" | "skip";
type AnswerState = {
  outcome?: Outcome;
  /** 选中的选项下标（单选 / 多选）。 */
  picked?: number[];
  /** 判断题选的是「正确」还是「错误」。 */
  judged?: boolean;
  text?: string;
  grade?: QuizGrade;
};

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((one) => b.includes(one));
}

export function QuizPanel({ videoId }: { videoId: string }) {
  const { t, i18n } = useTranslation();
  const requestSeek = usePlayer((s) => s.requestSeek);
  const queryClient = useQueryClient();
  const { data: raw, isLoading, isError, error, refetch } = useQuery(queries.quiz(videoId));
  const [dialogOpen, setDialogOpen] = useState(false);

  // 作答状态随题库版本重置：不能等 useEffect，后者会让新题先带着旧下标的答案画出一帧。
  const [answersState, setAnswersState] = useState<{
    videoId: string;
    raw: string | null | undefined;
    values: Record<string, AnswerState>;
  }>({ videoId, raw, values: {} });
  const answers =
    answersState.videoId === videoId && answersState.raw === raw ? answersState.values : {};
  const [pickedSet, setPickedSet] = useState<{ raw: string | null | undefined; id: string } | null>(null);

  // 把这套题加入每日间隔重复复习。
  const addToReview = useMutation({
    mutationFn: () => ipc.srs.generate(videoId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.srs.countDue() }),
  });

  const generate = useAiGeneration(videoId, "quiz");

  const questions = useMemo<QuizQuestion[]>(() => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      // 校验前生成的旧题库可能不是数组（如 {"questions":[...]}），非数组直接当空，避免渲染时崩溃。
      if (!Array.isArray(parsed)) return [];
      // 逐题过筛：坏题丢掉、好题照常显示（见 sanitizeQuestion）。
      return parsed.map(sanitizeQuestion).filter((one): one is QuizQuestion => one !== null);
    } catch {
      return [];
    }
  }, [raw]);
  const sets = useMemo(() => groupSets(questions), [questions]);
  // 默认看最新的一套；题库一变（追加了新的一套）就跳到最新那套。
  const current =
    sets.find((set) => pickedSet?.raw === raw && set.id === pickedSet?.id) ?? sets[sets.length - 1];

  const keyOf = (setId: string, index: number) => `${setId}:${index}`;
  function update(key: string, patch: AnswerState) {
    setAnswersState((state) => {
      const values = state.videoId === videoId && state.raw === raw ? state.values : {};
      return { videoId, raw, values: { ...values, [key]: { ...values[key], ...patch } } };
    });
  }
  function resetSet(set: QuizSet) {
    setAnswersState((state) => {
      const values = { ...(state.videoId === videoId && state.raw === raw ? state.values : {}) };
      set.questions.forEach((_q, i) => delete values[keyOf(set.id, i)]);
      return { videoId, raw, values };
    });
  }

  const grade = useMutation({
    mutationFn: ({ question, text }: { key: string; question: QuizQuestion; text: string }) =>
      ipc.ai.gradeQuizAnswer(videoId, question, text),
    onSuccess: (result, { key }) => update(key, { grade: result, outcome: result.verdict }),
  });

  const removeSet = useMutation({
    mutationFn: (setId: string) => ipc.ai.deleteQuizSet(videoId, setId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.artifact("quiz", videoId) }),
  });

  async function confirmRemove(set: QuizSet) {
    const ok = await confirmDialog(t("quiz.deleteSetConfirm", { count: set.questions.length }), {
      kind: "warning",
    });
    if (ok) removeSet.mutate(set.id);
  }

  const setLabel = (set: QuizSet) =>
    set.id === "" && !set.style
      ? t("quiz.legacySet", { count: set.questions.length })
      : t("quiz.setLabel", {
          style: t(`quiz.styles.${set.style ?? "recall"}`),
          time: set.at
            ? new Date(set.at).toLocaleString(i18n.language, {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
            : "",
          count: set.questions.length,
        });

  const outcomes = current
    ? current.questions.map((_q, i) => answers[keyOf(current.id, i)]?.outcome)
    : [];
  const answeredCount = outcomes.filter(Boolean).length;
  const correctCount = outcomes.filter((one) => one === "correct").length;
  const partialCount = outcomes.filter((one) => one === "partial").length;
  const total = current?.questions.length ?? 0;
  const allAnswered = total > 0 && answeredCount === total;

  // 加载中和空题库原先共用外壳：右下角「生成」按钮在最需要的空状态下也存在。
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div aria-label={t("quiz.scrollArea")} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pb-12">
        {!isError && generate.isError && <ErrorNote error={generate.error} onRetry={generate.start} />}
        {isLoading ? (
          <div className="space-y-4" role="status" aria-label={t("quiz.loading")}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : isError ? (
          <ErrorNote error={error} onRetry={() => void refetch()} />
        ) : !current ? (
          <PanelEmptyState
            title={t("quiz.emptyTitle")}
            description={t("quiz.emptyDescription")}
            action={<GenerateEmptyAction onGenerate={generate.start} generating={generate.isPending} />}
          />
        ) : (
          <>
            {addToReview.isError && (
              <ErrorNote error={addToReview.error} onRetry={() => addToReview.mutate()} />
            )}
            {removeSet.isError && <ErrorNote error={removeSet.error} />}
            {grade.isError && <ErrorNote error={grade.error} />}
            {/* 套别：再出一套的题接在后面，在这里切换；默认看最新的。 */}
            <div className="flex flex-wrap items-center gap-2">
              {sets.length > 1 ? (
                <select
                  aria-label={t("quiz.setPicker")}
                  className="ca-touch-44 min-w-0 flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-normal)]"
                  value={current.id}
                  onChange={(event) => setPickedSet({ raw, id: event.target.value })}
                >
                  {[...sets].reverse().map((set) => (
                    <option key={set.id} value={set.id}>
                      {setLabel(set)}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-muted)]">{setLabel(current)}</span>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDialogOpen(true)}
                disabled={generate.isPending}
                className="ca-touch-44 flex-none gap-1.5"
              >
                <Plus className="h-3.5 w-3.5" />
                {generate.isPending ? t("quiz.generating") : t("quiz.newSet")}
              </Button>
              <button
                type="button"
                aria-label={t("quiz.deleteSet")}
                title={t("quiz.deleteSet")}
                onClick={() => void confirmRemove(current)}
                disabled={removeSet.isPending}
                className={panelActionButtonClass}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            {/* 进度：已答 x/y + 进度条；答完出小结。 */}
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--text-muted)]">
                    {t("quiz.progress", { current: Math.min(answeredCount + 1, total), total })}
                  </span>
                  <span className="tabular-nums text-[var(--text-faint)]">
                    {t("quiz.answeredCount", { count: answeredCount, total })}
                  </span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--surface-card-hover)]">
                  <div
                    className="ca-fill-grad h-full rounded-full transition-[width] duration-300 ease-out"
                    style={{ width: `${(answeredCount / total) * 100}%` }}
                  />
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => addToReview.mutate()}
                disabled={addToReview.isPending}
                className="ca-touch-44 flex-none gap-1.5"
              >
                {addToReview.isSuccess ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-[var(--status-ok)]" />
                    {t("quiz.addedToReview")}
                  </>
                ) : (
                  <>
                    <Brain className="h-3.5 w-3.5" />
                    {addToReview.isPending ? t("quiz.addingToReview") : t("quiz.addToReview")}
                  </>
                )}
              </Button>
            </div>

            {allAnswered && (
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-strong)]">
                  <CheckCircle2 className="h-4 w-4 text-[var(--status-ok)]" />
                  {t("quiz.summaryTitle")}
                </div>
                <p className="mt-1 text-sm text-[var(--text-normal)]">
                  {t("quiz.summaryDetail", { correct: correctCount, total })}
                  {partialCount > 0 && t("quiz.summaryPartial", { partial: partialCount })}
                </p>
                {correctCount < total && (
                  <button
                    type="button"
                    onClick={() => resetSet(current)}
                    className="ca-touch-44 mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {t("quiz.retrySet")}
                  </button>
                )}
              </div>
            )}

            {current.questions.map((q, i) => {
              const key = keyOf(current.id, i);
              return (
                <QuestionCard
                  key={key}
                  index={i}
                  question={q}
                  state={answers[key] ?? {}}
                  grading={grade.isPending && grade.variables?.key === key}
                  onChange={(patch) => update(key, patch)}
                  onGrade={(text) => grade.mutate({ key, question: q, text })}
                  onSeek={requestSeek}
                />
              );
            })}
          </>
        )}
      </div>
      {!isError && (
        <PanelActions
          onRegenerate={current ? () => setDialogOpen(true) : generate.start}
          regenerating={generate.isPending}
          hasContent={Boolean(current)}
        />
      )}
      <QuizSetDialog
        videoId={videoId}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onStart={(options) => generate.startWith(options)}
      />
    </div>
  );
}

const OUTCOME_CARD: Record<Outcome, string> = {
  correct: "border-[var(--status-ok)]/50 bg-[var(--status-ok-bg)]/40",
  partial: "border-[var(--status-warn)]/50 bg-[var(--status-warn-bg)]/30",
  wrong: "border-[var(--status-err)]/50 bg-[var(--status-err-bg)]/40",
  skip: "border-[var(--border-subtle)]",
};

function QuestionCard({
  index,
  question: q,
  state,
  grading,
  onChange,
  onGrade,
  onSeek,
}: {
  index: number;
  question: QuizQuestion;
  state: AnswerState;
  grading: boolean;
  onChange: (patch: AnswerState) => void;
  onGrade: (text: string) => void;
  onSeek: (ms: number) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<number[]>([]);
  // 作答过或者看过答案都算这道题结束了：先看答案再点选项不能算答对。
  const answered = Boolean(state.outcome);
  const showAnswer = answered;
  const written = q.type === "correct" || q.type === "short";

  function pickOption(j: number) {
    if (answered || !q.options) return;
    if (q.type === "multi") {
      setDraft((current) => (current.includes(j) ? current.filter((one) => one !== j) : [...current, j]));
      return;
    }
    onChange({ picked: [j], outcome: q.options[j] === q.answer ? "correct" : "wrong" });
  }

  function submitMulti() {
    if (!q.options || draft.length === 0) return;
    const chosen = draft.map((j) => q.options![j]);
    const expected = Array.isArray(q.answer) ? q.answer : [String(q.answer)];
    onChange({ picked: draft, outcome: sameSet(chosen, expected) ? "correct" : "wrong" });
  }

  const correctOption = (opt: string) =>
    Array.isArray(q.answer) ? q.answer.includes(opt) : q.answer === opt;

  return (
    <div className={`rounded-lg border p-3 ${state.outcome ? OUTCOME_CARD[state.outcome] : "border-[var(--border-subtle)]"}`}>
      <div className="ca-prose mb-2 text-sm leading-relaxed">
        <span className="mr-1 text-[var(--text-faint)]">{index + 1}.</span>
        <span className="mr-1.5 rounded bg-[var(--surface-card-hover)] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]">
          {t(`quiz.types.${q.type}`)}
        </span>
        <MathText text={q.stem} />
      </div>

      {q.options && (
        <ul className="mb-2 space-y-1.5" aria-label={t("quiz.optionsLabel")}>
          {q.options.map((opt, j) => {
            const picked = (state.picked ?? draft).includes(j);
            const isAnswer = correctOption(opt);
            const tone = showAnswer
              ? isAnswer
                ? "border-[var(--status-ok)]/60 bg-[var(--status-ok)]/10"
                : picked
                  ? "border-[var(--status-err)]/60 bg-[var(--status-err)]/10"
                  : "border-[var(--border-subtle)] opacity-80"
              : picked
                ? "border-primary bg-primary/10"
                : "border-[var(--border-subtle)] hover:bg-[var(--surface-card-hover)]";
            return (
              <li key={j}>
                <button
                  type="button"
                  aria-pressed={picked}
                  disabled={answered}
                  onClick={() => pickOption(j)}
                  className={`ca-touch-44 ca-prose w-full rounded-md border px-2.5 py-1.5 text-left text-sm leading-relaxed text-[var(--text-normal)] transition-colors disabled:cursor-default ${tone}`}
                >
                  {String.fromCharCode(65 + j)}. <MathText text={opt} />
                </button>
                {showAnswer && q.option_notes?.[j] && (
                  <p className="ca-prose mt-0.5 pl-3 text-xs leading-relaxed text-[var(--text-muted)]">
                    <MathText text={q.option_notes[j]} />
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {q.type === "multi" && !answered && (
        <Button type="button" size="sm" variant="outline" className="ca-touch-44 mb-2" disabled={draft.length === 0} onClick={submitMulti}>
          {t("quiz.submit")}
        </Button>
      )}

      {q.type === "judge" && (
        <div className="mb-2 flex gap-2">
          {([true, false] as const).map((value) => {
            const picked = state.judged === value;
            const tone = showAnswer
              ? q.answer === value
                ? "border-[var(--status-ok)]/60 bg-[var(--status-ok)]/10"
                : picked
                  ? "border-[var(--status-err)]/60 bg-[var(--status-err)]/10"
                  : "border-[var(--border-subtle)]"
              : "border-[var(--border-subtle)] hover:bg-[var(--surface-card-hover)]";
            return (
              <button
                key={String(value)}
                type="button"
                aria-pressed={picked}
                disabled={answered}
                onClick={() => onChange({ judged: value, outcome: q.answer === value ? "correct" : "wrong" })}
                className={`ca-touch-44 flex-1 rounded-md border px-3 py-1.5 text-sm text-[var(--text-normal)] disabled:cursor-default ${tone}`}
              >
                {value ? t("quiz.correct") : t("quiz.incorrect")}
              </button>
            );
          })}
        </div>
      )}

      {written && (
        <div className="mb-2 space-y-2">
          <textarea
            aria-label={t(q.type === "correct" ? "quiz.placeholders.correct" : "quiz.placeholders.short")}
            className="min-h-[64px] w-full resize-y rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2.5 py-2 text-sm text-[var(--text-normal)] outline-none focus:border-primary disabled:opacity-80"
            placeholder={t(q.type === "correct" ? "quiz.placeholders.correct" : "quiz.placeholders.short")}
            value={state.text ?? ""}
            disabled={answered || grading}
            onChange={(event) => onChange({ text: event.target.value })}
          />
          {!answered && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ca-touch-44"
              disabled={grading || (state.text ?? "").trim().length < 2}
              onClick={() => onGrade(state.text ?? "")}
            >
              {grading ? t("quiz.grading") : t("quiz.submitGrade")}
            </Button>
          )}
          {state.grade && (
            <div className="ca-prose space-y-1 text-sm leading-relaxed" role="status">
              <div
                className={`font-medium ${
                  state.grade.verdict === "correct"
                    ? "text-[var(--status-ok)]"
                    : state.grade.verdict === "partial"
                      ? "text-[var(--status-warn)]"
                      : "text-[var(--status-err)]"
                }`}
              >
                {t(`quiz.verdict.${state.grade.verdict}`)}
              </div>
              {state.grade.feedback && (
                <div className="text-[var(--text-normal)]">
                  <MathText text={state.grade.feedback} />
                </div>
              )}
              {state.grade.missed.length > 0 && (
                <ul className="list-disc pl-5 text-[var(--text-muted)]">
                  {state.grade.missed.map((point, k) => (
                    <li key={k}>
                      <MathText text={point} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {!answered && (
          <button
            type="button"
            className="ca-touch-44 inline-flex items-center text-xs text-primary hover:underline"
            onClick={() => onChange({ outcome: "skip" })}
          >
            {t("quiz.showAnswer")}
          </button>
        )}
      </div>

      {showAnswer && (
        <div className="ca-prose mt-2 space-y-1 text-sm leading-relaxed">
          {/* 答案色走主题 token：深浅主题对比都达标，不硬编码 tailwind 绿。 */}
          <div className="text-[var(--status-ok)]">
            {written ? t("quiz.referenceLabel") : t("quiz.answerLabel")}
            <MathText text={answerText(q.answer, t)} />
          </div>
          {q.explanation && (
            <div className="text-[var(--text-muted)]">
              <MathText text={q.explanation} />
            </div>
          )}
          {/* 答错后给回看入口：直接跳去这句讲的地方。 */}
          {typeof q.ref_ms === "number" && (
            <button className="ca-touch-44 inline-flex items-center text-xs text-primary" onClick={() => onSeek(q.ref_ms!)}>
              {t("quiz.jumpTo", { time: formatMs(q.ref_ms) })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
