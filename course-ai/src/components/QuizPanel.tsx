import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";
import type { QuizQuestion } from "@/lib/types";
import { MathText } from "./MathText";

function answerText(answer: QuizQuestion["answer"]): string {
  if (Array.isArray(answer)) return answer.join("、");
  if (typeof answer === "boolean") return answer ? "正确" : "错误";
  return answer;
}

export function QuizPanel({ videoId }: { videoId: string }) {
  const requestSeek = usePlayer((s) => s.requestSeek);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  const { data: raw } = useQuery({
    queryKey: ["quiz", videoId],
    queryFn: () => ipc.ai.getQuiz(videoId),
  });

  const questions = useMemo<QuizQuestion[]>(() => {
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }, [raw]);

  if (questions.length === 0) {
    return (
      <p className="p-4 text-sm text-[var(--text-faint)]">
        还没有题目，字幕就绪后会自动生成，也可点右下角重新生成。
      </p>
    );
  }

  return (
    <div className="space-y-4 p-4">
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
            className="text-xs text-primary hover:underline"
            onClick={() => setRevealed((r) => ({ ...r, [i]: !r[i] }))}
          >
            {revealed[i] ? "隐藏答案" : "显示答案"}
          </button>
          {revealed[i] && (
            <div className="mt-2 space-y-1 text-sm">
              <div className="text-green-400">
                答案：<MathText text={answerText(q.answer)} />
              </div>
              {q.explanation && (
                <div className="text-[var(--text-muted)]">
                  <MathText text={q.explanation} />
                </div>
              )}
              {typeof q.ref_ms === "number" && (
                <button
                  className="text-xs text-primary"
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
