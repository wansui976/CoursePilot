import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Check, CircleHelp } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";
import type { QuizQuestion } from "@/lib/types";
import { PanelEmptyState } from "@/components/ui/empty-state";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Skeleton } from "@/components/ui/skeleton";
import { MathText } from "./MathText";
import { PanelActions } from "./PanelActions";
import {
  invalidateStaleArtifacts,
  useStaleArtifacts,
} from "@/lib/useStaleArtifacts";

function answerText(answer: QuizQuestion["answer"], t: (key: string) => string): string {
  if (Array.isArray(answer)) return answer.join("、");
  if (typeof answer === "boolean") return answer ? t("quiz.correct") : t("quiz.incorrect");
  return answer;
}

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

  // 没有 options 是正常的（判断题就没有）；有但不是字符串数组，说明这道题本身坏了：
  // 渲染出来是一道选不了的选择题，不如不显示。
  const hasOptions = item.options !== undefined && item.options !== null;
  const optionsOk =
    Array.isArray(item.options) && item.options.every((one) => typeof one === "string");
  if (hasOptions && !optionsOk) return null;
  const options = optionsOk ? (item.options as string[]) : undefined;

  return {
    type: item.type === "multi" || item.type === "judge" ? item.type : "single",
    stem,
    options,
    answer: answer as QuizQuestion["answer"],
    explanation: typeof item.explanation === "string" ? item.explanation : undefined,
    ref_ms: typeof item.ref_ms === "number" && item.ref_ms >= 0 ? item.ref_ms : undefined,
  };
}

export function QuizPanel({ videoId }: { videoId: string }) {
  const { t } = useTranslation();
  const requestSeek = usePlayer((s) => s.requestSeek);
  const queryClient = useQueryClient();
  const { data: raw, isLoading } = useQuery({
    queryKey: ["quiz", videoId],
    queryFn: () => ipc.ai.getQuiz(videoId),
  });
  const [revealedState, setRevealedState] = useState<{
    videoId: string;
    raw: string | null | undefined;
    values: Record<number, boolean>;
  }>({ videoId, raw, values: {} });
  // 题库版本一变，本次 render 就使用空状态。不能等 useEffect，后者会让新题先带着
  // 旧下标的答案画出一帧，再于绘制后收起来。
  const revealed =
    revealedState.videoId === videoId && revealedState.raw === raw
      ? revealedState.values
      : {};

  // 把这套题加入每日间隔重复复习。
  const addToReview = useMutation({
    mutationFn: () => ipc.srs.generate(videoId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["srs-count-due"] }),
  });

  const stale = useStaleArtifacts(videoId);
  const generate = useMutation({
    mutationFn: () => ipc.ai.generate(videoId, "quiz"),
    onSuccess: () => {
      setRevealedState({ videoId, raw, values: {} });
      queryClient.invalidateQueries({ queryKey: ["quiz", videoId] });
      invalidateStaleArtifacts(queryClient, videoId);
    },
  });

  const questions = useMemo<QuizQuestion[]>(() => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      // 校验前生成的旧题库可能不是数组（如 {"questions":[...]}），非数组直接当空，避免渲染时崩溃。
      if (!Array.isArray(parsed)) return [];
      // 逐题过筛：坏题丢掉、好题照常显示（见 sanitizeQuestion）。
      return parsed
        .map(sanitizeQuestion)
        .filter((one): one is QuizQuestion => one !== null);
    } catch {
      return [];
    }
  }, [raw]);

  // 加载中和空题库原先是提前 return 的，绕过了整个外壳——于是「点右下角生成」
  // 承诺的那个按钮，恰恰在最需要它的空状态下不存在。三种状态共用一个外壳。
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* 内层自己滚：标签页容器是 overflow-hidden 的，面板不自带滚动区，题目一多
          就被直接裁掉——不是滚不动，是压根没地方滚。文稿、笔记、章节都是这套写法。
          pb-12 给右下角那组悬浮按钮让位，免得压住最后一题。 */}
      <div
        aria-label={t("quiz.scrollArea")}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pb-12"
      >
        {generate.isError && (
          <ErrorNote error={generate.error} onRetry={() => generate.mutate()} />
        )}
        {isLoading ? (
          <div className="space-y-4" role="status" aria-label={t("quiz.loading")}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : questions.length === 0 ? (
          <PanelEmptyState
            icon={<CircleHelp className="h-7 w-7" />}
            title={t("quiz.emptyTitle")}
            description={t("quiz.emptyDescription")}
          />
        ) : (
          <>
            <button
              onClick={() => addToReview.mutate()}
              disabled={addToReview.isPending}
              className="ca-touch-44 inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--text-normal)] transition hover:bg-[var(--surface-card-hover)] disabled:opacity-60"
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
            </button>
            {questions.map((q, i) => (
              <div key={i} className="rounded border border-[var(--border-subtle)] p-3">
                <div className="mb-2 text-sm">
                  <span className="mr-1 text-[var(--text-faint)]">{i + 1}.</span>
                  <MathText text={q.stem} />
                </div>
                {q.options && (
                  <ul className="mb-2 space-y-1 text-sm text-[var(--text-normal)]">
                    {q.options.map((opt, j) => (
                      <li key={j}>
                        {String.fromCharCode(65 + j)}. <MathText text={opt} />
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  className="ca-touch-44 inline-flex items-center text-xs text-primary hover:underline"
                  onClick={() =>
                    setRevealedState((current) => {
                      const values =
                        current.videoId === videoId && current.raw === raw
                          ? current.values
                          : {};
                      return {
                        videoId,
                        raw,
                        values: { ...values, [i]: !values[i] },
                      };
                    })
                  }
                >
                  {revealed[i] ? t("quiz.hideAnswer") : t("quiz.showAnswer")}
                </button>
                {revealed[i] && (
                  <div className="mt-2 space-y-1 text-sm">
                    {/* 答案色走主题 token：深浅主题对比都达标，不硬编码 tailwind 绿。 */}
                    <div className="text-[var(--status-ok)]">
                      {t("quiz.answerLabel")}<MathText text={answerText(q.answer, t)} />
                    </div>
                    {q.explanation && (
                      <div className="text-[var(--text-muted)]">
                        <MathText text={q.explanation} />
                      </div>
                    )}
                    {typeof q.ref_ms === "number" && (
                      <button
                        className="ca-touch-44 inline-flex items-center text-xs text-primary"
                        onClick={() => requestSeek(q.ref_ms!)}
                      >
                        {t("quiz.jumpTo", { time: formatMs(q.ref_ms) })}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
      <PanelActions
        onRegenerate={() => generate.mutate()}
        regenerating={generate.isPending}
        hasContent={questions.length > 0}
        stale={stale.has("quiz")}
      />
    </div>
  );
}
