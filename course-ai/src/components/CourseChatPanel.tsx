import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
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
  const { t } = useTranslation();
  if (!citations || citations.length === 0) return null;
  return (
    <div className="mt-2 border-t border-[var(--border-subtle)] pt-1.5">
      <div className="mb-1 text-[11px] font-medium text-[var(--text-faint)]">{t("courseChat.sources")}</div>
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
              aria-label={t("concepts.reviewSource", { title: displayTitle(c.video_title ?? ""), time: formatMs(c.start_ms) })}
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
type ChatStream = {
  requestId: string;
  reasoning: string;
  text: string;
  citations: Citation[];
};

// MutationCache 能跨抽屉卸载保住请求身份和结果，但流式 token 不属于 mutation state。
// 这份按课程隔离的外部快照只活在当前应用进程中，让重挂的抽屉接回同一条流。
const courseStreams = new Map<string, ChatStream>();
const courseStreamListeners = new Map<string, Set<() => void>>();

function readCourseStream(courseId: string): ChatStream | null {
  return courseStreams.get(courseId) ?? null;
}

function notifyCourseStream(courseId: string) {
  courseStreamListeners.get(courseId)?.forEach((listener) => listener());
}

function startCourseStream(courseId: string, requestId: string) {
  courseStreams.set(courseId, { requestId, reasoning: "", text: "", citations: [] });
  notifyCourseStream(courseId);
}

function updateCourseStream(
  courseId: string,
  requestId: string,
  update: (current: ChatStream) => ChatStream,
) {
  const current = courseStreams.get(courseId);
  if (!current || current.requestId !== requestId) return;
  courseStreams.set(courseId, update(current));
  notifyCourseStream(courseId);
}

function finishCourseStream(courseId: string, requestId: string) {
  if (courseStreams.get(courseId)?.requestId !== requestId) return;
  courseStreams.delete(courseId);
  notifyCourseStream(courseId);
}

function subscribeCourseStream(courseId: string, listener: () => void) {
  const listeners = courseStreamListeners.get(courseId) ?? new Set<() => void>();
  listeners.add(listener);
  courseStreamListeners.set(courseId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) courseStreamListeners.delete(courseId);
  };
}

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

const SUGGESTION_KEYS = [
  "courseChat.suggestion1",
  "courseChat.suggestion2",
  "courseChat.suggestion3",
] as const;

