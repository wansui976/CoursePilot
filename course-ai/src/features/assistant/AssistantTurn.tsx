import { memo, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  Library,
  PlayCircle,
  FolderOpen,
  Check,
  ChevronRight,
  Copy,
  CornerDownRight,
  LoaderCircle,
  PenLine,
  NotebookPen,
  RefreshCw,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/ui/button";
import { AssistantActionList, type AssistantActionOutcome } from "./AssistantActionCard";
import { AssistantToolChips } from "./AssistantToolChips";
import { getAssistantInteractionState } from "@/lib/assistantSession";
import type { AssistantAction, AssistantContext } from "@/lib/types";
import { renderMarkdown } from "@/lib/renderMarkdown";
import { queries } from "@/lib/queries";
import { displayTitle } from "@/lib/videoTitle";
import { loadTurnImages } from "@/lib/assistantImageStore";
import { ImageLightbox } from "./ImageLightbox";
import { SocraticCard } from "./SocraticCard";
import { splitSocratic, type SocraticBlock } from "./socratic";
import { splitFollowups } from "./followups";
import {
  type Turn,
  usageTokens,
  checkpointSummary,
  streamingLabelFor,
  suggestionsFor,
  bracketBareTimestamps,
  formatElapsed,
  withoutInlineSeeks,
  compactTokens,
} from "./turnModel";
import { formatPosition } from "./assistantPanelModel";

/**
 * 助手面板的单轮问答渲染与空态。
 * 从 AssistantPanel 拆出的受控视图：轮次状态与流式处理留在面板，
 * 这里只负责把一轮已经发生/正在发生的事画出来。
 */

/**
 * 回答正文的整段渲染。
 *
 * 用 memo 包一层：流式期间只有当前这一轮在变，已经完成的回答字符串完全不变，
 * 不该因为 copiedTurnId、busy、scrolledAway 这类无关状态变化而被反复 parse（带公式的
 * 长回答每帧重解析是 O(n²) 的浪费）。seek 回调走 ref 取最新 navigate，保持引用稳定。
 */
const MemoAnswer = memo(function MemoAnswer({
  answer,
  turn,
  onSeek,
}: {
  answer: string;
  turn: Turn;
  onSeek: (turn: Turn, ms: number) => void;
}) {
  const text = turn.context?.video_id ? bracketBareTimestamps(answer) : answer;
  return (
    <div className="ca-prose text-sm leading-relaxed text-[var(--text-normal)]">
      {renderMarkdown(text, (ms) => onSeek(turn, ms))}
    </div>
  );
});

/**
 * 这一问附的图：本次运行里刚发的直接在内存里；重启后恢复的旧提问只剩张数，
 * 去 IndexedDB 按轮次 id 取回来。取不到就只能如实说原图没保存。
 */
function useTurnImages(turn: Turn) {
  const [stored, setStored] = useState<string[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const inMemory = turn.images && turn.images.length > 0 ? turn.images : null;
  const needsLoad = !inMemory && !!turn.imageCount;
  useEffect(() => {
    if (!needsLoad) return;
    let cancelled = false;
    void loadTurnImages(turn.id).then((images) => {
      if (cancelled) return;
      setStored(images && images.length > 0 ? images : null);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [needsLoad, turn.id]);
  return { images: inMemory ?? stored, loading: needsLoad && !loaded };
}

/** 提问气泡上方的附图缩略图，点开看大图。 */
function TurnImages({ turn }: { turn: Turn }) {
  const { t } = useTranslation();
  const { images, loading } = useTurnImages(turn);
  const [viewing, setViewing] = useState<number | null>(null);
  if (images) {
    return (
      <>
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
          {images.map((src, index) => (
            <button
              key={index}
              type="button"
              aria-label={t("assistant.viewImage", { index: index + 1 })}
              title={t("assistant.viewImage", { index: index + 1 })}
              onClick={() => setViewing(index)}
              className="overflow-hidden rounded-lg border border-[var(--border-subtle)] transition hover:border-[var(--border-strong)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <img
                src={src}
                alt={t("assistant.attachedImageAlt", { index: index + 1 })}
                className="h-16 w-16 object-cover"
              />
            </button>
          ))}
        </div>
        <ImageLightbox images={images} index={viewing} onClose={() => setViewing(null)} />
      </>
    );
  }
  if (!turn.imageCount || loading) return null;
  // 读不回原图（存储被清过、旧版本没存）：照实说附过图，而不是装作这一问只有文字。
  return (
    <span className="ca-t-2xs text-[var(--text-faint)]">
      {t("assistant.attachedImagesNotKept", { count: turn.imageCount })}
    </span>
  );
}

/** 空状态上方那句「现在对着什么问」：视频标题 + 课程 + 播放位置，或者当前课程、全部课程。 */
function useContextTitle(context: AssistantContext) {
  const { t } = useTranslation();
  const { data: courses } = useQuery({ ...queries.courses(), enabled: !!context.course_id });
  const { data: videos } = useQuery(queries.videos(context.video_id ? (context.course_id ?? null) : null));
  const courseName = courses?.find((course) => course.id === context.course_id)?.name ?? null;
  if (context.video_id) {
    const video = videos?.find((item) => item.id === context.video_id);
    const position =
      context.position_ms != null && context.position_ms > 0 ? formatPosition(context.position_ms) : null;
    return {
      icon: PlayCircle,
      eyebrow: t("assistant.contextWatching"),
      title: video ? displayTitle(video.title) : t("assistant.scopeCurrentVideo"),
      meta: [courseName, position].filter(Boolean).join(" · "),
    };
  }
  if (context.course_id) {
    return {
      icon: FolderOpen,
      eyebrow: t("assistant.contextCourse"),
      title: courseName ?? t("assistant.scopeCurrentCourse"),
      meta: "",
    };
  }
  return { icon: Library, eyebrow: t("assistant.contextAll"), title: t("assistant.scopeAllCourses"), meta: "" };
}

export function AssistantEmptyState({
  context,
  actionExecutionBusy,
  onSend,
}: {
  context: AssistantContext;
  actionExecutionBusy: boolean;
  onSend: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const scope = useContextTitle(context);
  const ScopeIcon = scope.icon;
  return (
    // 上半截原本整片空白：放一句「现在对着什么问」，打开就知道问的是哪个视频的哪一刻。
    // 下面贴着输入框是能问什么的说明和几个示例问题；示例做成胶囊按钮，一眼看得出能点。
    // 仍然不是「大标题 + 带边框的建议列表 + 每行一个 ↗」那套 AI 产品空状态标准件。
    <div className="ca-assistant-empty flex min-h-full flex-col gap-4 px-1 pb-1">
      <div className="ca-assistant-empty-hero flex flex-1 flex-col items-center justify-center gap-1.5 py-6 text-center">
        <ScopeIcon className="mb-1 h-6 w-6 text-[var(--text-faint)]" aria-hidden="true" />
        <p className="ca-t-2xs font-medium uppercase tracking-wide text-[var(--text-faint)]">{scope.eyebrow}</p>
        <p className="max-w-[18rem] text-sm font-medium leading-snug text-[var(--text-strong)] [overflow-wrap:anywhere]">
          {scope.title}
        </p>
        {scope.meta && (
          <p className="ca-t-2xs tabular-nums text-[var(--text-muted)]">{scope.meta}</p>
        )}
      </div>
      <div className="flex flex-col gap-2.5">
        <p className="ca-t-sm leading-relaxed text-[var(--text-muted)]">
          {t("assistant.greetingHint")}
        </p>
        <div className="flex flex-wrap gap-2">
          {suggestionsFor(context, t).map((suggestion) => (
            <button
              key={suggestion.prompt}
              type="button"
              disabled={actionExecutionBusy}
              onClick={() => onSend(suggestion.prompt)}
              className="ca-touch-44 inline-flex items-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-1 text-left text-sm text-[var(--text-normal)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AssistantTurn({
  turn,
  isLast,
  isPendingTurn,
  mobile,
  busy,
  actionExecutionBusy,
  hasVideoContext,
  copied,
  savedToNotes,
  onCopy,
  onSaveToNotes,
  onRegenerate,
  onEdit,
  editing = false,
  onSeek,
  onNavigate,
  onOutcome,
  onExecutionStart,
  onExecutionEnd,
  onApplied,
  onPickReply,
  onMakeCard,
  onAskFollowup,
}: {
  turn: Turn;
  isLast: boolean;
  /** 面板里唯一 pending 的那一轮才显示内联状态，避免重复的「整理结果」。 */
  isPendingTurn: boolean;
  mobile: boolean;
  busy: boolean;
  actionExecutionBusy: boolean;
  hasVideoContext: boolean;
  copied: boolean;
  savedToNotes: boolean;
  onCopy: (turn: Turn) => void;
  onSaveToNotes: (turn: Turn) => void;
  onRegenerate: (turn: Turn) => void;
  /** 编辑这一问后重发（只给最后一轮）。 */
  onEdit?: (turn: Turn) => void;
  /** 这一问正在输入框里被编辑。 */
  editing?: boolean;
  onSeek: (turn: Turn, ms: number) => void;
  onNavigate: (turn: Turn, action: AssistantAction) => void;
  onOutcome: (turnId: string, outcome: AssistantActionOutcome) => void;
  onExecutionStart: (turnId: string, actions: AssistantAction[]) => boolean;
  onExecutionEnd: () => void;
  onApplied?: (action: AssistantAction) => void;
  /** 引导模式：点了某个可选回答，当作用户的下一句发出去。 */
  onPickReply?: (reply: string) => void;
  /** 引导模式收尾：把推出的要点做成复习卡。 */
  onMakeCard?: (turn: Turn, block: SocraticBlock) => Promise<void>;
  /** 点了回答末尾的追问建议：当作下一句发出去。 */
  onAskFollowup?: (question: string) => void;
}) {
  const { t } = useTranslation();
  // 引导模式：回答末尾的结构块不显示原文，画成下面那张卡。
  const socratic = turn.mode === "socratic" ? splitSocratic(turn.answer) : null;
  // 结构块坏了 / 还没闭合、正文又是空的：整轮不能变成空白，按普通回答显示原文。
  // 普通问答：末尾的追问建议块同样不显示原文，画成下面那排胶囊。
  const followupSplit = turn.mode === "socratic" ? null : splitFollowups(turn.answer);
  const shownAnswer = socratic
    ? socratic.text.trim() || socratic.block
      ? socratic.text
      : turn.answer
    : followupSplit!.text;
  const followups = followupSplit?.followups ?? [];
  // 正文和结构块都没有：这一轮确实什么都没显示出来，得给一句提示和重试入口。
  const nothingVisible = !shownAnswer.trim() && !socratic?.block;
  // 正文里已经有同一时间点的可点时间戳时，下面不再重复挂「跳到」按钮。
  const renderedAnswer = turn.context?.video_id ? bracketBareTimestamps(shownAnswer) : shownAnswer;
  const inlineActions = useMemo(
    () => (turn.pending ? turn.actions : withoutInlineSeeks(turn.actions, renderedAnswer)),
    [turn.actions, turn.pending, renderedAnswer],
  );

  return (
    <div className="space-y-2">
      {/* 自己说的话靠右、带底色；助手的靠左。一眼能分清谁说的，
          比让两边都是同一坨灰字强得多。 */}
      <div className="flex flex-col items-end gap-1">
        <TurnImages turn={turn} />
        <div className="group/q flex max-w-full items-end justify-end gap-1">
          {/* 改最后一问再发一次（成熟的对话应用都有）：问法不对时不用整句重打。
              和重新回答一样只给最后一轮。桌面端悬停才出现，触屏一直显示。 */}
          {isLast && onEdit && !turn.pending && !editing && (
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("assistant.editQuestion")}
              title={t("assistant.editQuestion")}
              disabled={busy || actionExecutionBusy}
              onClick={() => onEdit(turn)}
              className={`ca-touch-44 h-7 w-7 flex-none text-[var(--text-faint)] ${
                mobile
                  ? ""
                  : "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/q:opacity-100 motion-reduce:transition-none"
              }`}
            >
              <PenLine className="h-3.5 w-3.5" />
            </Button>
          )}
          <p
            data-testid="user-bubble"
            className={`${editing ? "opacity-50 " : ""}ca-prose max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-[var(--accent-weak-2)] px-3 py-1.5 text-sm text-[var(--accent-text)]`}
          >
            {turn.question}
          </p>
        </div>
      </div>

      {/* 提问后、第一个工具/正文到达前，助手槽位是空的。给一个内联「正在思考」,
          别让用户对着自己刚发的话干等。纯视觉：读屏状态由底部 live region 统一播报,
          这里不加 role,避免多出一个 status 抢播。 */}
      {turn.pending && !turn.answer && isPendingTurn && (
        <div
          aria-hidden="true"
          className="ca-pulse-soft flex items-center gap-2 text-xs text-[var(--text-faint)]"
        >
          <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          <span>{streamingLabelFor(turn, t)}</span>
        </div>
      )}

      {/* 工具链和思考过程合成一行摆在回答前面：它们解释了这段回答是怎么来的，
          但都是折叠的过程信息，各占一行太占地方。展开的那个自己占满一行。 */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-0.5">
        <AssistantToolChips tools={turn.tools} toolRuns={turn.toolRuns} />

        {/* 推理模型的思考。它比正文先到，所以不能塞在「有答案才渲染」的分支里——
            那样恰好在最想看它的那段时间（还没开始作答）什么都不显示。
            默认折叠：它是过程不是结论，摊开会把真正的回答挤下去。 */}
        {turn.reasoning && (
          <details className="group/think open:basis-full">
            <summary className="-ml-1 flex w-fit cursor-pointer select-none items-center gap-1 rounded px-1 py-0.5 ca-t-2xs text-[var(--text-faint)] transition-colors hover:text-[var(--text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] motion-reduce:transition-none">
              <ChevronRight
                aria-hidden="true"
                className="h-3 w-3 flex-none transition-transform group-open/think:rotate-90 motion-reduce:transition-none"
              />
              {turn.pending ? (
                <span className="inline-flex items-center gap-1.5">
                  <LoaderCircle className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  {t("assistant.thinking")}
                </span>
              ) : (
                t("assistant.thinking")
              )}
            </summary>
            <div className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap border-l-2 border-[var(--border-faint)] pl-2 text-xs leading-relaxed text-[var(--text-muted)]">
              {turn.reasoning}
            </div>
          </details>
        )}
      </div>

      {turn.answer && (
        /* 回答不套气泡，整幅铺开。
           气泡是给一两行的短句用的；回答是长文——带列表、公式、代码。在一块本来就窄的
           面板里，边框加左右内边距再加 8% 的留白，等于每行少掉四五个字，一条列表项要多折
           一行。成熟的助手都是这么分的：你说的话进气泡，它答的话铺满。左右不对称本身
           已经把「谁在说」讲清楚了。 */
        <div className="group">
          <MemoAnswer answer={shownAnswer} turn={turn} onSeek={onSeek} />
          {socratic?.block && !turn.pending && (
            <SocraticCard
              block={socratic.block}
              cardKey={turn.id}
              interactive={
                isLast && !busy && !actionExecutionBusy && !editing && Boolean(onPickReply)
              }
              canMakeCard={hasVideoContext && Boolean(onMakeCard)}
              onPick={(reply) => onPickReply?.(reply)}
              onSeek={(ms) => onSeek(turn, ms)}
              onMakeCard={() => onMakeCard?.(turn, socratic.block!) ?? Promise.resolve()}
            />
          )}
          {/* 每条回答底下常驻一排按钮，翻起来满屏都是灰图标。桌面端旧回答悬停或键盘聚焦才浮出来，
              但位置一直留着——不留的话鼠标一进来整段就往上跳。最新一轮一直显示：复制、存笔记、
              重新回答几乎都是冲着刚拿到的回答去的，藏起来等于让人去猜。触屏没有悬停，一直显示。 */}
          <div
            className={`-ml-1.5 mt-0.5 flex items-center gap-0.5 ${
              mobile
                ? "h-11"
                : isLast
                  ? "h-7"
                  : "h-7 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
            }`}
          >
            <Button
              size="icon"
              variant="ghost"
              aria-label={copied ? t("assistant.copiedLabel") : t("assistant.copyAnswer")}
              title={copied ? t("assistant.copiedLabel") : t("assistant.copyAnswer")}
              onClick={() => onCopy(turn)}
              className="ca-touch-44 h-7 w-7 text-[var(--text-faint)]"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-[var(--status-ok)]" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
            {/* 有视频上下文时才能存进笔记：笔记是挂在视频上的。 */}
            {hasVideoContext && (
              <Button
                size="icon"
                variant="ghost"
                aria-label={savedToNotes ? t("assistant.savedToNotes") : t("assistant.saveToNotes")}
                title={savedToNotes ? t("assistant.savedToNotes") : t("assistant.saveToNotes")}
                onClick={() => onSaveToNotes(turn)}
                className="ca-touch-44 h-7 w-7 text-[var(--text-faint)]"
              >
                {savedToNotes ? (
                  <Check className="h-3.5 w-3.5 text-[var(--status-ok)]" />
                ) : (
                  <NotebookPen className="h-3.5 w-3.5" />
                )}
              </Button>
            )}
            {/* 只给最后一轮。往回重生成会让它后面的问答全部失去依据——那已经是分支，
                不是重试了。 */}
            {isLast && (
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("assistant.regenerate")}
                title={t("assistant.regenerate")}
                disabled={busy || actionExecutionBusy}
                onClick={() => onRegenerate(turn)}
                className="ca-touch-44 h-7 w-7 text-[var(--text-faint)]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            )}
            {/* 这一轮实际花了多少：跟操作按钮同一排、同样只在 hover 时出现。
                端点没报用量就不显示——把「没报」当成零消耗是撒谎。 */}
            {/* 用时和用量：等了多久、花了多少，都该看得见。 */}
            {!turn.pending && (turn.usage || turn.durationMs) && (
              <span
                data-testid="turn-usage"
                title={
                  turn.usage
                    ? t("assistant.usageTokens", {
                        tokens: usageTokens(turn.usage).toLocaleString(),
                      })
                    : undefined
                }
                className="ml-1 min-w-0 truncate ca-t-2xs tabular-nums text-[var(--text-faint)]"
              >
                {[
                  turn.durationMs ? formatElapsed(turn.durationMs, t) : null,
                  // 一排图标后面跟一句「本次消耗 5,380 tokens」太像日志；缩成 5.4k，完整数字悬停看。
                  turn.usage
                    ? t("assistant.usageTokensShort", {
                        tokens: compactTokens(usageTokens(turn.usage)),
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
          </div>
        </div>
      )}

      {/* 这一轮没能好好结束时说清楚。
          工具轮或上下文预算封顶且强制总结仍失败时，answer 里留的往往是它某一轮的过场话
          （「我先查一下这门课有哪些视频」），甚至是空串。照原样铺出来，用户要么
          把过场话当成最终答复，要么问完之后**什么都没有**——后者和程序坏了长得
          一模一样，而它其实是查得太久被截断了，换个具体点的问法就能过去。
          正文空着的时候顺带把重新回答放在这儿：那排悬停按钮挂在回答上，
          恰恰是最需要重试的这种情况反而没有入口。 */}
      {/* 请求失败：原因写在这一轮自己下面，重试就在旁边。半截回答和查过的工具照常留着。 */}
      {turn.failed && !turn.pending && (
        <div
          role="alert"
          className="flex items-start gap-1.5 border-l-2 border-[var(--status-err)] pl-2 ca-t-2xs text-[var(--text-muted)]"
        >
          <span className="min-w-0 flex-1 break-words">
            <span className="font-medium text-[var(--status-err)]">{t("assistant.turnFailed")}</span>
            {" "}
            {turn.failed}
          </span>
          {isLast && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || actionExecutionBusy}
              onClick={() => onRegenerate(turn)}
              className="ca-touch-44 -my-1 h-6 flex-none px-1.5 ca-t-2xs"
            >
              <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
              {t("assistant.retry")}
            </Button>
          )}
        </div>
      )}

      {!turn.pending &&
        !turn.failed &&
        (turn.hitTurnLimit || (nothingVisible && !turn.canceled)) && (
        <div className="flex items-start gap-1.5 border-l-2 border-[var(--border-strong)] pl-2 ca-t-2xs text-[var(--text-muted)]">
          <span className="min-w-0 flex-1 break-words">
            {turn.hitTurnLimit
              ? t("assistant.turnLimitFallback")
              : t("assistant.emptyAnswerFallback")}
          </span>
          {nothingVisible && isLast && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || actionExecutionBusy}
              onClick={() => onRegenerate(turn)}
              className="-my-1 h-6 flex-none px-1.5 ca-t-2xs"
            >
              <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
              {t("assistant.regenerate")}
            </Button>
          )}
        </div>
      )}

      <AssistantActionList
        actions={inlineActions}
        onNavigate={(action) => onNavigate(turn, action)}
        onOutcome={(outcome) => onOutcome(turn.id, outcome)}
        executionLocked={actionExecutionBusy}
        onExecutionStart={(actions) => onExecutionStart(turn.id, actions)}
        onExecutionEnd={onExecutionEnd}
        onApplied={onApplied}
      />

      {getAssistantInteractionState(turn).status === "expired" && (
        <div className="flex items-start gap-1.5 border-l-2 border-[var(--status-warn)] pl-2 ca-t-2xs text-[var(--status-warn)]">
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="break-words">
              {turn.checkpoint?.expiredReason === "interrupted"
                ? t("assistant.expiredActionsInterrupted")
                : turn.checkpoint?.expiredReason === "timeout"
                  ? t("assistant.expiredActionsTimeout")
                  : t("assistant.expiredActions")}
            </p>
            {turn.checkpoint && (
              <p className="break-words text-[var(--text-faint)]">
                {checkpointSummary(turn.checkpoint, t)}
              </p>
            )}
          </div>
          {isLast && (
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("assistant.recheckExpired")}
              title={t("assistant.recheckExpired")}
              disabled={busy || actionExecutionBusy}
              onClick={() => onRegenerate(turn)}
              className="-my-1 h-6 w-6 flex-none text-[var(--status-warn)]"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
            </Button>
          )}
        </div>
      )}

      {turn.actionResults.length > 0 && (
        <div aria-label={t("assistant.actionRecord")} className="space-y-1">
          {turn.actionResults.map((result, index) => (
            <p
              key={`${turn.id}-result-${index}`}
              className="flex items-start gap-1.5 ca-t-2xs text-[var(--text-muted)]"
            >
              <span
                className="mt-[0.45em] h-1.5 w-1.5 flex-none rounded-full bg-[var(--accent)]"
                aria-hidden="true"
              />
              <span className="min-w-0 break-words">{t("assistant.actionResult", { result })}</span>
            </p>
          ))}
        </div>
      )}

      {turn.canceled && (
        <p className="border-l-2 border-[var(--border-faint)] pl-2 ca-t-2xs text-[var(--text-faint)]">
          {t("assistant.stopped")}
        </p>
      )}

      {/* 追问建议只挂在最新一轮：往回点旧回答的追问，接上的是最新那轮的上下文，答非所问。 */}
      {isLast && !turn.pending && !turn.failed && !turn.canceled && followups.length > 0 && onAskFollowup && (
        <div
          role="group"
          aria-label={t("assistant.followupsLabel")}
          className="flex flex-wrap gap-1.5 pt-0.5"
        >
          {followups.map((question) => (
            <button
              key={question}
              type="button"
              disabled={busy || actionExecutionBusy || editing}
              onClick={() => onAskFollowup(question)}
              className="ca-touch-44 inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2.5 py-1 text-left ca-t-xs text-[var(--text-normal)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
            >
              <CornerDownRight className="h-3 w-3 flex-none text-[var(--text-faint)]" aria-hidden="true" />
              <span className="min-w-0 break-words">{question}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 「回到最新」浮钮：翻上去看旧回答时新内容落在屏幕外的那条回路。 */
export function JumpToLatest({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2.5 py-1 ca-t-2xs text-[var(--text-muted)] shadow-[var(--shadow-pop)] transition-colors hover:text-[var(--text-strong)] motion-reduce:transition-none"
    >
      <ArrowDown className="h-3 w-3" aria-hidden="true" />
      {t("assistant.scrollToLatest")}
    </button>
  );
}
