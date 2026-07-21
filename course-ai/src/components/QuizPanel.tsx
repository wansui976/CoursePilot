import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Check } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";
import type { QuizQuestion } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { MathText } from "./MathText";

function answerText(answer: QuizQuestion["answer"]): string {
  if (Array.isArray(answer)) return answer.join("、");
  if (typeof answer === "boolean") return answer ? "正确" : "错误";
  return answer;
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

  const questions = useMemo<QuizQuestion[]>(() => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      // 校验前生成的旧题库可能不是数组（如 {"questions":[...]}），非数组直接当空，避免渲染时崩溃。
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [raw]);

  if (isLoading) {
    return (
      <div className="space-y-4 p-4" role="status" aria-label="加载中…">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }
  if (questions.length === 0) {
    return (
      <p className="p-4 text-sm text-[var(--text-faint)]">
        还没有题目，字幕就绪后会自动生成，也可点右下角生成。
      </p>
    );
  }

  return (
    <div className="space-y-4 p-4">
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
    </div>
  );
}