/** 以整门课程的总览+知识点为背景的问答面板：流式回答、可停止、按课程留存历史。 */
export function CourseChatPanel({
  courseId,
  onJump,
}: {
  courseId: string;
  /** 点「来源」跳到该视频该时刻；没传时来源只作为文字展示。 */
  onJump?: (videoId: string, startMs: number) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<ChatTurn[]>(() => readHistory(courseId));
  const tailRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const subscribeToStream = useCallback(
    (listener: () => void) => subscribeCourseStream(courseId, listener),
    [courseId],
  );
  const getStreamSnapshot = useCallback(() => readCourseStream(courseId), [courseId]);
  const streaming = useSyncExternalStore(subscribeToStream, getStreamSnapshot, () => null);

  useEffect(() => {
    setHistory(readHistory(courseId));
    setQuery("");
  }, [courseId]);

  const ask = useMutation<string, unknown, ChatRequest>({
    mutationKey: ["course-chat", courseId],
    mutationFn: async ({ query, history, requestId }) => {
      // 思考内容与来源也累积到局部变量：随答案一起落库、保留（不受组件卸载影响）。
      let reasoningAcc = "";
      let citationsAcc: Citation[] = [];
      startCourseStream(courseId, requestId);
      try {
        const answer = await ipc.concepts.chat(
          courseId,
          query,
          history,
          requestId,
          (e: AskEvent) => {
            if (e.type === "reasoning") reasoningAcc += e.delta;
            if (e.type === "citations") citationsAcc = e.citations;
            updateCourseStream(courseId, requestId, (current) => {
              if (e.type === "reasoning") {
                return { ...current, reasoning: current.reasoning + e.delta };
              }
              if (e.type === "token") return { ...current, text: current.text + e.delta };
              if (e.type === "citations") return { ...current, citations: e.citations };
              return current; // done：最终答案由落库 + 历史渲染接管
            });
          },
        );
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
        return answer;
      } finally {
        // requestId 守卫避免旧请求的迟到收尾清掉后来一次重试的新流。
        finishCourseStream(courseId, requestId);
      }
    },
  });

  // MutationCache 跨组件卸载存活：抽屉重开后仍能恢复同一请求的 pending/error/result。
  const requestStates = useMutationState({
    filters: { mutationKey: ["course-chat", courseId] },
    select: (mutation) => ({
      status: mutation.state.status,
      variables: mutation.state.variables as ChatRequest | undefined,
      error: mutation.state.error,
    }),
  });
  const pendingStates = requestStates.filter(
    (request) => request.status === "pending" && request.variables,
  );
  const pendingRequest = pendingStates[pendingStates.length - 1]?.variables;
  const latestRequest = requestStates[requestStates.length - 1];
  const latestStatus = latestRequest?.status;
  const failedRequest =
    !pendingRequest && latestRequest?.status === "error" ? latestRequest : undefined;
  const busy = pendingRequest !== undefined;
  const cancellableRequestId = pendingRequest?.requestId;
  // 进行中（含抽屉关闭期间）或失败的那一句也显示在对话里，体验更连贯。
  const inFlightQuery = pendingRequest?.query ?? failedRequest?.variables?.query;
  const hasPendingChatRequest = () =>
    queryClient.getMutationCache().findAll({
      mutationKey: ["course-chat", courseId],
      exact: true,
      status: "pending",
    }).length > 0;

  // mutationFn 先落盘、MutationCache 再进入 success；无论抽屉是否中途卸载都从同一处刷新。
  useEffect(() => {
    if (latestStatus === "success") setHistory(readHistory(courseId));
  }, [courseId, latestStatus]);

  // 流式文本节流后再渲染：每个 token 只累积状态，全文解析至多 120ms 一次。
  const throttledStreamText = useThrottledValue(streaming?.text ?? "", 120);

  useEffect(() => {
    const tail = tailRef.current;
    if (!tail || typeof tail.scrollIntoView !== "function") return;
    // 流式期间用 auto（即时）：smooth 会被每次更新反复重启动画反而卡顿。
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    tail.scrollIntoView({
      block: "end",
      behavior: streaming || reduceMotion ? "auto" : "smooth",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, busy, failedRequest, throttledStreamText]);

  const submit = (raw?: string) => {
    const trimmed = (raw ?? query).trim();
    if (!trimmed || busy || hasPendingChatRequest()) return;
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
    const mutationCache = queryClient.getMutationCache();
    mutationCache
      .findAll({ mutationKey: ["course-chat", courseId], exact: true })
      .filter((mutation) => mutation.state.status !== "pending")
      .forEach((mutation) => mutationCache.remove(mutation));
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
        role="log"
        aria-label={t("courseChat.chatHistory")}
        aria-live="polite"
        aria-relevant="additions"
        aria-busy={busy}
        className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3"
      >
        {history.length === 0 && inFlightQuery === undefined && (
          <div className="flex flex-col items-center gap-3 px-2 pt-6 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/12 text-primary">
              <Sparkles className="h-6 w-6" />
            </span>
            <div>
              <div className="text-sm font-medium text-[var(--text-strong)]">{t("courseChat.askCourse")}</div>
              <p className="mx-auto mt-1 max-w-[260px] text-xs leading-relaxed text-[var(--text-faint)]">
                {t("courseChat.courseQaHint")}
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTION_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => submit(t(key))}
                  className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-1.5 text-xs text-[var(--text-normal)] transition hover:border-[var(--accent-text)] hover:bg-[var(--surface-card-hover)]"
                >
                  {t(key)}
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
                aria-label={t("courseChat.myQuestion")}
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
                aria-label={t("courseChat.aiReply")}
                className="min-w-0 max-w-[82%] rounded-2xl rounded-tl-sm border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2"
              >
                {turn.reasoning && (
                  <details className="mb-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card-hover)] px-2.5 py-1.5">
                    <summary className="cursor-pointer select-none text-xs text-[var(--text-faint)]">
                      {t("courseChat.thinking")}
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
                aria-label={t("courseChat.myQuestion")}
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
                        {t("courseChat.thinking")}
                      </summary>
                      <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-muted)]">
                        {streaming.reasoning}
                      </div>
                    </details>
                  )}
                  {streaming?.text ? (
                    <div
                      role="article"
                      aria-label={t("courseChat.aiReply")}
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
                        aria-label={t("courseChat.thinkingLabel")}
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
            {failedRequest && (
              <div className="flex items-start gap-2">
                {aiAvatar}
                <ErrorNote
                  className="min-w-0 flex-1"
                  error={failedRequest.error}
                  onRetry={() =>
                    failedRequest.variables &&
                    !hasPendingChatRequest() &&
                    ask.mutate({
                      ...failedRequest.variables,
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

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {busy
          ? t("courseChat.generationStarted")
          : latestStatus === "success"
            ? t("courseChat.answerReady")
            : ""}
      </p>

      <div className="flex-none border-t border-[var(--border-subtle)] p-2.5">
        <div className="flex items-center gap-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 transition focus-within:border-[var(--focus-ring)]">
          {history.length > 0 && (
            <button
              type="button"
              onClick={clearChat}
              aria-label={t("courseChat.clearChat")}
              title={t("courseChat.clearTitle")}
              className="ca-touch-44 inline-flex flex-none items-center justify-center rounded-full text-xs text-[var(--text-muted)] transition hover:text-[var(--status-err)]"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <input
            ref={inputRef}
            aria-label={t("courseChat.chatInput")}
            type="text"
            placeholder={t("courseChat.placeholder")}
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
              aria-label={t("courseChat.stopGeneration")}
              title={t("courseChat.stopTitle")}
              className="ca-touch-44 grid h-8 w-8 flex-none place-items-center rounded-full bg-[var(--surface-card-active)] text-[var(--text-strong)] transition hover:bg-[var(--surface-card-hover)]"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => submit()}
              disabled={busy || !query.trim()}
              aria-label={t("courseChat.send")}
              title={t("courseChat.sendTitle")}
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
