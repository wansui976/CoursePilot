import { useMemo, useState } from "react";
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

function answerText(answer: QuizQuestion["answer"]): string {
  if (Array.isArray(answer)) return answer.join("、");
  if (typeof answer === "boolean") return answer ? "正确" : "错误";
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
  const requestSeek = usePlayer((s) => s.requestSeek);
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  const { data: raw, isLoading } = useQuery({
    queryKey: ["quiz", videoId],
    queryFn: () => ipc.ai.getQuiz(videoId),
  });

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
        aria-label="练习内容滚动区"
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pb-12"
      >
        {generate.isError && (
          <ErrorNote error={generate.error} onRetry={() => generate.mutate()} />
        )}
        {isLoading ? (
          <div className="space-y-4" role="status" aria-label="加载中…">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : questions.length === 0 ? (
          <PanelEmptyState
            icon={<CircleHelp className="h-7 w-7" />}
            title="还没有题目"
            description="字幕就绪后会自动生成，也可以点右下角手动生成。"
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
                  已加入复习
                </>
              ) : (
                <>
                  <Brain className="h-3.5 w-3.5" />
                  {addToReview.isPending ? "加入中…" : "加入每日复习"}
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
                  onClick={() => setRevealed((r) => ({ ...r, [i]: !r[i] }))}
                >
                  {revealed[i] ? "隐藏答案" : "显示答案"}
                </button>
                {revealed[i] && (
                  <div className="mt-2 space-y-1 text-sm">
                    {/* 答案色走主题 token：深浅主题对比都达标，不硬编码 tailwind 绿。 */}
                    <div className="text-[var(--status-ok)]">
                      答案：<MathText text={answerText(q.answer)} />
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
                        ▶ 跳到 {formatMs(q.ref_ms)}
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
