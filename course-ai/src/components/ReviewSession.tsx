import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, X } from "lucide-react";
import { ipc, type DueCard } from "@/lib/ipc";

const GRADES: { rating: number; label: string; key: string }[] = [
  { rating: 1, label: "重来", key: "1" },
  { rating: 2, label: "困难", key: "2" },
  { rating: 3, label: "良好", key: "3" },
  { rating: 4, label: "容易", key: "4" },
];
const SESSION_LIMIT = 50;

/** 全屏、纯键盘的复习会话：空格翻面，1–4 打分，答错可回看出处。 */
export function ReviewSession({
  onClose,
  onJump,
}: {
  onClose: () => void;
  onJump: (card: DueCard) => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["srs-due-session"],
    queryFn: () => ipc.srs.due(SESSION_LIMIT),
    // 会话期间锁定这批卡，复习不即时刷新列表（避免卡片在脚下位移）。
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const cards = data ?? [];
  const card: DueCard | undefined = cards[index];
  const done = !isLoading && index >= cards.length;

  const review = useMutation({
    mutationFn: ({ cardId, rating }: { cardId: string; rating: number }) =>
      ipc.srs.review(cardId, rating),
  });

  function grade(rating: number) {
    if (!card) return;
    review.mutate({ cardId: card.id, rating });
    setRevealed(false);
    setIndex((i) => i + 1);
  }

  // 会话结束刷新待复习计数（仪表盘据此更新）。
  useEffect(() => {
    if (done) queryClient.invalidateQueries({ queryKey: ["srs-count-due"] });
  }, [done, queryClient]);

  // 键盘：空格/回车翻面；翻面后 1–4 打分；Esc 关闭。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (!card) return;
      if (!revealed && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        setRevealed(true);
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
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--surface-app)]">
      <header className="flex flex-none items-center justify-between border-b border-[var(--border-subtle)] px-6 py-3">
        <span className="text-sm text-[var(--text-muted)]">
          {cards.length > 0 && !done ? `${index + 1} / ${cards.length}` : "复习"}
        </span>
        <button
          aria-label="退出复习"
          onClick={onClose}
          className="ca-icon-btn ca-touch-44"
        >
          <X className="h-5 w-5" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="w-full max-w-xl">
          {isLoading ? (
            <p className="text-center text-sm text-[var(--text-faint)]">加载中…</p>
          ) : done ? (
            <div className="text-center">
              <div className="text-lg font-semibold text-[var(--text-strong)]">
                {cards.length === 0 ? "今天没有待复习的卡片" : "复习完成 🎉"}
              </div>
              <button
                onClick={onClose}
                className="ca-touch-44 mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white"
              >
                完成
              </button>
            </div>
          ) : card ? (
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6">
              <div className="whitespace-pre-wrap text-center text-lg text-[var(--text-strong)]">
                {card.front}
              </div>

              {revealed ? (
                <>
                  <div className="mt-4 border-t border-[var(--border-subtle)] pt-4 text-center">
                    <div className="whitespace-pre-wrap text-[var(--text-normal)]">
                      {card.back}
                    </div>
                    {card.source_ms != null && card.video_id && (
                      <button
                        onClick={() => onJump(card)}
                        className="ca-touch-44 mt-3 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        回看出处
                      </button>
                    )}
                  </div>
                  <div className="mt-5 grid grid-cols-4 gap-2">
                    {GRADES.map((g) => (
                      <button
                        key={g.rating}
                        onClick={() => grade(g.rating)}
                        className="ca-touch-44 rounded-lg border border-[var(--border-subtle)] px-2 py-2 text-sm text-[var(--text-normal)] transition hover:bg-[var(--surface-card-hover)]"
                      >
                        <span className="block font-medium">{g.label}</span>
                        <span className="text-xs text-[var(--text-faint)]">{g.key}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <button
                  onClick={() => setRevealed(true)}
                  className="ca-touch-44 mt-5 w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white"
                >
                  显示答案（空格）
                </button>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
