import { memo } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  LoaderCircle,
  RefreshCw,
  Save,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { AssistantActionList, type AssistantActionOutcome } from "@/components/AssistantActionCard";
import { AssistantToolChips } from "@/components/AssistantToolChips";
import { getAssistantInteractionState } from "@/lib/assistantSession";
import type { AssistantAction, AssistantContext } from "@/lib/types";
import { renderMarkdown } from "@/lib/renderMarkdown";
import {
  type Turn,
  usageTokens,
  checkpointSummary,
  streamingLabelFor,
  suggestionsFor,
} from "@/components/assistant/turnModel";

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
  return (
    <div className="break-words text-sm leading-relaxed text-[var(--text-normal)]">
      {renderMarkdown(answer, (ms) => onSeek(turn, ms))}
    </div>
  );
});

export function AssistantEmptyState({
  scopeLabel,
  context,
  actionExecutionBusy,
  onSend,
}: {
  scopeLabel: string;
  context: AssistantContext;
  actionExecutionBusy: boolean;
  onSend: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-full flex-col justify-center gap-4">
      <div>
        <p className="text-[15px] font-medium text-[var(--text-strong)]">{t("assistant.greeting")}</p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-faint)]">
          {t("assistant.greetingHint", { scope: scopeLabel })}
        </p>
      </div>
      <div className="grid w-full gap-1">
        {suggestionsFor(context, t).map((suggestion) => (
          <button
            key={suggestion.prompt}
            type="button"
            disabled={actionExecutionBusy}
            onClick={() => onSend(suggestion.prompt)}
            className="ca-touch-44 flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-sm text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
          >
            <span>{suggestion.label}</span>
            <ArrowUpRight className="h-3.5 w-3.5 flex-none text-[var(--text-faint)]" />
          </button>
        ))}
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
  onSeek,
  onNavigate,
  onOutcome,
  onExecutionStart,
  onExecutionEnd,
  onApplied,
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
  onSeek: (turn: Turn, ms: number) => void;
  onNavigate: (turn: Turn, action: AssistantAction) => void;
  onOutcome: (turnId: string, outcome: AssistantActionOutcome) => void;
  onExecutionStart: (turnId: string, actions: AssistantAction[]) => boolean;
  onExecutionEnd: () => void;
  onApplied?: (action: AssistantAction) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      {/* 自己说的话靠右、带底色；助手的靠左。一眼能分清谁说的，
          比让两边都是同一坨灰字强得多。 */}
      <div className="flex justify-end">
        <p
          data-testid="user-bubble"
          className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-[var(--accent-weak-2)] px-3 py-1.5 text-sm text-[var(--accent-text)]"
        >
          {turn.question}
        </p>
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

      {/* 工具链摆在回答前面：它解释了这段回答是怎么来的，
          也让「一轮里悄悄调了三次搜索」这种事看得见。 */}
      <AssistantToolChips tools={turn.tools} toolRuns={turn.toolRuns} />

      {/* 推理模型的思考。它比正文先到，所以不能塞在「有答案才渲染」的分支里——
          那样恰好在最想看它的那段时间（还没开始作答）什么都不显示。
          默认折叠：它是过程不是结论，摊开会把真正的回答挤下去。 */}
      {turn.reasoning && (
        <details className="group/think">
          <summary className="-ml-1 flex w-fit cursor-pointer select-none items-center gap-1 rounded px-1 py-0.5 text-[11px] text-[var(--text-faint)] transition-colors hover:text-[var(--text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] motion-reduce:transition-none">
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

      {turn.answer && (
        /* 回答不套气泡，整幅铺开。
           气泡是给一两行的短句用的；回答是长文——带列表、公式、代码。在一块本来就窄的
           面板里，边框加左右内边距再加 8% 的留白，等于每行少掉四五个字，一条列表项要多折
           一行。成熟的助手都是这么分的：你说的话进气泡，它答的话铺满。左右不对称本身
           已经把「谁在说」讲清楚了。 */
        <div className="group">
          <MemoAnswer answer={turn.answer} turn={turn} onSeek={onSeek} />
          {/* 每条回答底下常驻一排按钮，翻起来满屏都是灰图标。桌面端悬停或键盘聚焦才浮出来，
              但位置一直留着——不留的话鼠标一进来整段就往上跳。触屏没有悬停，一直显示。 */}
          <div
            className={`-ml-1.5 mt-0.5 flex items-center gap-0.5 ${
              mobile
                ? "h-11"
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
                  <Save className="h-3.5 w-3.5" />
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
            {!turn.pending && turn.usage && (
              <span
                data-testid="turn-usage"
                className="ml-1 whitespace-nowrap text-[10px] text-[var(--text-faint)]"
              >
                {t("assistant.usageTokens", {
                  tokens: usageTokens(turn.usage).toLocaleString(),
                })}
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
      {!turn.pending && (turn.hitTurnLimit || (!turn.answer && !turn.canceled)) && (
        <div className="flex items-start gap-1.5 border-l-2 border-[var(--border-strong)] pl-2 text-[11px] text-[var(--text-muted)]">
          <span className="min-w-0 flex-1 break-words">
            {turn.hitTurnLimit
              ? t("assistant.turnLimitFallback")
              : t("assistant.emptyAnswerFallback")}
          </span>
          {!turn.answer && isLast && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || actionExecutionBusy}
              onClick={() => onRegenerate(turn)}
              className="-my-1 h-6 flex-none px-1.5 text-[11px]"
            >
              <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
              {t("assistant.regenerate")}
            </Button>
          )}
        </div>
      )}

      <AssistantActionList
        actions={turn.actions}
        onNavigate={(action) => onNavigate(turn, action)}
        onOutcome={(outcome) => onOutcome(turn.id, outcome)}
        executionLocked={actionExecutionBusy}
        onExecutionStart={(actions) => onExecutionStart(turn.id, actions)}
        onExecutionEnd={onExecutionEnd}
        onApplied={onApplied}
      />

      {getAssistantInteractionState(turn).status === "expired" && (
        <div className="flex items-start gap-1.5 border-l-2 border-[var(--status-warn)] pl-2 text-[11px] text-[var(--status-warn)]">
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
              className="flex items-start gap-1.5 text-[11px] text-[var(--text-muted)]"
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
        <p className="border-l-2 border-[var(--border-faint)] pl-2 text-[11px] text-[var(--text-faint)]">
          {t("assistant.stopped")}
        </p>
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
      className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2.5 py-1 text-[11px] text-[var(--text-muted)] shadow-[var(--shadow-pop)] transition-colors hover:text-[var(--text-strong)] motion-reduce:transition-none"
    >
      <ArrowDown className="h-3 w-3" aria-hidden="true" />
      {t("assistant.scrollToLatest")}
    </button>
  );
}
