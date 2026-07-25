import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Send, Sparkles, Square, Trash2, User } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { renderMarkdown } from "@/lib/renderMarkdown";
import { formatMs } from "@/lib/time";
import { displayTitle } from "@/lib/videoTitle";
import type { AskEvent, ChatMessage, Citation } from "@/lib/types";

// 答案里的 [mm:ss] 不跳转：课程问答横跨多个视频，没有「当前视频」可 seek，
// 该跳哪儿由下方「来源」列表说清楚（每条自带视频）。
const NO_SEEK = () => {};

/**
 * 答案下方的「来源」：后端挑出的相关知识点带来了哪些讲课片段，点一条就跳到那节课那一刻。
 * 没有来源（问题不针对具体知识点、或旧记录）时不渲染。
 */
function ChatSources({
  citations,
  onJump,
}: {
  citations?: Citation[];
  onJump?: (videoId: string, startMs: number) => void;
}) {
  if (!citations || citations.length === 0) return null;
  return (
    <div className="mt-2 border-t border-[var(--border-subtle)] pt-1.5">
      <div className="mb-1 text-[11px] font-medium text-[var(--text-faint)]">来源</div>
      <div className="space-y-0.5">
        {citations.map((c) => {
          const label = (
            <>
              {c.video_title && (
                <span className="mr-1.5 text-[var(--text-faint)]">
                  {displayTitle(c.video_title)} ·
                </span>
              )}
              <span className="mr-1.5 text-primary">{formatMs(c.start_ms)}</span>
              <span className="text-[var(--text-normal)]">{c.text}</span>
            </>
          );
          const key = `${c.video_id ?? ""}-${c.start_ms}-${c.index}`;
          // 拿不到跳转能力或来源没带视频时降级成纯文本，免得点了没反应。
          if (!onJump || !c.video_id) {
            return (
              <p key={key} className="px-1.5 py-1 text-xs">
                {label}
              </p>
            );
          }
          const videoId = c.video_id;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onJump(videoId, c.start_ms)}
              aria-label={`回看 ${displayTitle(c.video_title ?? "")} ${formatMs(c.start_ms)}`}
              className="block w-full rounded px-1.5 py-1 text-left text-xs hover:bg-[var(--surface-card-hover)]"
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 渲染回答：Markdown（标题/列表/加粗）+ KaTeX。memo 避免打字等无关重渲染反复重解析。 */
const AnswerText = memo(function AnswerText({
  text,
  trailing,
}: {
  text: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="text-sm leading-relaxed text-[var(--text-normal)] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      {renderMarkdown(text, NO_SEEK, trailing)}
    </div>
  );
});

// 流式生成光标：模块级常量，引用稳定，不破坏 AnswerText 的 memo。
const STREAM_CARET = (
  <span data-testid="stream-caret" className="ca-stream-caret" aria-hidden="true" />
);

/** 节流：高频变化的流式文本至多每 ms 毫秒向外吐一次，避免每个 token 都全文重解析 Markdown+KaTeX。 */
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

type ChatTurn = {
  id: string;
  query: string;
  answer: string;
  /** 推理模型的思考过程；随答案一起保留，答案出来后折叠展示。旧记录没有。 */
  reasoning?: string;
  /** 本轮答案依据的讲课片段（后端按问题相关性挑的知识点来源）。旧记录没有。 */
  citations?: Citation[];
};
type ChatRequest = { query: string; history: ChatMessage[]; requestId: string };

// 最近多少轮问答作为上下文回传给后端（控制 token）。
const CHAT_HISTORY_LIMIT = 6;

function historyKey(courseId: string) {
  return `course-ai-course-chat:${courseId}`;
}

function readHistory(courseId: string): ChatTurn[] {
  try {
    const raw = localStorage.getItem(historyKey(courseId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is ChatTurn => {
        const row = entry as Record<string, unknown>;
        return (
          typeof row.id === "string" &&
          typeof row.query === "string" &&
          typeof row.answer === "string"
        );
      })
      // 来源是后来才加的字段：形状不对就当没有，不让坏记录拖垮整段历史。
      .map((turn) => (Array.isArray(turn.citations) ? turn : { ...turn, citations: undefined }));
  } catch {
    return [];
  }
}

function writeHistory(courseId: string, history: ChatTurn[]) {
  try {
    localStorage.setItem(historyKey(courseId), JSON.stringify(history.slice(-20)));
  } catch {
    // 忽略存储失败；当前回答仍会正常渲染。
  }
}

function buildContext(history: ChatTurn[]): ChatMessage[] {
  return history.slice(-CHAT_HISTORY_LIMIT).flatMap((turn) => [
    { role: "user", content: turn.query },
    { role: "assistant", content: turn.answer },
  ]);
}

const SUGGESTIONS = [
  "这门课主要讲了什么？",
  "帮我梳理知识点之间的关系",
  "给我出几个复习问题",
];

/** 以整门课程的总览+知识点为背景的问答面板：流式回答、可停止、按课程留存历史。 */
export function CourseChatPanel({
  courseId,
  onJump,
}: {
  courseId: string;
  /** 点「来源」跳到该视频该时刻；没传时来源只作为文字展示。 */
  onJump?: (videoId: string, startMs: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<ChatTurn[]>(() => readHistory(courseId));
  // 进行中的流式回答（本轮 requestId + 推理思考 + 已累积文本 + 已到达的来源）。
  const [streaming, setStreaming] = useState<{
    requestId: string;
    reasoning: string;
    text: string;
    citations: Citation[];
  } | null>(null);
  const tailRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 组件卸载后不再 setState（后台请求仍会跑完并落库）。StrictMode 二次挂载需显式置回 true。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setHistory(readHistory(courseId));
    setQuery("");
  }, [courseId]);

  const ask = useMutation<string, unknown, ChatRequest>({
    mutationFn: async ({ query, history, requestId }) => {
      // 思考内容与来源也累积到局部变量：随答案一起落库、保留（不受组件卸载影响）。
      let reasoningAcc = "";
      let citationsAcc: Citation[] = [];
      if (mountedRef.current) setStreaming({ requestId, reasoning: "", text: "", citations: [] });
      const answer = await ipc.concepts.chat(courseId, query, history, requestId, (e: AskEvent) => {
        if (e.type === "reasoning") reasoningAcc += e.delta;
        if (e.type === "citations") citationsAcc = e.citations;
        if (!mountedRef.current) return;
        setStreaming((prev) => {
          if (!prev || prev.requestId !== requestId) return prev;
          if (e.type === "reasoning") return { ...prev, reasoning: prev.reasoning + e.delta };
          if (e.type === "token") return { ...prev, text: prev.text + e.delta };
          if (e.type === "citations") return { ...prev, citations: e.citations };
          return prev; // done：最终答案由落库 + 历史渲染接管
        });
      });
      const next = [
        ...readHistory(courseId),
        {
          id: crypto.randomUUID(),
          query,
          answer,
          reasoning: reasoningAcc || undefined,
          citations: citationsAcc.length > 0 ? citationsAcc : undefined,
        },
      ];
      writeHistory(courseId, next);
      if (mountedRef.current) setStreaming(null);
      return answer;
    },
    onSuccess: () => setHistory(readHistory(courseId)),
    onError: () => {
      if (mountedRef.current) setStreaming(null);
    },
  });

  const busy = ask.isPending;
  const cancellableRequestId = streaming?.requestId ?? (busy ? ask.variables?.requestId : undefined);
  // 进行中或失败的那一句也显示在对话里，体验更连贯。
  const inFlightQuery = busy || ask.isError ? ask.variables?.query : undefined;

  // 流式文本节流后再渲染：每个 token 只累积状态，全文解析至多 120ms 一次。
  const throttledStreamText = useThrottledValue(streaming?.text ?? "", 120);

  useEffect(() => {
    const tail = tailRef.current;
    if (!tail || typeof tail.scrollIntoView !== "function") return;
    // 流式期间用 auto（即时）：smooth 会被每次更新反复重启动画反而卡顿。
    tail.scrollIntoView({ block: "end", behavior: streaming ? "auto" : "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, busy, ask.isError, throttledStreamText]);

  const submit = (raw?: string) => {
    const trimmed = (raw ?? query).trim();
    if (!trimmed || busy) return;
    ask.mutate({
      query: trimmed,
      history: buildContext(history),
      requestId: crypto.randomUUID(),
    });
    setQuery("");
  };

  const clearChat = () => {
    setHistory([]);
    writeHistory(courseId, []);
    ask.reset();
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
        aria-label="课程问答记录"
        className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3"
      >
        {history.length === 0 && inFlightQuery === undefined && (
          <div className="flex flex-col items-center gap-3 px-2 pt-6 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/12 text-primary">
              <Sparkles className="h-6 w-6" />
            </span>
            <div>
              <div className="text-sm font-medium text-[var(--text-strong)]">向这门课程提问</div>
              <p className="mx-auto mt-1 max-w-[260px] text-xs leading-relaxed text-[var(--text-faint)]">
                AI 会基于这门课程的总览和知识点回答，可继续追问。
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
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
                <AnswerText text={turn.answer} />
                <ChatSources citations={turn.citations} onJump={onJump} />
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
                        text={throttledStreamText || streaming.text}
                        trailing={STREAM_CARET}
                      />
                      <ChatSources citations={streaming.citations} onJump={onJump} />
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
                    ask.mutate({ ...ask.variables, requestId: crypto.randomUUID() })
                  }
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
              onClick={clearChat}
              aria-label="清空对话"
              title="清空对话"
              className="ca-touch-44 inline-flex flex-none items-center justify-center rounded-full text-xs text-[var(--text-muted)] transition hover:text-[var(--status-err)]"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <input
            ref={inputRef}
            aria-label="课程问答输入"
            type="text"
            placeholder="问一问本课程…"
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
              onClick={() => void ipc.concepts.cancelChat(cancellableRequestId)}
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
