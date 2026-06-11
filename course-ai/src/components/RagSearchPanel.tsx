import { useEffect, useRef, useState } from "react";
import { useMutation, useMutationState } from "@tanstack/react-query";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { Check, Copy, Loader2, Send, Sparkles, Trash2, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { withClickableTimestamps } from "@/lib/clickableTimestamps";
import { usePlayer } from "@/stores/player";
import type { ChatMessage, Citation, RagAnswer } from "@/lib/types";

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
type SearchHistoryEntry =
  | { id: string; mode: "ask"; query: string; answer: string }
  | { id: string; mode: "search"; query: string; citations: Citation[] };
type AskTurn = { id: string; query: string; answer: string };
type AskRequest = { query: string; history: ChatMessage[] };

const ASK_HISTORY_LIMIT = 6;

function historyKey(videoId: string, mode: RagMode) {
  return `course-ai-rag-history:${videoId}:${mode}`;
}

function readSearchHistory(videoId: string, mode: RagMode): SearchHistoryEntry[] {
  try {
    const raw = localStorage.getItem(historyKey(videoId, mode));
    return raw ? (JSON.parse(raw) as SearchHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function writeSearchHistory(videoId: string, mode: RagMode, history: SearchHistoryEntry[]) {
  try {
    localStorage.setItem(historyKey(videoId, mode), JSON.stringify(history.slice(0, 20)));
  } catch {
    // ignore storage failures; the current response still renders.
  }
}

function readAskHistory(videoId: string): AskTurn[] {
  try {
    const raw = localStorage.getItem(historyKey(videoId, "ask"));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    if (parsed.length === 0) return [];

    const first = parsed[0] as Record<string, unknown>;
    if (first && first.mode === "ask") {
      return [...parsed]
        .reverse()
        .filter((entry): entry is { id: string; query: string; answer: string } => {
          const row = entry as Record<string, unknown>;
          return (
            typeof row.id === "string" &&
            typeof row.query === "string" &&
            typeof row.answer === "string"
          );
        })
        .map((entry) => ({
          id: entry.id,
          query: entry.query,
          answer: entry.answer,
        }));
    }

    return parsed.filter((entry): entry is AskTurn => {
      const row = entry as Record<string, unknown>;
      return (
        typeof row.id === "string" &&
        typeof row.query === "string" &&
        typeof row.answer === "string"
      );
    });
  } catch {
    return [];
  }
}

function writeAskHistory(videoId: string, history: AskTurn[]) {
  try {
    localStorage.setItem(historyKey(videoId, "ask"), JSON.stringify(history.slice(-20)));
  } catch {
    // ignore storage failures; the current response still renders.
  }
}

function draftKey(videoId: string) {
  return `course-ai-rag-draft:${videoId}:ask`;
}

function readDraft(videoId: string): string {
  try {
    return localStorage.getItem(draftKey(videoId)) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(videoId: string, value: string) {
  try {
    if (value) localStorage.setItem(draftKey(videoId), value);
    else localStorage.removeItem(draftKey(videoId));
  } catch {
    // ignore storage failures.
  }
}

function buildAskContext(history: AskTurn[]): ChatMessage[] {
  return history.slice(-ASK_HISTORY_LIMIT).flatMap((turn) => [
    { role: "user", content: turn.query },
    { role: "assistant", content: turn.answer },
  ]);
}

const ASK_SUGGESTIONS = [
  "这节课主要讲了什么？",
  "帮我总结重点",
  "有哪些关键概念和结论？",
];

function AskChatPanel({ videoId }: { videoId: string }) {
  const requestSeek = usePlayer((s) => s.requestSeek);
  const [query, setQueryState] = useState(() => readDraft(videoId));
  const [history, setHistory] = useState<AskTurn[]>(() => readAskHistory(videoId));
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tailRef = useRef<HTMLDivElement>(null);

  // 草稿同步落 localStorage，切走再回来不丢已输入内容。
  const setQuery = (value: string) => {
    setQueryState(value);
    writeDraft(videoId, value);
  };

  useEffect(() => {
    setQueryState(readDraft(videoId));
    setHistory(readAskHistory(videoId));
  }, [videoId]);

  const ask = useMutation<RagAnswer, unknown, AskRequest>({
    mutationKey: ["rag-ask", videoId],
    // 直接在 mutationFn 内落库：即使提问途中切到别的页面、组件已卸载，
    // 请求仍会跑完并把回答写入历史，切回来即可见。
    mutationFn: async ({ query, history }) => {
      const answer = await ipc.ai.ragQuery(videoId, query, history);
      const next = [
        ...readAskHistory(videoId),
        { id: crypto.randomUUID(), query, answer: answer.answer },
      ];
      writeAskHistory(videoId, next);
      return answer;
    },
    onSuccess: () => setHistory(readAskHistory(videoId)),
  });

  // 全局 MutationCache 跨组件卸载存活：切回来据此恢复「我的提问 + 思考中」。
  const pendingQueries = useMutationState({
    filters: { mutationKey: ["rag-ask", videoId], status: "pending" },
    select: (m) => (m.state.variables as AskRequest | undefined)?.query ?? "",
  });
  const pendingQuery =
    pendingQueries.length > 0 ? pendingQueries[pendingQueries.length - 1] : undefined;
  const busy = pendingQuery !== undefined;
  // 进行中（含切走时后台进行的）或失败的那一句也显示在对话里，体验更连贯。
  const inFlightQuery = pendingQuery ?? (ask.isError ? ask.variables?.query : undefined);

  // 请求在卸载期间于后台完成时，切回来同步历史并撤掉 pending 气泡。
  const prevBusy = useRef(busy);
  useEffect(() => {
    if (prevBusy.current && !busy) setHistory(readAskHistory(videoId));
    prevBusy.current = busy;
  }, [busy, videoId]);

  useEffect(() => {
    const tail = tailRef.current;
    if (!tail || typeof tail.scrollIntoView !== "function") return;
    tail.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [history, busy, ask.isError]);

  const submit = (raw?: string) => {
    const trimmed = (raw ?? query).trim();
    if (!trimmed || busy) return;
    ask.mutate({ query: trimmed, history: buildAskContext(history) });
    setQuery("");
  };

  const clearChat = () => {
    setHistory([]);
    writeAskHistory(videoId, []);
    ask.reset();
  };
  const onClearClick = async () => {
    const ok = await confirmDialog("清空与这节课的全部问答？此操作不可撤销。", {
      title: "清空对话",
      kind: "warning",
      okLabel: "清空",
      cancelLabel: "取消",
    });
    if (ok) clearChat();
  };

  const copyAnswer = (id: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
  };

  const aiAvatar = (
    <span className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-primary/15 text-primary">
      <Sparkles className="h-4 w-4" />
    </span>
  );
  const userAvatar = (
    <span className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-[var(--surface-card-active)] text-[var(--text-muted)]">
      <User className="h-4 w-4" />
    </span>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollerRef}
        aria-label="聊天记录"
        className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3"
      >
        {history.length === 0 && inFlightQuery === undefined && (
          <div className="flex flex-col items-center gap-3 px-2 pt-6 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/12 text-primary">
              <Sparkles className="h-6 w-6" />
            </span>
            <div>
              <div className="text-sm font-medium text-[var(--text-strong)]">向这节课提问</div>
              <p className="mx-auto mt-1 max-w-[260px] text-xs leading-relaxed text-[var(--text-faint)]">
                AI 会基于字幕回答，并标注 [mm:ss] 出处，可继续追问。
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {ASK_SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => submit(s)}
                  className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-1.5 text-xs text-[var(--text-normal)] transition hover:border-[var(--accent-text)] hover:bg-[var(--surface-card-hover)]"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {history.map((turn) => (
          <div key={turn.id} className="space-y-3">
            <div className="flex flex-row-reverse items-start gap-2">
              {userAvatar}
              <div
                role="article"
                aria-label="我的提问"
                className="max-w-[82%] rounded-2xl rounded-tr-sm bg-primary/15 px-3 py-2"
              >
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--text-strong)]">
                  {turn.query}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              {aiAvatar}
              <div
                role="article"
                aria-label="AI 回复"
                className="min-w-0 max-w-[82%] rounded-2xl rounded-tl-sm border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2"
              >
                <AnswerText text={turn.answer} onSeek={requestSeek} />
                <div className="mt-1.5 flex justify-end">
                  <button
                    type="button"
                    onClick={() => copyAnswer(turn.id, turn.answer)}
                    aria-label="复制回答"
                    className="inline-flex flex-none items-center gap-1 rounded px-1 text-[10px] text-[var(--text-muted)] transition hover:text-[var(--text-strong)]"
                  >
                    {copiedId === turn.id ? (
                      <>
                        <Check className="h-3 w-3" />
                        已复制
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        复制
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}

        {inFlightQuery !== undefined && (
          <div className="space-y-3">
            <div className="flex flex-row-reverse items-start gap-2">
              {userAvatar}
              <div
                role="article"
                aria-label="我的提问"
                className="max-w-[82%] rounded-2xl rounded-tr-sm bg-primary/15 px-3 py-2"
              >
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--text-strong)]">
                  {inFlightQuery}
                </p>
              </div>
            </div>
            {busy && (
              <div className="flex items-start gap-2">
                {aiAvatar}
                <div className="rounded-2xl rounded-tl-sm border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-3">
                  <span
                    className="ca-typing inline-flex items-center gap-1 text-[var(--text-muted)]"
                    aria-label="思考中"
                  >
                    <i className="ca-typing-dot" />
                    <i className="ca-typing-dot" style={{ animationDelay: "0.15s" }} />
                    <i className="ca-typing-dot" style={{ animationDelay: "0.3s" }} />
                  </span>
                </div>
              </div>
            )}
            {ask.isError && (
              <div className="flex items-start gap-2">
                {aiAvatar}
                <ErrorNote
                  className="min-w-0 flex-1"
                  error={ask.error}
                  onRetry={() => ask.variables && ask.mutate(ask.variables)}
                />
              </div>
            )}
          </div>
        )}
        <div ref={tailRef} />
      </div>

      <div className="flex-none border-t border-[var(--border-subtle)] p-2.5">
        <div className="flex items-center gap-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 transition focus-within:border-[var(--accent-text)]">
          {history.length > 0 && (
            <button
              type="button"
              onClick={() => void onClearClick()}
              aria-label="清空对话"
              title="清空对话"
              className="inline-flex flex-none items-center rounded-full text-xs text-[var(--text-muted)] transition hover:text-[var(--status-err)]"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <input
            aria-label="聊天内容"
            type="text"
            placeholder="继续追问…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            className="ca-ask-input min-w-0 flex-1 bg-transparent text-sm leading-relaxed text-[var(--text-strong)] outline-none placeholder:text-[var(--text-faint)]"
          />
          <button
            type="button"
            onClick={() => submit()}
            disabled={busy || !query.trim()}
            aria-label="发送"
            title="发送（Enter）"
            className="grid h-8 w-8 flex-none place-items-center rounded-full bg-primary text-white transition hover:opacity-90 disabled:bg-[var(--surface-card-active)] disabled:text-[var(--text-muted)] disabled:hover:opacity-100"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function SearchTranscriptPanel({ videoId }: { videoId: string }) {
  const requestSeek = usePlayer((s) => s.requestSeek);
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<SearchHistoryEntry[]>(() =>
    readSearchHistory(videoId, "search"),
  );

  useEffect(() => {
    setHistory(readSearchHistory(videoId, "search"));
  }, [videoId]);

  const search = useMutation<Citation[], unknown, string>({
    mutationFn: (q: string) => ipc.ai.searchTranscript(videoId, q),
    onSuccess: (citations, q) => {
      setHistory((prev) => {
        const next: SearchHistoryEntry[] = [
          { id: crypto.randomUUID(), mode: "search", query: q, citations },
          ...prev,
        ];
        writeSearchHistory(videoId, "search", next);
        return next;
      });
      setQuery("");
    },
  });

  const busy = search.isPending;
  const submit = () => {
    const q = query.trim();
    if (!q || busy) return;
    search.mutate(q);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-none items-center gap-2 border-b border-[var(--border-subtle)] p-3">
        <input
          aria-label="搜索文稿内容"
          className="min-w-0 flex-1 rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-strong)] placeholder:text-[var(--text-faint)]"
          placeholder="输入关键词…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <Button size="sm" variant="default" disabled={busy || !query.trim()} onClick={submit}>
          {busy ? "搜索中…" : "搜索"}
        </Button>
      </div>

      {search.isError && <ErrorNote className="mx-3 mb-2" error={search.error} />}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {history.length === 0 && (
          <p className="text-sm text-[var(--text-faint)]">还没有搜索历史。</p>
        )}
        {history.map((entry) => (
          <div
            key={entry.id}
            className="rounded border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3"
          >
            <div className="mb-2 text-xs font-medium text-primary">{entry.query}</div>
            {entry.mode !== "search" || entry.citations.length === 0 ? (
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

export function RagSearchPanel({
  videoId,
  mode = "ask",
}: {
  videoId: string;
  mode?: RagMode;
}) {
  return mode === "ask" ? <AskChatPanel videoId={videoId} /> : <SearchTranscriptPanel videoId={videoId} />;
}
