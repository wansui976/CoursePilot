import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useMutationState } from "@tanstack/react-query";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { Check, Copy, Send, Sparkles, Square, Trash2, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { renderMarkdown } from "@/lib/renderMarkdown";
import { isMobile } from "@/lib/platform";
import { usePlayer } from "@/stores/player";
import { useInlineAsk } from "@/stores/inlineAsk";
import type { AskEvent, ChatMessage, Citation, RagAnswer } from "@/lib/types";

/**
 * 渲染回答：解析 Markdown（标题/列表/加粗）+ KaTeX 公式 + [mm:ss] 可点击跳转。
 * 首/末块外边距归零，贴合气泡内边距。
 * memo：解析（尤其 KaTeX）不便宜，输入框打字等无关重渲染不应让历史里每条回答都重新解析。
 */
const AnswerText = memo(function AnswerText({
  text,
  onSeek,
  trailing,
}: {
  text: string;
  onSeek: (ms: number) => void;
  /** 可选：渲染在最后一个块末尾的内联元素（如流式生成光标）。 */
  trailing?: ReactNode;
}) {
  return (
    <div className="text-sm leading-relaxed text-[var(--text-normal)] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      {renderMarkdown(text, onSeek, trailing)}
    </div>
  );
});

// 流式生成光标：模块级常量，保证引用稳定，不破坏 AnswerText 的 memo。
const STREAM_CARET = (
  <span data-testid="stream-caret" className="ca-stream-caret" aria-hidden="true" />
);

/**
 * 课程级问答答案下方的「来源」列表：每条可点击跳转（同视频就地 seek，别的视频先打开再跳）。
 * 单视频问答没有 citations，返回 null，UI 与旧版一致。
 */
function CitationSources({
  citations,
  currentVideoId,
  onJump,
}: {
  citations?: Citation[];
  currentVideoId: string;
  onJump: (c: Citation) => void;
}) {
  if (!citations || citations.length === 0) return null;
  return (
    <div className="mt-2 border-t border-[var(--border-subtle)] pt-1.5">
      <div className="mb-1 text-[11px] font-medium text-[var(--text-faint)]">来源</div>
      <div className="space-y-0.5">
        {citations.map((c) => (
          <button
            key={`${c.video_id ?? ""}-${c.start_ms}-${c.index}`}
            type="button"
            onClick={() => onJump(c)}
            className="block w-full rounded px-1.5 py-1 text-left text-xs hover:bg-[var(--surface-card-hover)]"
          >
            {c.video_id && c.video_id !== currentVideoId && c.video_title && (
              <span className="mr-1.5 text-[var(--text-faint)]">{c.video_title} ·</span>
            )}
            <span className="mr-1.5 text-primary">{formatMs(c.start_ms)}</span>
            <span className="text-[var(--text-normal)]">{c.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 节流值：高频变化的输入至多每 ms 毫秒向外吐一次。
 * 用于流式回答——token 每秒来几十个，若每个都全文重跑 Markdown+KaTeX 解析是 O(n²)，
 * 长答案会明显掉帧；节流后解析次数降一个数量级以上，视觉上仍是流畅打字机。
 */
function useThrottledValue<T>(value: T, ms: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastRef = useRef(0);
  useEffect(() => {
    const wait = lastRef.current + ms - Date.now();
    if (wait <= 0) {
      lastRef.current = Date.now();
      setThrottled(value);
      return;
    }
    const timer = window.setTimeout(() => {
      lastRef.current = Date.now();
      setThrottled(value);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return throttled;
}

type RagMode = "ask" | "search";
type SearchHistoryEntry =
  | { id: string; mode: "ask"; query: string; answer: string }
  | { id: string; mode: "search"; query: string; citations: Citation[] };
type AskTurn = {
  id: string;
  query: string;
  answer: string;
  /** 推理模型的思考过程；随答案一起保留，答案出来后折叠展示。旧记录没有。 */
  reasoning?: string;
  /** 课程级问答的跨视频来源引用；单视频问答为空/缺省。 */
  citations?: Citation[];
};
type AskScope = "video" | "course";
type AskRequest = {
  query: string;
  history: ChatMessage[];
  requestId: string;
  scope: AskScope;
};

const ASK_SCOPE_KEY = "course-ai-ask-scope";
function readAskScope(): AskScope {
  try {
    return localStorage.getItem(ASK_SCOPE_KEY) === "course" ? "course" : "video";
  } catch {
    return "video";
  }
}
function writeAskScope(scope: AskScope) {
  try {
    localStorage.setItem(ASK_SCOPE_KEY, scope);
  } catch {
    // ignore storage failures.
  }
}

const ASK_HISTORY_LIMIT = 6;

function historyKey(videoId: string, mode: RagMode) {
  return `course-ai-rag-history:${videoId}:${mode}`;
}

function readSearchHistory(videoId: string, mode: RagMode): SearchHistoryEntry[] {
  try {
    const raw = localStorage.getItem(historyKey(videoId, mode));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    // 存量数据损坏时可能不是数组，非数组直接当空，避免下游 .map 崩溃。
    return Array.isArray(parsed) ? (parsed as SearchHistoryEntry[]) : [];
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

const ASK_SCOPES: { key: AskScope; label: string }[] = [
  { key: "video", label: "本视频" },
  { key: "course", label: "本课程" },
];

function AskChatPanel({ videoId }: { videoId: string }) {
  const requestSeek = usePlayer((s) => s.requestSeek);
  const requestOpenAt = usePlayer((s) => s.requestOpenAt);
  const [scope, setScopeState] = useState<AskScope>(() => readAskScope());
  const [query, setQueryState] = useState(() => readDraft(videoId));
  const [history, setHistory] = useState<AskTurn[]>(() => readAskHistory(videoId));
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // 点击来源引用：本视频（或无来源）就地 seek；本课程其它视频则打开该视频再跳转。
  const jumpTo = (c: Citation) => {
    if (!c.video_id || c.video_id === videoId) requestSeek(c.start_ms);
    else requestOpenAt(c.video_id, c.start_ms);
  };
  const setScope = (next: AskScope) => {
    setScopeState(next);
    writeAskScope(next);
  };
  // 触屏（安卓/iOS）没有 hover：改为长按气泡才显示复制按钮，记住当前显示的那条。
  const touch = isMobile();
  const [revealedCopyId, setRevealedCopyId] = useState<string | null>(null);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 进行中的流式回答（本轮 requestId + 状态提示 + 推理思考 + 已累积文本）。
  const [streaming, setStreaming] = useState<{
    requestId: string;
    status: string;
    reasoning: string;
    text: string;
    citations: Citation[];
  } | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tailRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 就地追问：文稿选区带来的上下文；显示成药丸、提交时注入、消费后清除。
  const pendingAsk = useInlineAsk((s) => s.pending);
  const clearAsk = useInlineAsk((s) => s.clear);
  // 组件卸载后不再 setState（后台请求仍会跑完并落库）。
  // 注意：必须在 effect 体里显式置回 true——React StrictMode(dev) 会「挂载→卸载→
  // 再挂载」，若只有 cleanup 置 false，二次挂载后 ref 永久为 false，所有流式事件
  // 会在入口被静默丢弃（表现为：三个点不动、答案最后一次性蹦出）。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
    // 请求仍会跑完并把回答写入历史，切回来即可见。token 通过 onEvent 实时渲染。
    mutationFn: async ({ query, history, requestId, scope }) => {
      // 思考内容也累积到局部变量：随答案一起落库、保留下来（不受组件卸载影响）。
      let reasoningAcc = "";
      if (mountedRef.current)
        setStreaming({ requestId, status: "", reasoning: "", text: "", citations: [] });
      const answer = await ipc.ai.ragQueryStream(
        videoId,
        scope,
        query,
        history,
        requestId,
        (e: AskEvent) => {
          if (e.type === "reasoning") reasoningAcc += e.delta;
          if (!mountedRef.current) return;
          setStreaming((prev) => {
            if (!prev || prev.requestId !== requestId) return prev;
            if (e.type === "status") return { ...prev, status: e.text };
            if (e.type === "reasoning")
              return { ...prev, reasoning: prev.reasoning + e.delta };
            if (e.type === "token") return { ...prev, text: prev.text + e.delta };
            if (e.type === "citations") return { ...prev, citations: e.citations };
            return prev; // done：最终答案由落库 + 历史渲染接管
          });
        },
      );
      const next = [
        ...readAskHistory(videoId),
        {
          id: crypto.randomUUID(),
          query,
          answer: answer.answer,
          reasoning: reasoningAcc || undefined,
          citations: answer.citations.length > 0 ? answer.citations : undefined,
        },
      ];
      writeAskHistory(videoId, next);
      if (mountedRef.current) setStreaming(null);
      return answer;
    },
    onSuccess: () => setHistory(readAskHistory(videoId)),
    onError: () => {
      if (mountedRef.current) setStreaming(null);
    },
  });

  // 全局 MutationCache 跨组件卸载存活：切回来据此恢复「我的提问 + 思考中」。
  const pendingQueries = useMutationState({
    filters: { mutationKey: ["rag-ask", videoId], status: "pending" },
    select: (m) => m.state.variables as AskRequest | undefined,
  });
  const pendingRequest =
    pendingQueries.length > 0 ? pendingQueries[pendingQueries.length - 1] : undefined;
  const pendingQuery = pendingRequest?.query;
  const busy = pendingQuery !== undefined;
  const cancellableRequestId = streaming?.requestId ?? pendingRequest?.requestId;
  // 进行中（含切走时后台进行的）或失败的那一句也显示在对话里，体验更连贯。
  const inFlightQuery = pendingQuery ?? (ask.isError ? ask.variables?.query : undefined);

  // 请求在卸载期间于后台完成时，切回来同步历史并撤掉 pending 气泡。
  const prevBusy = useRef(busy);
  useEffect(() => {
    if (prevBusy.current && !busy) setHistory(readAskHistory(videoId));
    prevBusy.current = busy;
  }, [busy, videoId]);

  // 流式文本节流后再渲染：每个 token 只累积状态，Markdown+KaTeX 全文解析至多 150ms 一次。
  const throttledStreamText = useThrottledValue(streaming?.text ?? "", 150);

  useEffect(() => {
    const tail = tailRef.current;
    if (!tail || typeof tail.scrollIntoView !== "function") return;
    // 流式期间用 auto（即时）：smooth 会被每次更新反复重启动画，反而卡顿。
    tail.scrollIntoView({
      block: "end",
      behavior: streaming ? "auto" : "smooth",
    });
    // 依赖节流后的流式文本：逐字生成、气泡变高时跟随滚动到底，避免最新内容被输入框挡住。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, busy, ask.isError, throttledStreamText]);

  const submit = (raw?: string) => {
    const trimmed = (raw ?? query).trim();
    if (!trimmed || busy) return;
    // 有选区上下文时，把它作为强前缀拼进本轮问题（带时间戳出处），然后清除药丸。
    const pending = useInlineAsk.getState().pending;
    const finalQuery = pending
      ? `【所选文稿${pending.startMs != null ? ` ${formatMs(pending.startMs)}` : ""}】${pending.text}\n\n${trimmed}`
      : trimmed;
    ask.mutate({
      query: finalQuery,
      history: buildAskContext(history),
      requestId: crypto.randomUUID(),
      scope,
    });
    setQuery("");
    clearAsk();
  };

  // 上下文药丸出现时聚焦输入框：文稿选区 → 跳到提问，用户可直接开始打字。
  useEffect(() => {
    if (pendingAsk) inputRef.current?.focus();
  }, [pendingAsk]);

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
    setRevealedCopyId(null); // 复制后收起（触屏）
    window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
  };

  // 触屏长按气泡才显示复制按钮：按住 ~0.5s 触发；移动/抬手/取消都作废（不打断滚动）。
  const longPressProps = (id: string) =>
    touch
      ? {
          onTouchStart: () => {
            clearTimeout(longPressRef.current);
            longPressRef.current = setTimeout(() => setRevealedCopyId(id), 500);
          },
          onTouchEnd: () => clearTimeout(longPressRef.current),
          onTouchMove: () => clearTimeout(longPressRef.current),
          onTouchCancel: () => clearTimeout(longPressRef.current),
        }
      : {};

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
      <div className="flex-none border-b border-[var(--border-subtle)] px-3 py-2">
        <div
          role="group"
          aria-label="提问范围"
          className="inline-flex items-center gap-0.5 self-start rounded-lg bg-[var(--surface-card)] p-0.5"
        >
          {ASK_SCOPES.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={scope === s.key}
              onClick={() => setScope(s.key)}
              className={`ca-touch-44 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                scope === s.key
                  ? "bg-[var(--surface-panel)] text-[var(--text-strong)] shadow-sm"
                  : "text-[var(--text-muted)] hover:text-[var(--text-normal)]"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
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
                className="group relative min-w-0 max-w-[82%] rounded-2xl rounded-tl-sm border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2"
                {...longPressProps(turn.id)}
              >
                {/* 推理模型的思考过程：随答案保留，默认折叠、可展开。 */}
                {turn.reasoning && (
                  <details className="mb-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card-hover)] px-2.5 py-1.5">
                    <summary className="cursor-pointer select-none text-xs text-[var(--text-faint)]">
                      思考过程
                    </summary>
                    <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-muted)]">
                      {turn.reasoning}
                    </div>
                  </details>
                )}
                <AnswerText text={turn.answer} onSeek={requestSeek} />
                {/* 课程级问答的跨视频出处，可点击跳转。 */}
                <CitationSources
                  citations={turn.citations}
                  currentVideoId={videoId}
                  onJump={jumpTo}
                />
                {/* 复制：仅图标、小尺寸。桌面 hover 气泡显示；触屏长按显示。 */}
                <button
                  type="button"
                  onClick={() => copyAnswer(turn.id, turn.answer)}
                  aria-label="复制回答"
                  title="复制"
                  className={`absolute bottom-1 right-1 grid h-6 w-6 flex-none place-items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-muted)] shadow-sm transition hover:text-[var(--text-strong)] ${
                    touch
                      ? revealedCopyId === turn.id
                        ? "opacity-100"
                        : "pointer-events-none opacity-0"
                      : "pointer-events-none opacity-0 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
                  }`}
                >
                  {copiedId === turn.id ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
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
                <div className="min-w-0 max-w-[82%] space-y-1.5">
                  {/* 推理模型的「思考过程」：流式实时展示、可折叠、灰色小字。 */}
                  {streaming?.reasoning && (
                    <details
                      open
                      className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card-hover)] px-2.5 py-1.5"
                    >
                      <summary className="cursor-pointer select-none text-xs text-[var(--text-faint)]">
                        思考过程
                      </summary>
                      <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-muted)]">
                        {streaming.reasoning}
                      </div>
                    </details>
                  )}
                  {streaming?.text ? (
                    <div
                      role="article"
                      aria-label="AI 回复"
                      className="rounded-2xl rounded-tl-sm border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2"
                    >
                      <AnswerText
                        // 渲染节流值（150ms 一次全文解析）；节流值还没跟上时先用当前值兜底。
                        text={throttledStreamText || streaming.text}
                        onSeek={requestSeek}
                        trailing={STREAM_CARET}
                      />
                      <CitationSources
                        citations={streaming?.citations}
                        currentVideoId={videoId}
                        onJump={jumpTo}
                      />
                    </div>
                  ) : streaming?.status ? (
                    <div className="rounded-2xl rounded-tl-sm border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-3">
                      <span className="text-xs text-[var(--text-muted)]">
                        {streaming.status}
                      </span>
                    </div>
                  ) : streaming?.reasoning ? null : (
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
                  )}
                </div>
              </div>
            )}
            {ask.isError && (
              <div className="flex items-start gap-2">
                {aiAvatar}
                <ErrorNote
                  className="min-w-0 flex-1"
                  error={ask.error}
                  onRetry={() =>
                    ask.variables &&
                    ask.mutate({
                      ...ask.variables,
                      requestId: crypto.randomUUID(),
                    })
                  }
                />
              </div>
            )}
          </div>
        )}
        <div ref={tailRef} />
      </div>

      <div className="flex-none border-t border-[var(--border-subtle)] p-2.5">
        {pendingAsk && (
          <div className="mb-1.5 flex items-start gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-2 py-1 text-xs text-[var(--text-muted)]">
            <span className="min-w-0 flex-1 truncate">
              基于所选
              {pendingAsk.startMs != null ? ` ${formatMs(pendingAsk.startMs)}` : ""}：
              {pendingAsk.text}
            </span>
            <button
              type="button"
              aria-label="移除所选上下文"
              onClick={clearAsk}
              className="ca-touch-44 flex-none text-[var(--text-faint)] transition hover:text-[var(--text-strong)]"
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex items-center gap-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 transition focus-within:border-[var(--accent-text)]">
          {history.length > 0 && (
            <button
              type="button"
              onClick={() => void onClearClick()}
              aria-label="清空对话"
              title="清空对话"
              className="ca-touch-44 inline-flex flex-none items-center justify-center rounded-full text-xs text-[var(--text-muted)] transition hover:text-[var(--status-err)]"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <input
            ref={inputRef}
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
          {cancellableRequestId ? (
            <button
              type="button"
              onClick={() => void ipc.ai.cancelRagQuery(cancellableRequestId)}
              aria-label="停止生成"
              title="停止生成"
              className="ca-touch-44 grid h-8 w-8 flex-none place-items-center rounded-full bg-[var(--surface-card-active)] text-[var(--text-strong)] transition hover:bg-[var(--surface-card-hover)]"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => submit()}
              disabled={busy || !query.trim()}
              aria-label="发送"
              title="发送（Enter）"
              className="ca-touch-44 grid h-8 w-8 flex-none place-items-center rounded-full bg-primary text-white transition hover:opacity-90 disabled:bg-[var(--surface-card-active)] disabled:text-[var(--text-muted)] disabled:hover:opacity-100"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

type SearchScope = "video" | "course";
const SCOPE_LABELS: { key: SearchScope; label: string }[] = [
  { key: "video", label: "本视频" },
  { key: "course", label: "本课程" },
];

function SearchTranscriptPanel({ videoId }: { videoId: string }) {
  const requestSeek = usePlayer((s) => s.requestSeek);
  const requestOpenAt = usePlayer((s) => s.requestOpenAt);
  const [scope, setScope] = useState<SearchScope>("video");
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<SearchHistoryEntry[]>(() =>
    readSearchHistory(videoId, "search"),
  );

  useEffect(() => {
    setHistory(readSearchHistory(videoId, "search"));
  }, [videoId]);

  // 点击引用：本视频（或无来源）就地 seek；本课程其它视频则打开该视频再跳转。
  const jumpTo = (c: Citation) => {
    if (!c.video_id || c.video_id === videoId) requestSeek(c.start_ms);
    else requestOpenAt(c.video_id, c.start_ms);
  };

  const search = useMutation<Citation[], unknown, string>({
    mutationFn: (q: string) => ipc.ai.searchTranscript(videoId, scope, q),
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
      <div className="flex flex-none flex-col gap-2 border-b border-[var(--border-subtle)] p-3">
        <div
          role="group"
          aria-label="搜索范围"
          className="inline-flex items-center gap-0.5 self-start rounded-lg bg-[var(--surface-card)] p-0.5"
        >
          {SCOPE_LABELS.map((s) => (
            <button
              key={s.key}
              aria-pressed={scope === s.key}
              onClick={() => setScope(s.key)}
              className={`ca-touch-44 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                scope === s.key
                  ? "bg-[var(--surface-panel)] text-[var(--text-strong)] shadow-sm"
                  : "text-[var(--text-muted)] hover:text-[var(--text-normal)]"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            aria-label="搜索文稿内容"
            className="min-w-0 flex-1 rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-strong)] placeholder:text-[var(--text-faint)]"
            placeholder={scope === "course" ? "在本课程所有视频里搜…" : "输入关键词…"}
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
      </div>

      {search.isError && (
        <ErrorNote
          className="mx-3 mb-2"
          error={search.error}
          onRetry={() => search.variables && search.mutate(search.variables)}
        />
      )}
      <div
        aria-label="搜索结果"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
      >
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
                    key={`${entry.id}-${c.video_id ?? ""}-${c.start_ms}-${c.index}`}
                    onClick={() => jumpTo(c)}
                    className="block w-full rounded px-1.5 py-1 text-left text-xs hover:bg-[var(--surface-card-hover)]"
                  >
                    {/* 跨视频结果标注来源视频（本视频结果不标）。 */}
                    {c.video_id && c.video_id !== videoId && c.video_title && (
                      <span className="mr-1.5 text-[var(--text-faint)]">
                        {c.video_title} ·
                      </span>
                    )}
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
