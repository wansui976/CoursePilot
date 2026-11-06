import { useMemo, useState, type ReactNode } from "react";
import { queries } from "@/lib/queries";
import { qk } from "@/lib/queryKeys";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import {
  Brain,
  Check,
  ChevronDown,
  CircleDashed,
  Eye,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";
import type { QuizGrade, QuizQuestion, QuizStyle } from "@/lib/types";
import { PanelEmptyState } from "@/ui/empty-state";
import { ErrorNote } from "@/ui/ErrorNote";
import { Skeleton } from "@/ui/skeleton";
import { Button } from "@/ui/button";
import { MathText } from "@/ui/MathText";
import { Menu, MenuItem } from "@/ui/menu";
import { ProgressRing } from "@/ui/ProgressRing";
import { PanelActions, GenerateEmptyAction } from "./PanelActions";
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
  const [setMenuOpen, setSetMenuOpen] = useState(false);

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

  // 套名：风格（旧题库那批叫「最初的一套」）；副标题：题数 · 生成时间。
  const setTitle = (set: QuizSet) =>
    set.id === "" && !set.style ? t("quiz.legacySet") : t(`quiz.styles.${set.style ?? "recall"}`);
  const setMeta = (set: QuizSet) =>
    [
      t("quiz.questionCount", { count: set.questions.length }),
      set.at
        ? new Date(set.at).toLocaleString(i18n.language, {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : null,
    ]
      .filter(Boolean)
      .join(" · ");

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
      <div aria-label={t("quiz.scrollArea")} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 pb-14">
        {!isError && generate.isError && <ErrorNote error={generate.error} onRetry={generate.start} />}
        {isLoading ? (
          <div className="space-y-3" role="status" aria-label={t("quiz.loading")}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-xl" />
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
            {addToReview.isError && <ErrorNote error={addToReview.error} onRetry={() => addToReview.mutate()} />}
            {removeSet.isError && <ErrorNote error={removeSet.error} />}
            {grade.isError && <ErrorNote error={grade.error} />}

            {/* 套别 + 操作：套名是个菜单（切换、删除），右边加入复习、再出一套。 */}
            <header className="space-y-2.5">
              <div className="flex items-center gap-1">
                <div className="relative min-w-0 flex-1">
                  <button
                    type="button"
                    aria-label={t("quiz.setPicker")}
                    aria-haspopup="menu"
                    aria-expanded={setMenuOpen}
                    onClick={() => setSetMenuOpen((open) => !open)}
                    className="ca-touch-44 -ml-1.5 flex max-w-full items-baseline gap-2 rounded-md px-1.5 py-1 text-left hover:bg-[var(--surface-card-hover)]"
                  >
                    <span className="truncate text-sm font-semibold text-[var(--text-strong)]">{setTitle(current)}</span>
                    <span className="ca-t-2xs flex-none text-[var(--text-faint)]">{setMeta(current)}</span>
                    <ChevronDown className="h-3.5 w-3.5 flex-none self-center text-[var(--text-faint)]" aria-hidden="true" />
                  </button>
                  {setMenuOpen && (
                    <Menu
                      aria-label={t("quiz.setPicker")}
                      onClose={() => setSetMenuOpen(false)}
                      className="absolute left-0 top-full z-30 mt-1 w-max min-w-[220px] max-w-[300px]"
                    >
                      {[...sets].reverse().map((set) => (
                        <MenuItem
                          key={set.id}
                          role="menuitemradio"
                          aria-checked={set.id === current.id}
                          className="flex items-center gap-2"
                          onClick={() => {
                            setPickedSet({ raw, id: set.id });
                            setSetMenuOpen(false);
                          }}
                        >
                          <Check
                            className={`h-3.5 w-3.5 flex-none ${set.id === current.id ? "text-[var(--accent-text)]" : "invisible"}`}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 truncate">{setTitle(set)}</span>
                          <span className="ca-t-2xs flex-none text-[var(--text-faint)]">{setMeta(set)}</span>
                        </MenuItem>
                      ))}
                      <MenuItem
                        tone="danger"
                        className="flex items-center gap-2 border-t border-[var(--border-faint)]"
                        disabled={removeSet.isPending}
                        onClick={() => {
                          setSetMenuOpen(false);
                          void confirmRemove(current);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        {t("quiz.deleteSet")}
                      </MenuItem>
                    </Menu>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={addToReview.isSuccess ? t("quiz.addedToReview") : t("quiz.addToReview")}
                  title={addToReview.isSuccess ? t("quiz.addedToReview") : t("quiz.addToReview")}
                  onClick={() => addToReview.mutate()}
                  disabled={addToReview.isPending}
                  className="ca-touch-44 h-8 w-8 flex-none px-0"
                >
                  {addToReview.isSuccess ? (
                    <Check className="h-4 w-4 text-[var(--status-ok)]" />
                  ) : (
                    <Brain className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setDialogOpen(true)}
                  disabled={generate.isPending}
                  className="ca-touch-44 flex-none gap-1.5 text-[var(--accent-text)] hover:text-[var(--accent-text)]"
                >
                  <Sparkles className={`h-3.5 w-3.5 ${generate.isPending ? "animate-pulse" : ""}`} />
                  {generate.isPending ? t("quiz.generating") : t("quiz.newSet")}
                </Button>
              </div>
              <div className="flex items-center gap-3">
                <div
                  className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--surface-card-active)]"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={total}
                  aria-valuenow={answeredCount}
                  aria-label={t("quiz.answeredCount", { count: answeredCount, total })}
                >
                  <div
                    className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300 ease-out"
                    style={{ width: `${(answeredCount / total) * 100}%` }}
                  />
                </div>
                <span className="ca-t-2xs flex-none tabular-nums text-[var(--text-faint)]">
                  {t("quiz.answeredCount", { count: answeredCount, total })}
                </span>
              </div>
            </header>

            {allAnswered && (
              <section
                aria-label={t("quiz.summaryTitle")}
                className="flex items-center gap-3 rounded-xl border border-[var(--accent-weak-2)] bg-[var(--accent-weak)] p-3"
              >
                <ProgressRing value={correctCount / total} size={44}>
                  <span className="ca-t-2xs font-semibold tabular-nums text-[var(--text-strong)]">
                    {correctCount}/{total}
                  </span>
                </ProgressRing>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-[var(--text-strong)]">{t("quiz.summaryTitle")}</p>
                  <p className="ca-t-xs text-[var(--text-muted)]">
                    {t("quiz.summaryDetail", { correct: correctCount, total })}
                    {partialCount > 0 && t("quiz.summaryPartial", { partial: partialCount })}
                  </p>
                </div>
                {correctCount < total && (
                  <Button type="button" variant="secondary" size="sm" onClick={() => resetSet(current)} className="ca-touch-44 flex-none gap-1.5">
                    <RotateCcw className="h-3.5 w-3.5" />
                    {t("quiz.retrySet")}
                  </Button>
                )}
              </section>
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
      {/* 有题时「再出一套」就在顶上，右下角的重新生成按钮只会挡住最后一题的按钮。 */}
      {!isError && !current && (
        <PanelActions onRegenerate={generate.start} regenerating={generate.isPending} hasContent={false} />
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

/** 作答后卡片右上角的小标：只用图标和字的颜色，不把整张卡染色。 */
function OutcomeTag({ outcome }: { outcome: Outcome }) {
  const { t } = useTranslation();
  const tone: Record<Outcome, [string, typeof Check]> = {
    correct: ["text-[var(--status-ok)]", Check],
    partial: ["text-[var(--status-warn)]", CircleDashed],
    wrong: ["text-[var(--status-err)]", X],
    skip: ["text-[var(--text-faint)]", Eye],
  };
  const [color, Icon] = tone[outcome];
  return (
    <span className={`ca-t-2xs inline-flex flex-none items-center gap-1 font-medium ${color}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {t(`quiz.outcome.${outcome}`)}
    </span>
  );
}

/** 选项前的圆形字母；作答后换成对 / 错的图标。 */
function OptionBadge({ letter, state }: { letter: string; state: "idle" | "picked" | "right" | "wrong" | "dim" }) {
  const look = {
    idle: "border border-[var(--border-strong)] text-[var(--text-muted)]",
    dim: "border border-[var(--border-subtle)] text-[var(--text-faint)]",
    picked: "bg-[var(--accent)] text-[var(--on-accent)]",
    right: "bg-[var(--status-ok)] text-[var(--on-status-ok)]",
    wrong: "bg-[var(--status-err)] text-[var(--on-status-err)]",
  }[state];
  return (
    <span className={`mt-px grid h-5 w-5 flex-none place-items-center rounded-full text-[11px] font-semibold ${look}`} aria-hidden="true">
      {state === "right" ? <Check className="h-3 w-3" strokeWidth={3} /> : state === "wrong" ? <X className="h-3 w-3" strokeWidth={3} /> : letter}
    </span>
  );
}

const ROW = "ca-touch-44 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm leading-relaxed transition-colors";

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

  const isAnswer = (opt: string) => (Array.isArray(q.answer) ? q.answer.includes(opt) : q.answer === opt);
  const rowLook = (picked: boolean, right: boolean) =>
    answered
      ? right
        ? "bg-[var(--status-ok-bg)] text-[var(--text-strong)]"
        : picked
          ? "bg-[var(--status-err-bg)] text-[var(--text-strong)]"
          : "text-[var(--text-muted)]"
      : picked
        ? "bg-[var(--accent-weak)] text-[var(--text-strong)] ring-1 ring-inset ring-[var(--accent)]"
        : "bg-[var(--surface-card-hover)] text-[var(--text-normal)] hover:bg-[var(--accent-weak)]";
  const badgeState = (picked: boolean, right: boolean) =>
    answered ? (right ? "right" : picked ? "wrong" : "dim") : picked ? "picked" : "idle";

  const seekLink = typeof q.ref_ms === "number" && (
    <button
      type="button"
      className="ca-touch-44 ca-t-2xs flex-none text-[var(--accent-text)] hover:underline"
      onClick={() => onSeek(q.ref_ms!)}
    >
      {t("quiz.jumpTo", { time: formatMs(q.ref_ms) })}
    </button>
  );

  return (
    <article className="rounded-xl border border-[var(--border-faint)] bg-[var(--surface-card)] p-3.5 shadow-[var(--shadow-card)]">
      <div className="ca-t-2xs flex items-center justify-between gap-2 text-[var(--text-faint)]">
        <span>
          {t("quiz.questionNumber", { n: index + 1 })} · {t(`quiz.types.${q.type}`)}
        </span>
        {state.outcome && <OutcomeTag outcome={state.outcome} />}
      </div>
      <div className="ca-prose mt-1.5 text-sm font-medium leading-relaxed text-[var(--text-strong)]">
        <MathText text={q.stem} />
      </div>

      {q.options && (
        <ul className="mt-3 space-y-1.5" aria-label={t("quiz.optionsLabel")}>
          {q.options.map((opt, j) => {
            const picked = (state.picked ?? draft).includes(j);
            const right = isAnswer(opt);
            const note = answered ? q.option_notes?.[j] : undefined;
            return (
              <li key={j}>
                <button
                  type="button"
                  aria-pressed={picked}
                  disabled={answered}
                  onClick={() => pickOption(j)}
                  className={`${ROW} disabled:cursor-default ${rowLook(picked, right)}`}
                >
                  <OptionBadge letter={String.fromCharCode(65 + j)} state={badgeState(picked, right)} />
                  <span className="ca-prose min-w-0 flex-1">
                    <MathText text={opt} />
                    {note && (
                      <span className="ca-t-xs mt-0.5 block text-[var(--text-muted)]">
                        <MathText text={note} />
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {q.type === "judge" && (
        <div className="mt-3 grid grid-cols-2 gap-1.5">
          {([true, false] as const).map((value) => {
            const picked = state.judged === value;
            const right = q.answer === value;
            return (
              <button
                key={String(value)}
                type="button"
                aria-pressed={picked}
                disabled={answered}
                onClick={() => onChange({ judged: value, outcome: right ? "correct" : "wrong" })}
                className={`${ROW} items-center justify-center disabled:cursor-default ${rowLook(picked, right)}`}
              >
                {value ? <Check className="h-4 w-4" aria-hidden="true" /> : <X className="h-4 w-4" aria-hidden="true" />}
                {value ? t("quiz.correct") : t("quiz.incorrect")}
              </button>
            );
          })}
        </div>
      )}

      {written && (
        <textarea
          aria-label={t(q.type === "correct" ? "quiz.placeholders.correct" : "quiz.placeholders.short")}
          className="mt-3 min-h-[72px] w-full resize-y rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm leading-relaxed text-[var(--text-strong)] outline-none transition placeholder:text-[var(--text-faint)] focus:border-[var(--accent)] disabled:text-[var(--text-normal)]"
          placeholder={t(q.type === "correct" ? "quiz.placeholders.correct" : "quiz.placeholders.short")}
          value={state.text ?? ""}
          disabled={answered || grading}
          onChange={(event) => onChange({ text: event.target.value })}
        />
      )}

      {!answered && (
        <div className="mt-2.5 flex items-center justify-between gap-2">
          <button
            type="button"
            className="ca-touch-44 ca-t-xs inline-flex items-center gap-1 text-[var(--text-faint)] hover:text-[var(--text-strong)]"
            onClick={() => onChange({ outcome: "skip" })}
          >
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            {t("quiz.showAnswer")}
          </button>
          {q.type === "multi" && (
            <Button type="button" size="sm" variant="primary" className="ca-touch-44" disabled={draft.length === 0} onClick={submitMulti}>
              {t("quiz.submit")}
            </Button>
          )}
          {written && (
            <Button
              type="button"
              size="sm"
              variant="primary"
              className="ca-touch-44"
              disabled={grading || (state.text ?? "").trim().length < 2}
              onClick={() => onGrade(state.text ?? "")}
            >
              {grading ? t("quiz.grading") : t("quiz.submitGrade")}
            </Button>
          )}
        </div>
      )}

      {answered && (
        <div className="mt-3 space-y-2.5 border-t border-[var(--border-faint)] pt-3">
          {state.grade && (
            <div role="status" className="space-y-1">
              {state.grade.feedback && (
                <p className="ca-prose text-sm leading-relaxed text-[var(--text-normal)]">
                  <MathText text={state.grade.feedback} />
                </p>
              )}
              {state.grade.missed.length > 0 && (
                <ul className="space-y-1">
                  {state.grade.missed.map((point, k) => (
                    <li key={k} className="ca-prose ca-t-xs flex items-start gap-1.5 text-[var(--text-muted)]">
                      <CircleDashed className="mt-0.5 h-3 w-3 flex-none" aria-hidden="true" />
                      <MathText text={point} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {/* 选择题的正确项已经标在选项上；判断、改错、简答把答案写出来。 */}
          {!q.options && (
            <Labeled label={written ? t("quiz.referenceLabel") : t("quiz.answerLabel")} action={q.explanation ? null : seekLink}>
              <MathText text={answerText(q.answer, t)} />
            </Labeled>
          )}
          {q.explanation && (
            <Labeled label={t("quiz.explanationLabel")} action={seekLink}>
              <MathText text={q.explanation} />
            </Labeled>
          )}
          {!q.explanation && q.options && seekLink && <div className="flex justify-end">{seekLink}</div>}
        </div>
      )}
    </article>
  );
}

function Labeled({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="ca-t-2xs font-medium text-[var(--text-faint)]">{label}</span>
        {action}
      </div>
      <div className="ca-prose mt-0.5 text-sm leading-relaxed text-[var(--text-normal)]">{children}</div>
    </div>
  );
}
