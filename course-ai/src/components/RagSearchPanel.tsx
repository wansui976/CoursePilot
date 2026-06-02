import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { withClickableTimestamps } from "@/lib/clickableTimestamps";
import { usePlayer } from "@/stores/player";
import type { Citation, RagAnswer } from "@/lib/types";

/** 把回答里的 [mm:ss] 时间戳渲染成可点击跳转的标记，其余按纯文本保留换行。 */
function AnswerText({
  text,
  onSeek,
}: {
  text: string;
  onSeek: (ms: number) => void;
}) {
  return (
    <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--text-normal)]">
      {withClickableTimestamps(text, onSeek)}
    </p>
  );
}

type RagMode = "ask" | "search";
type HistoryEntry =
  | { id: string; mode: "ask"; query: string; answer: string }
  | { id: string; mode: "search"; query: string; citations: Citation[] };

function historyKey(videoId: string, mode: RagMode) {
  return `course-ai-rag-history:${videoId}:${mode}`;
}

function readHistory(videoId: string, mode: RagMode): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(historyKey(videoId, mode));
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function writeHistory(videoId: string, mode: RagMode, history: HistoryEntry[]) {
  try {
    localStorage.setItem(historyKey(videoId, mode), JSON.stringify(history.slice(0, 20)));
  } catch {
    // ignore storage failures; the current response still renders.
  }
}

export function RagSearchPanel({
  videoId,
  mode = "ask",
}: {
  videoId: string;
  mode?: RagMode;
}) {
  const requestSeek = usePlayer((s) => s.requestSeek);
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>(() =>
    readHistory(videoId, mode),
  );

  useEffect(() => {
    setHistory(readHistory(videoId, mode));
  }, [mode, videoId]);

  const ask = useMutation<RagAnswer, unknown, string>({
    mutationFn: (q: string) => ipc.ai.ragQuery(videoId, q),
    onSuccess: (answer, q) => {
      const next: HistoryEntry[] = [
        { id: crypto.randomUUID(), mode: "ask", query: q, answer: answer.answer },
        ...history,
      ];
      setHistory(next);
      writeHistory(videoId, "ask", next);
      setQuery("");
    },
  });
  const search = useMutation<Citation[], unknown, string>({
    mutationFn: (q: string) => ipc.ai.searchTranscript(videoId, q),
    onSuccess: (citations, q) => {
      const next: HistoryEntry[] = [
        { id: crypto.randomUUID(), mode: "search", query: q, citations },
        ...history,
      ];
      setHistory(next);
      writeHistory(videoId, "search", next);
      setQuery("");
    },
  });

  const busy = ask.isPending || search.isPending;
  const submit = () => {
    const q = query.trim();
    if (!q || busy) return;
    if (mode === "ask") {
      ask.mutate(q);
    } else {
      search.mutate(q);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-none items-center gap-2 border-b border-[var(--border-subtle)] p-3">
        <input
          aria-label={mode === "ask" ? "提问内容" : "搜索文稿内容"}
          className="min-w-0 flex-1 rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-strong)] placeholder:text-[var(--text-faint)]"
          placeholder={mode === "ask" ? "输入问题…" : "输入关键词…"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <Button
          size="sm"
          variant="default"
          disabled={busy || !query.trim()}
          onClick={submit}
        >
          {busy ? (mode === "ask" ? "思考中…" : "搜索中…") : mode === "ask" ? "提问" : "搜索"}
        </Button>
      </div>

      {(ask.isError || search.isError) && (
        <p className="border-b border-[var(--border-subtle)] px-3 py-2 text-xs text-red-500">
          {String(ask.error || search.error)}
        </p>
      )}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {history.length === 0 && (
          <p className="text-sm text-[var(--text-faint)]">
            {mode === "ask" ? "还没有提问历史。" : "还没有搜索历史。"}
          </p>
        )}
        {history.map((entry) => (
          <div
            key={entry.id}
            className="rounded border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3"
          >
            <div className="mb-2 text-xs font-medium text-primary">
              {entry.query}
            </div>
            {entry.mode === "ask" ? (
              <AnswerText text={entry.answer} onSeek={requestSeek} />
            ) : entry.citations.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">没有匹配的字幕。</p>
            ) : (
              <div className="space-y-1">
                {entry.citations.map((c) => (
                  <button
                    key={`${entry.id}-${c.start_ms}-${c.index}`}
                    onClick={() => requestSeek(c.start_ms)}
                    className="block w-full rounded px-1.5 py-1 text-left text-xs hover:bg-[var(--surface-card-hover)]"
                  >
                    <span className="mr-1.5 text-primary">{formatMs(c.start_ms)}</span>
                    <span className="text-[var(--text-normal)]">{c.text}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
