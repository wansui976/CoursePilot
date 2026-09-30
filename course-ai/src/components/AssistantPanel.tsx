import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { qk } from "@/lib/queryKeys";
import type { TFunction } from "i18next";
import { useQueryClient } from "@tanstack/react-query";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import {
  ChevronLeft,
  ChevronRight,
  GripHorizontal,
  History as HistoryIcon,
  LoaderCircle,
  MessageSquarePlus,
  MoreHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem } from "@/components/ui/menu";
import type { AssistantActionOutcome } from "@/components/AssistantActionCard";
import {
  boundTrustedAssistantHistory,
  capAssistantText,
  historyBeforeLastQuestion,
  MAX_ASSISTANT_ANSWER_CHARS,
  MAX_ASSISTANT_REASONING_CHARS,
  MAX_ASSISTANT_TURNS,
  reconcileAssistantToolRuns,
  writeAssistantSession,
  type AssistantSession,
  type AssistantToolRun,
  type AssistantToolRunStatus,
} from "@/lib/assistantSession";
import {
  appendRecentAssistantQuestion,
  createAssistantConversation,
  MAX_ASSISTANT_CONVERSATIONS,
  readAssistantConversation,
  readAssistantConversations,
  readRecentAssistantQuestions,
  saveAssistantConversation,
  tryCreateAssistantConversation,
  tryDeleteAssistantConversation,
  tryRenameAssistantConversation,
  trySetActiveAssistantConversation,
  type AssistantConversationsState,
} from "@/lib/assistantConversations";
import { humanizeError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import { notesCoordinator } from "@/lib/notesCoordinator";
import { isMobile, isTablet } from "@/lib/platform";
import { formatMs } from "@/lib/time";
import {
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  useAssistantUi,
} from "@/stores/assistant";
import { useInlineAsk } from "@/stores/inlineAsk";
import { useTheme } from "@/stores/theme";
import { usePanelWindowing } from "@/components/assistant/usePanelWindowing";
import { ConversationHistory } from "@/components/assistant/ConversationHistory";
import {
  AssistantEmptyState,
  AssistantTurn,
  JumpToLatest,
} from "@/components/assistant/AssistantTurn";
import {
  streamingLabelFor,
  type Turn,
} from "@/components/assistant/turnModel";
import {
  AssistantComposer,
  type ScopeChoice,
  type ScopeOption,
} from "@/components/assistant/AssistantComposer";
import type {
  AgentStopReason,
  AssistantAction,
  AssistantContext,
  AssistantMessage,
  AssistantReply,
} from "@/lib/types";

/**
 * 常驻的全局助手面板。
 *
 * 桌面端可拖动，移到左右边缘时吸附成窄条；手机端没有「边缘停靠」的余地，
 * 改成底部抽屉——两种外壳共用同一套状态和消息流，切换的只是容器。
 */

const SCROLL_FOLLOW_THRESHOLD = 32;
const SESSION_PERSIST_DELAY_MS = 250;
// 只让用户操作确定能写进会话快照的轮次；否则第 21-50 轮的旧确认卡仍可见，
// 但 serializer 会裁掉它的 executing checkpoint。
const MAX_RENDERED_TURNS = MAX_ASSISTANT_TURNS;
const MAX_STREAMED_TOOLS = 50;
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])';

function appendStreamChunk(
  chunks: string[],
  currentChars: number,
  delta: string,
  maxChars: number,
) {
  const kept = delta.slice(0, Math.max(0, maxChars - currentChars));
  if (!kept) return currentChars;
  chunks.push(kept);
  // 后台标签页可能长时间不执行动画帧；偶尔合并小片段，避免数组对象本身无限增长。
  if (chunks.length >= 256) chunks.splice(0, chunks.length, chunks.join(""));
  return currentChars + kept.length;
}

/** 呼出快捷键的显示写法。Mac 用 ⌘，其余平台用 Ctrl。 */
function toggleShortcutLabel() {
  if (typeof navigator === "undefined") return "Ctrl+J";
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "⌘J" : "Ctrl+J";
}


function recordToolStarted(
  toolRuns: AssistantToolRun[],
  callId: string,
  name: string,
): AssistantToolRun[] {
  const existing = toolRuns.find((run) => run.callId === callId);
  if (existing) return toolRuns;
  const next: AssistantToolRun = { callId, name, status: "running" };
  return [...toolRuns, next].slice(-MAX_STREAMED_TOOLS);
}

function recordToolFinished(
  toolRuns: AssistantToolRun[],
  callId: string,
  name: string,
  status: AssistantToolRunStatus,
): AssistantToolRun[] {
  const index = toolRuns.findIndex((run) => run.callId === callId);
  if (index < 0) {
    const next: AssistantToolRun = { callId, name, status };
    return [...toolRuns, next].slice(-MAX_STREAMED_TOOLS);
  }
  // 重复或迟到事件不能把一个已经确定的终态改回另一种状态。
  if (
    toolRuns[index].status !== "running" &&
    !(toolRuns[index].status === "unknown" && status !== "unknown")
  ) {
    return toolRuns;
  }
  return toolRuns.map((run, runIndex) =>
    runIndex === index ? { ...run, name, status } : run,
  );
}

function normalizeFinishedToolStatus(
  status: unknown,
  canceled: boolean,
): AssistantToolRunStatus {
  return status === "completed" || status === "failed" || status === "canceled"
    ? status
    : canceled
      ? "canceled"
      : "unknown";
}

const EMPTY_ASSISTANT_SESSION: AssistantSession = { turns: [], history: [], draft: "" };

function initialAssistantConversation() {
  let conversations = readAssistantConversations();
  if (!conversations.activeId) conversations = createAssistantConversation();
  const activeId = conversations.activeId;
  const session = activeId
    ? (readAssistantConversation(activeId)?.session ?? EMPTY_ASSISTANT_SESSION)
    : EMPTY_ASSISTANT_SESSION;
  return { conversations, session };
}

function normalizedStopReason(reply: AssistantReply): AgentStopReason {
  if (reply.stop_reason) return reply.stop_reason;
  if (reply.canceled) return "canceled";
  if (reply.hit_turn_limit) return "limit_reached";
  return "completed";
}

function formatPosition(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function isNearScrollEnd(box: HTMLElement) {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= SCROLL_FOLLOW_THRESHOLD;
}

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true",
  );
}

function contextLabel(context: AssistantContext, t: TFunction) {
  if (context.video_id) {
    return context.position_ms != null && context.position_ms > 0
      ? t("assistant.scopeCurrentVideoAt", { position: formatPosition(context.position_ms) })
      : t("assistant.scopeCurrentVideo");
  }
  if (context.course_id) return t("assistant.scopeCurrentCourse");
  return t("assistant.scopeAllCourses");
}



/**
 * 回答正文的整段渲染。
 *
 * 用 memo 包一层：流式期间只有当前这一轮在变，已经完成的回答字符串完全不变，
 * 不该因为 copiedTurnId、busy、scrolledAway 这类无关状态变化而被反复 parse（带公式的
 * 长回答每帧重解析是 O(n²) 的浪费）。seek 回调走 ref 取最新 navigate，保持引用稳定。
 */

export function AssistantPanel({
  context,
  onNavigate,
  onActionApplied,
  compact = false,
  bottomNavigationVisible = false,
  launcherVisible = true,
}: {
  context: AssistantContext;
  /** 打开视频 / 跳转由外层执行——只有它知道播放器和路由。 */
  onNavigate: (action: AssistantAction) => void;
  /** 确认动作落地后同步外层选择态，例如删除正在观看的视频。 */
  onActionApplied?: (action: AssistantAction) => void;
  /** 跟随 Home 的实际布局档位；窄窗口即使是桌面 UA 也应使用抽屉。 */
  compact?: boolean;
  /** 课程库窄屏下底部有 56px 主导航，抽屉和入口都要避开它。 */
  bottomNavigationVisible?: boolean;
  /** 工具型整页可以暂时收起入口，避免浮钮盖住设置/回收站的行内操作。 */
  launcherVisible?: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { open, side, width, setOpen } = useAssistantUi();
  const [initialConversation] = useState(initialAssistantConversation);
  const initialSession = initialConversation.session;
  const [conversationState, setConversationState] = useState<AssistantConversationsState>(
    initialConversation.conversations,
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [input, setInput] = useState(initialSession.draft);
  const [busy, setBusy] = useState(false);
  const [actionExecutionCount, setActionExecutionCount] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [statusAnnouncement, setStatusAnnouncement] = useState("");
  const [turns, setTurns] = useState<Turn[]>(initialSession.turns);
  const [history, setHistory] = useState<AssistantMessage[]>(initialSession.history);
  const [conversationEpoch, setConversationEpoch] = useState(0);
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followScrollRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const activeRequestRef = useRef<string | null>(null);
  const activeConversationIdRef = useRef(initialConversation.conversations.activeId);
  const actionExecutionCountRef = useRef(0);
  const deletingConversationIdRef = useRef<string | null>(null);
  const pendingDeleteFocusRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const locallyStoppedRequestsRef = useRef(new Set<string>());
  const actionEventsByRequestRef = useRef(new Map<string, AssistantMessage[]>());
  const historyRef = useRef(initialSession.history);
  const conversationEpochRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);
  const saveToNotesTimerRef = useRef<number | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  const recentQuestionsRef = useRef(readRecentAssistantQuestions());
  const recentQuestionIndexRef = useRef<number | null>(null);
  const recentQuestionDraftRef = useRef(initialSession.draft);
  const hadPendingTurnRef = useRef(initialSession.turns.some((turn) => turn.pending));
  const sessionSnapshotRef = useRef({
    turns: initialSession.turns,
    history: initialSession.history,
    draft: initialSession.draft,
  });
  // iPad 宽屏有足够空间使用可拖动面板；真正决定布局的是视口档位，不是触屏 UA。
  const mobile = compact || (isMobile() && !isTablet());
  // 拖动、吸附、缩放、抽屉手势这套「窗口化」交互整体在 usePanelWindowing 里。
  const windowing = usePanelWindowing({
    mobile,
    panelRef,
    focusInput: () => requestAnimationFrame(() => inputRef.current?.focus()),
  });
  const {
    position,
    dockTop,
    launcherPosition,
    dragging,
    snapSide,
    panelWidth,
    sheetDragY,
    suppressLauncherClickRef,
    focusLauncherAfterCloseRef,
    movePanelToSide,
    openFromDock,
    collapseToNearestSide,
    beginPanelDrag,
    beginDockDrag,
    beginResize,
    resizeWithKeyboard,
    movePanelWithKeyboard,
    beginSheetCloseDrag,
  } = windowing;
  /** 用户翻上去看旧消息了吗。翻上去了就给一个「回到最新」的按钮，不然新回答落在屏幕外没人知道。 */
  const [scrolledAway, setScrolledAway] = useState(false);
  /** 收起后又有新回答落下、用户还没回来看过。给球挂一个「完成点」。 */
  const [hasUnread, setHasUnread] = useState(false);
  /** 刚保存到笔记的那条回答，短暂显示对勾反馈。 */
  const [savedToNotesTurnId, setSavedToNotesTurnId] = useState<string | null>(null);
  /** 被 MAX_RENDERED_TURNS 截掉、不再显示在列表里的更早轮次数量。 */
  const [hiddenTurnCount, setHiddenTurnCount] = useState(0);
  /** 用户显式选择的提问范围；auto 跟随当前选中项。 */
  const [scopeChoice, setScopeChoice] = useState<ScopeChoice>("auto");
  /** 正在重命名的会话 id 与其输入草稿。 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  /** 头部「⋯」菜单：收纳换边这类一次性低频操作。 */
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const headerMenuRef = useRef<HTMLDivElement>(null);
  const headerMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const toggleRef = useRef(() => {});
  const navigateFromTurnRef = useRef<(turn: Turn, action: AssistantAction) => void>(() => {});
  const conversationButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const renameButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const deleteButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  // 「现在在干什么」跟着流走：工具执行优先于此前已经吐出的思考或过场正文。
  const pendingTurn = turns.find((turn) => turn.pending);
  const streamingLabel = pendingTurn ? streamingLabelFor(pendingTurn, t) : "";
  const setThemePref = useTheme((state) => state.setPref);
  const pendingInlineAsk = useInlineAsk((state) => state.pending);
  const clearInlineAsk = useInlineAsk((state) => state.clear);

  // 范围选择：auto 跟随界面当前选中项；显式三档覆盖 context 后再发给后端。
  const resolvedScope: "video" | "course" | "all" =
    scopeChoice === "video" && context.video_id
      ? "video"
      : scopeChoice === "course" && context.course_id
        ? "course"
        : scopeChoice === "all"
          ? "all"
          : context.video_id
            ? "video"
            : context.course_id
              ? "course"
              : "all";
  function scopedContext(scope: "video" | "course" | "all"): AssistantContext {
    if (scope === "video") return context;
    if (scope === "course")
      return { course_id: context.course_id, video_id: null, position_ms: null };
    return { course_id: null, video_id: null, position_ms: null };
  }
  const resolvedContext = scopedContext(resolvedScope);
  const scopeLabel = contextLabel(resolvedContext, t);
  const scopeOptions: ScopeOption[] = [
    { value: "auto", label: t("assistant.scopeAuto"), enabled: true },
    {
      value: "video",
      label: t("assistant.scopeCurrentVideo"),
      enabled: Boolean(context.video_id),
    },
    {
      value: "course",
      label: t("assistant.scopeCurrentCourse"),
      enabled: Boolean(context.course_id),
    },
    { value: "all", label: t("assistant.scopeAllCourses"), enabled: true },
  ];

  const actionExecutionBusy = actionExecutionCount > 0;
  const conversationMutationBusy = deletingConversationId !== null;
  const generationStatus = stopping ? t("assistant.stopping") : streamingLabel;

  // 读屏播报走 sr-only 的 live region；可见的阶段提示只有回合内那一条内联状态，
  // 之前底部再渲染一份可见状态，和内联那条完全重复。live region 与动作回执共用
  // 一个状态，不能互相遮住：旧确认卡可能在新一轮生成期间完成，动作回执必须先被
  // 读屏播报，再由下一次阶段变化接管通知文本。
  // 删除失败后要把焦点还给删除按钮，但删除中按钮是 disabled 的：此时 focus() 静默无效。
  // 必须等 deletingConversationId 置空、按钮恢复可聚焦后的那一帧再聚焦。
  useEffect(() => {
    if (deletingConversationId !== null) return;
    const restoreId = pendingDeleteFocusRef.current;
    if (!restoreId) return;
    pendingDeleteFocusRef.current = null;
    const frame = requestAnimationFrame(() =>
      deleteButtonRefs.current.get(restoreId)?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [deletingConversationId]);

  useEffect(() => {
    if (busy) setStatusAnnouncement(generationStatus);
  }, [busy, generationStatus]);

  useEffect(() => {
    if (!historyOpen) return;
    const frame = requestAnimationFrame(() => {
      const activeId = activeConversationIdRef.current;
      const activeButton = activeId ? conversationButtonRefs.current.get(activeId) : null;
      const firstButton = conversationButtonRefs.current.values().next().value;
      (activeButton ?? firstButton)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [historyOpen, conversationState.activeId]);

  const persistConversationSnapshot = useCallback(
    (conversationId: string | null, snapshot: AssistantSession, now = Date.now()) => {
      if (!conversationId) return false;
      const result = saveAssistantConversation({ id: conversationId, session: snapshot }, now);
      // 固定 key 只镜像当前会话，供旧版本和索引损坏时回退。迟到的旧会话定时器
      // 仍可按捕获 id 保存自己的快照，但绝不能覆盖当前镜像。
      if (result.snapshotSaved && conversationId === activeConversationIdRef.current) {
        writeAssistantSession(snapshot, now);
      }
      if (mountedRef.current) setConversationState(result.state);
      if (!result.snapshotSaved && mountedRef.current) {
        setError(t("assistant.conversationSaveFailed"));
      }
      return result.snapshotSaved;
    },
    [t],
  );

  const clearScheduledPersistence = useCallback(() => {
    if (persistTimerRef.current == null) return;
    window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = null;
  }, []);

  function resetRecentQuestionNavigation(draft: string) {
    recentQuestionIndexRef.current = null;
    recentQuestionDraftRef.current = draft;
  }

  function setInputFromUser(value: string) {
    resetRecentQuestionNavigation(value);
    setInput(value);
  }

  function moveInputCaretToEnd() {
    requestAnimationFrame(() => {
      const textarea = inputRef.current;
      if (!textarea) return;
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
  }

  function navigateRecentQuestions(event: KeyboardEvent<HTMLTextAreaElement>) {
    const currentIndex = recentQuestionIndexRef.current;
    if (
      (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    ) {
      return false;
    }

    if (event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) {
      if (currentIndex != null) resetRecentQuestionNavigation(event.currentTarget.value);
      return false;
    }
    // 召回后光标会停在末尾，连续上下键继续浏览；一旦用户把光标移进文本中间，
    // 就把当前内容当成普通草稿，方向键交还给 textarea 的多行编辑。
    if (
      currentIndex != null &&
      event.currentTarget.selectionStart !== event.currentTarget.value.length
    ) {
      resetRecentQuestionNavigation(event.currentTarget.value);
      return false;
    }

    const questions = recentQuestionsRef.current;
    if (event.key === "ArrowUp") {
      if (questions.length === 0 || (currentIndex == null && event.currentTarget.selectionStart !== 0)) {
        return false;
      }
      if (currentIndex == null) recentQuestionDraftRef.current = event.currentTarget.value;
      const nextIndex = Math.max(0, (currentIndex ?? questions.length) - 1);
      event.preventDefault();
      recentQuestionIndexRef.current = nextIndex;
      setInput(questions[nextIndex]);
      moveInputCaretToEnd();
      return true;
    }

    if (currentIndex == null) return false;
    event.preventDefault();
    if (currentIndex < questions.length - 1) {
      const nextIndex = currentIndex + 1;
      recentQuestionIndexRef.current = nextIndex;
      setInput(questions[nextIndex]);
    } else {
      recentQuestionIndexRef.current = null;
      setInput(recentQuestionDraftRef.current);
    }
    moveInputCaretToEnd();
    return true;
  }

  function updateTrackedTurns(update: (previous: Turn[]) => Turn[]) {
    sessionSnapshotRef.current = {
      ...sessionSnapshotRef.current,
      turns: update(sessionSnapshotRef.current.turns),
    };
    if (mountedRef.current) setTurns(update);
  }

  function beginActionExecution(
    turnId: string,
    executingActions: AssistantAction[],
    epoch: number,
  ) {
    if (
      !mountedRef.current ||
      epoch !== conversationEpochRef.current ||
      executingActions.length === 0 ||
      actionExecutionCountRef.current > 0
    ) {
      return false;
    }
    const previousSnapshot = sessionSnapshotRef.current;
    actionExecutionCountRef.current = 1;
    const executing = new Set(executingActions);
    updateTrackedTurns((previous) =>
      previous.map((turn) => {
        if (turn.id !== turnId) return turn;
        const indexes = new Set(turn.executingActionIndexes ?? []);
        turn.actions.forEach((action, index) => {
          if (executing.has(action)) indexes.add(index);
        });
        return { ...turn, executingActionIndexes: [...indexes].sort((a, b) => a - b) };
      }),
    );
    // 不可逆动作边界不能只等防抖或 React cleanup；窗口硬关闭时两者都不保证运行。
    if (!persistConversationSnapshot(activeConversationIdRef.current, sessionSnapshotRef.current)) {
      actionExecutionCountRef.current = 0;
      sessionSnapshotRef.current = previousSnapshot;
      setTurns(previousSnapshot.turns);
      setActionExecutionCount(0);
      setError(t("assistant.actionCheckpointSaveFailed"));
      setStatusAnnouncement(t("assistant.actionCheckpointSaveFailed"));
      return false;
    }
    setActionExecutionCount(1);
    return true;
  }

  function endActionExecution() {
    actionExecutionCountRef.current = 0;
    if (mountedRef.current) setActionExecutionCount(0);
  }

  function commitActionOutcome(
    turnId: string,
    outcome: AssistantActionOutcome,
    epoch: number,
  ) {
    if (epoch !== conversationEpochRef.current) return;
    const resolved = new Set(outcome.resolvedActions);
    const finished = new Set(outcome.finishedActions);
    const nextTurns = sessionSnapshotRef.current.turns.map((turn) => {
        if (turn.id !== turnId) return turn;
        const indexes = new Set(turn.resolvedActionIndexes ?? []);
        turn.actions.forEach((action, index) => {
          if (resolved.has(action)) indexes.add(index);
        });
        const executingActionIndexes = turn.executingActionIndexes?.filter(
          (index) => !finished.has(turn.actions[index]),
        );
        return {
          ...turn,
          resolvedActionIndexes:
            indexes.size > 0 ? [...indexes].sort((a, b) => a - b) : undefined,
          executingActionIndexes:
            executingActionIndexes && executingActionIndexes.length > 0
              ? executingActionIndexes
              : undefined,
          actionResults:
            outcome.resultMessages.length > 0
              ? [...turn.actionResults, ...outcome.resultMessages]
              : turn.actionResults,
        };
      });
    const actionEvents: AssistantMessage[] = outcome.resultMessages.map((message) => ({
      role: "assistant",
      content: t("assistant.uiActionResult", { message }),
    }));
    const requestId = activeRequestRef.current;
    if (requestId && actionEvents.length > 0) {
      actionEventsByRequestRef.current.get(requestId)?.push(...actionEvents);
    }
    const nextHistory =
      actionEvents.length > 0
        ? boundTrustedAssistantHistory([...historyRef.current, ...actionEvents])
        : historyRef.current;
    historyRef.current = nextHistory;
    sessionSnapshotRef.current = {
      ...sessionSnapshotRef.current,
      turns: nextTurns,
      history: nextHistory,
    };
    if (mountedRef.current) {
      setTurns(nextTurns);
      if (actionEvents.length > 0) {
        setHistory(nextHistory);
        setStatusAnnouncement(
          t("assistant.actionResultAnnouncement", {
            result: outcome.resultMessages[outcome.resultMessages.length - 1],
          }),
        );
      }
      persistConversationSnapshot(activeConversationIdRef.current, sessionSnapshotRef.current);
    }
  }

  function navigateFromTurn(turn: Turn, action: AssistantAction) {
    // 时间点属于回答生成时的视频。用户可能在等待期间或之后切了视频，不能把旧时间戳
    // 直接 seek 到新播放器里。
    if (
      action.kind === "seek_to" &&
      turn.context?.video_id &&
      turn.context.video_id !== context.video_id
    ) {
      onNavigate({
        kind: "open_video",
        course_id: turn.context.course_id,
        video_id: turn.context.video_id,
        title: t("assistant.originalVideo"),
        at_ms: action.at_ms,
      });
      return;
    }
    onNavigate(action);
  }

  // seek 回调保持引用稳定，供 MemoAnswer 的 memo 生效；始终读最新的 navigateFromTurn。
  navigateFromTurnRef.current = navigateFromTurn;
  const seekInTurn = useCallback((turn: Turn, ms: number) => {
    navigateFromTurnRef.current(turn, { kind: "seek_to", at_ms: ms });
  }, []);

  useEffect(() => {
    // 新一轮出来且用户原本在底部时才跟到底。用户主动翻看旧回答/动作卡后，
    // 工具状态或回执更新不能把视线强行抢回去。
    // 直接写 scrollTop 而不是 scrollTo：后者在 jsdom 里根本不存在，
    // 而这行代码没必要为了一个平滑动画就在测试环境里炸掉。
    const box = scrollRef.current;
    if (box && followScrollRef.current) box.scrollTop = box.scrollHeight;
  }, [turns, busy]);

  // 呼出快捷键。常驻助手只能靠鼠标点那颗球才能打开，等于把它排除在键盘之外；
  // 成熟的助手都有一个随手可按的组合键。
  // 处理函数每次渲染重新绑一遍到 ref 上：监听只挂一次，读到的却始终是最新的位置和状态。
  useEffect(() => {
    toggleRef.current = () => (open ? collapseToNearestSide(true) : openFromDock());
  });

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key !== "j" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return;
      }
      event.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const pendingQuestion = turns.find((turn) => turn.pending)?.question ?? "";
  const persistedDraft =
    recentQuestionIndexRef.current == null ? input : recentQuestionDraftRef.current;
  sessionSnapshotRef.current = { turns, history, draft: persistedDraft || pendingQuestion };
  useEffect(() => {
    const conversationId = activeConversationIdRef.current;
    const snapshot = sessionSnapshotRef.current;
    const hasPendingTurn = turns.some((turn) => turn.pending);
    const requestJustFinished = hadPendingTurnRef.current && !hasPendingTurn;
    hadPendingTurnRef.current = hasPendingTurn;
    clearScheduledPersistence();
    if (requestJustFinished) {
      persistConversationSnapshot(conversationId, snapshot);
      return;
    }
    const timer = window.setTimeout(() => {
      persistConversationSnapshot(conversationId, snapshot);
      if (persistTimerRef.current === timer) persistTimerRef.current = null;
    }, SESSION_PERSIST_DELAY_MS);
    persistTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (persistTimerRef.current === timer) persistTimerRef.current = null;
    };
  }, [clearScheduledPersistence, history, input, persistConversationSnapshot, turns]);

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 96)}px`;
  }, [input, open]);

  useEffect(() => {
    if (!pendingInlineAsk) return;
    const source =
      pendingInlineAsk.startMs == null
        ? ""
        : `（${formatMs(pendingInlineAsk.startMs)}）`;
    const draft = t("assistant.explainTranscript", { source, text: pendingInlineAsk.text });
    recentQuestionIndexRef.current = null;
    setInput((current) =>
      current.trim() ? `${current.trimEnd()}\n\n${draft}` : draft,
    );
    setOpen(true);
    clearInlineAsk();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [clearInlineAsk, pendingInlineAsk, setOpen, t]);

  useEffect(() => {
    if (open || !focusLauncherAfterCloseRef.current) return;
    focusLauncherAfterCloseRef.current = false;
    requestAnimationFrame(() => launcherRef.current?.focus());
  }, [open, focusLauncherAfterCloseRef]);

  // 展开即视为「已读」，清掉球上的完成点。
  useEffect(() => {
    if (open) setHasUnread(false);
  }, [open]);

  // 范围菜单：点菜单外任意处收起。

  // 头部「⋯」菜单：点菜单外任意处收起。
  useEffect(() => {
    if (!headerMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (headerMenuRef.current?.contains(event.target as Node)) return;
      if (headerMenuTriggerRef.current?.contains(event.target as Node)) return;
      setHeaderMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [headerMenuOpen]);

  useEffect(() => {
    if (!open || !mobile) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, mobile]);


  useEffect(() => {
    mountedRef.current = true;
    const locallyStoppedRequests = locallyStoppedRequestsRef.current;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
      if (saveToNotesTimerRef.current != null) window.clearTimeout(saveToNotesTimerRef.current);
      clearScheduledPersistence();
      persistConversationSnapshot(activeConversationIdRef.current, sessionSnapshotRef.current);
      const requestId = activeRequestRef.current;
      if (requestId) {
        locallyStoppedRequests.add(requestId);
        // IPC 会记住早于后端登记的取消，并在 ask 完成登记后补发。
        // 卸载后不能再展示错误，但也不能留下继续计费的无主请求。
        void ipc.assistant.cancel(requestId).catch(() => {});
      }
    };
  }, [clearScheduledPersistence, persistConversationSnapshot]);

  async function send(suggestedQuestion?: string, rememberQuestion = true) {
    const question = (suggestedQuestion ?? input).trim();
    if (!question || busy || activeRequestRef.current || actionExecutionCountRef.current > 0) return;
    // 防御：同一问题不该出现两个「处理中」回合（曾出现过一问题显示两条「正在整理结果」）。
    // 个别触发路径（如 Enter 与发送按钮竞态、重开面板残留）会重复创建 pending 回合，
    // 其中一条收尾、另一条永远卡在整理态。遇到已存在同问题的 pending 回合就不再重复发起。
    if (turns.some((turn) => turn.pending && turn.question === question)) return;
    const conversationId = activeConversationIdRef.current;
    const requestId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const historyAtSend = historyRef.current;
    // 范围选择在发送时定格：这轮「这个视频」指的是谁，就按那个上下文发出去、也按它存下来。
    const askContext = scopedContext(resolvedScope);
    activeRequestRef.current = requestId;
    if (rememberQuestion) {
      recentQuestionsRef.current = appendRecentAssistantQuestion(question);
    }
    // 新问题是用户主动发起的导航点，无论此前停在哪一段，都把它带到最新内容。
    followScrollRef.current = true;
    setScrolledAway(false);
    // 只清从输入框发出的那一条。点建议、点重新回答时用户可能正打着别的字，
    // 不该被顺手抹掉。
    if (suggestedQuestion === undefined) {
      resetRecentQuestionNavigation("");
      setInput("");
    } else {
      resetRecentQuestionNavigation(input);
    }
    setBusy(true);
    setStopping(false);
    setError("");
    setStatusAnnouncement("");
    // 流式片段只做防抖持久化，但请求刚发出时先落一次草稿；即使应用随后退出，
    // 用户的问题也能回到输入框，而不是随着未完成轮次一起丢失。
    const startingSnapshot = { turns, history: historyAtSend, draft: input || question };
    sessionSnapshotRef.current = startingSnapshot;
    persistConversationSnapshot(conversationId, startingSnapshot);
    // 长工具链可能要等几十秒；问题先进入对话，让用户立即确认自己发出了什么。
    if (turns.length + 1 > MAX_RENDERED_TURNS) {
      setHiddenTurnCount((count) => count + (turns.length + 1 - MAX_RENDERED_TURNS));
    }
    setTurns((prev) =>
      [
        ...prev,
        {
          id: turnId,
          question,
          answer: "",
          actions: [],
          tools: [],
          canceled: false,
          actionResults: [],
          pending: true,
          context: { ...askContext },
        },
      ].slice(-MAX_RENDERED_TURNS),
    );
    try {
      const patch = (change: (turn: Turn) => Turn) =>
        setTurns((prev) => prev.map((item) => (item.id === turnId ? change(item) : item)));
      // SSE 常把一个字拆成一个事件。逐片 setState 会让 React 每秒渲染几十次，并反复复制
      // 已有长字符串；先缓冲到下一帧，每帧最多更新一次。
      let streamFrame: number | null = null;
      let clearBufferedAnswer = false;
      let bufferedAnswer: string[] = [];
      let bufferedAnswerChars = 0;
      let bufferedReasoning: string[] = [];
      let bufferedReasoningChars = 0;
      let bufferedTools: string[] = [];
      let hasToolOutcomePhase = false;
      const seenToolCallIds = new Set<string>();
      const finishedToolStatuses = new Map<string, AssistantToolRunStatus>();
      const latestToolIssue: {
        current: { name: string; status: "failed" | "canceled" } | null;
      } = { current: null };
      const flushStream = () => {
        if (streamFrame != null) cancelAnimationFrame(streamFrame);
        streamFrame = null;
        if (!mountedRef.current) return;
        const answerDelta = bufferedAnswer.join("");
        const reasoningDelta = bufferedReasoning.join("");
        const toolsDelta = bufferedTools;
        const shouldClear = clearBufferedAnswer;
        bufferedAnswer = [];
        bufferedAnswerChars = 0;
        bufferedReasoning = [];
        bufferedReasoningChars = 0;
        bufferedTools = [];
        clearBufferedAnswer = false;
        if (!shouldClear && !answerDelta && !reasoningDelta && toolsDelta.length === 0) return;
        patch((item) => ({
          ...item,
          answer: capAssistantText(
            `${shouldClear ? "" : item.answer}${answerDelta}`,
            MAX_ASSISTANT_ANSWER_CHARS,
          ),
          reasoning: reasoningDelta
            ? capAssistantText(
                `${item.reasoning ?? ""}${reasoningDelta}`,
                MAX_ASSISTANT_REASONING_CHARS,
              )
            : item.reasoning,
          tools:
            toolsDelta.length > 0
              ? [...item.tools, ...toolsDelta].slice(-MAX_STREAMED_TOOLS)
              : item.tools,
        }));
      };
      const scheduleStreamFlush = () => {
        if (streamFrame == null) streamFrame = requestAnimationFrame(flushStream);
      };
      const reply = await ipc.assistant.ask(
        question,
        askContext,
        historyAtSend,
        requestId,
        (event) => {
          if (!mountedRef.current || event.type === "started") {
            return;
          } else if (event.type === "turn") {
            clearBufferedAnswer = true;
            bufferedAnswer = [];
            bufferedAnswerChars = 0;
            hasToolOutcomePhase = false;
            patch((item) => ({
              ...item,
              activeTool: undefined,
              toolExecutionStatus: undefined,
              toolExecutionName: undefined,
            }));
            scheduleStreamFlush();
          } else if (event.type === "reasoning") {
            if (hasToolOutcomePhase) {
              hasToolOutcomePhase = false;
              patch((item) => ({
                ...item,
                toolExecutionStatus: undefined,
                toolExecutionName: undefined,
              }));
            }
            bufferedReasoningChars = appendStreamChunk(
              bufferedReasoning,
              bufferedReasoningChars,
              event.delta,
              MAX_ASSISTANT_REASONING_CHARS,
            );
            scheduleStreamFlush();
          } else if (event.type === "token") {
            if (hasToolOutcomePhase) {
              hasToolOutcomePhase = false;
              patch((item) => ({
                ...item,
                toolExecutionStatus: undefined,
                toolExecutionName: undefined,
              }));
            }
            bufferedAnswerChars = appendStreamChunk(
              bufferedAnswer,
              bufferedAnswerChars,
              event.delta,
              MAX_ASSISTANT_ANSWER_CHARS,
            );
            scheduleStreamFlush();
          } else if (event.type === "tool") {
            if (seenToolCallIds.has(event.call_id)) return;
            seenToolCallIds.add(event.call_id);
            bufferedTools = [...bufferedTools, event.name].slice(-MAX_STREAMED_TOOLS);
            hasToolOutcomePhase = false;
            patch((item) => ({
              ...item,
              activeTool: { callId: event.call_id, name: event.name },
              toolExecutionStatus: undefined,
              toolExecutionName: undefined,
              toolRuns: recordToolStarted(item.toolRuns ?? [], event.call_id, event.name),
            }));
            scheduleStreamFlush();
          } else if (event.type === "tool_finished") {
            const toolStatus = normalizeFinishedToolStatus(event.status, event.canceled);
            const previousStatus = finishedToolStatuses.get(event.call_id);
            if (previousStatus && (previousStatus !== "unknown" || toolStatus === "unknown")) {
              return;
            }
            seenToolCallIds.add(event.call_id);
            finishedToolStatuses.set(event.call_id, toolStatus);
            if (toolStatus === "failed" || toolStatus === "canceled") {
              latestToolIssue.current = { name: event.name, status: toolStatus };
            }
            hasToolOutcomePhase = toolStatus === "failed" || toolStatus === "canceled";
            patch((item) => ({
              ...item,
              activeTool:
                item.activeTool?.callId === event.call_id ? undefined : item.activeTool,
              toolExecutionStatus:
                toolStatus === "failed" || toolStatus === "canceled"
                  ? toolStatus
                  : undefined,
              toolExecutionName:
                toolStatus === "failed" || toolStatus === "canceled"
                  ? event.name
                  : undefined,
              toolRuns: recordToolFinished(
                item.toolRuns ?? [],
                event.call_id,
                event.name,
                toolStatus,
              ),
            }));
          } else if (event.type === "turn_limit") {
            // 撞上限到总结完成之间可能还有十几秒，期间没有任何其他事件；
            // 挂出进行中状态，否则用户只看到卡住。
            patch((item) => ({
              ...item,
              turnLimitNoticed: true,
              activeTool: undefined,
              toolExecutionStatus: undefined,
              toolExecutionName: undefined,
            }));
            scheduleStreamFlush();
          }
        },
      );
      if (!mountedRef.current) return;
      flushStream();
      const stopReason = normalizedStopReason(reply);
      const serverCanceled = stopReason === "canceled";
      const locallyStopped = locallyStoppedRequestsRef.current.has(requestId);
      const canceled = serverCanceled || locallyStopped;
      // 后端也会清空取消轮次的动作；这里再守一次，避免旧后端或兼容端点让用户
      // 点停以后仍切主题、导航或冒出待确认操作。
      const actions = canceled ? [] : reply.actions;
      // 请求期间用户仍可能执行旧确认卡。那类结果已经追加进 historyRef，不能被
      // 此次回复的整包 history 覆盖；取消轮次自身则不能进入下一轮上下文。
      const actionEventsDuringRequest = historyRef.current.slice(historyAtSend.length);
      const nextHistory = boundTrustedAssistantHistory([
        ...(canceled ? historyAtSend : reply.history),
        ...actionEventsDuringRequest,
      ]);
      historyRef.current = nextHistory;
      setHistory(nextHistory);
      // 主题当场生效。它无破坏性、一眼可见，再让人点一次只是把一步变两步。
      for (const action of actions) {
        if (action.kind === "set_theme") setThemePref(action.pref);
      }
      setTurns((prev) =>
        prev.map((turn) =>
          turn.id === turnId
            ? {
                ...turn,
                // cancel IPC 与已完成响应赛跑时，旧后端可能仍回 canceled=false。此时整轮
                // history 已被丢弃，回答也不能显示成下一轮模型根本没见过的幽灵上下文。
                answer:
                  locallyStopped && !serverCanceled
                    ? ""
                    : capAssistantText(reply.answer, MAX_ASSISTANT_ANSWER_CHARS),
                actions,
                tools: reply.tools_used.slice(-MAX_STREAMED_TOOLS),
                toolRuns: reconcileAssistantToolRuns(
                  reply.tools_used,
                  turn.toolRuns ?? [],
                  true,
                ),
                canceled,
                // 用户叫停的那一轮已经有自己的说明，再挂一条「没得出结论」是在替它
                // 找借口——它没转不出来，是被你按停的。
                hitTurnLimit: stopReason === "limit_reached" && !canceled,
                usage: reply.usage,
                activeTool: undefined,
                toolExecutionStatus: undefined,
                toolExecutionName: undefined,
                turnLimitNoticed: undefined,
                pending: false,
              }
            : // 收尾兜底：真实回答到达时，把同问题的残留「处理中」回合一并结束。
              // 曾因个别触发路径产生过重复 pending 回合（一个收尾、另一个永远卡在整理态），
              // 这里让迟到完成的回合顺带清理同问的孤儿，杜绝「一问题两条正在整理结果」。
              turn.pending && turn.question === question
              ? { ...turn, pending: false, activeTool: undefined }
              : turn,
        ),
      );
      const finalToolIssue = latestToolIssue.current;
      const issueToolLabel = finalToolIssue
        ? t(`assistantTools.${finalToolIssue.name}`, { defaultValue: finalToolIssue.name })
        : undefined;
      setStatusAnnouncement(
        canceled
          ? t("assistant.generationStopped")
          : finalToolIssue && issueToolLabel
            ? t("assistant.responseCompleteWithToolStatus", {
                tool: issueToolLabel,
                status: t(`assistant.toolRunStatus.${finalToolIssue.status}`),
              })
            : t("assistant.responseComplete"),
      );
      // 收起时跑完的请求在球上留一个「完成点」；用户回来展开后清掉。
      if (!canceled && !useAssistantUi.getState().open) setHasUnread(true);
    } catch (e) {
      if (!mountedRef.current) return;
      // 把问题放回输入框：让用户能直接重发，而不是重新打一遍。
      // 但输入框里已经有东西时不覆盖——那是他趁等待时打的，比这句重发的价值高。
      setTurns((prev) => prev.filter((turn) => turn.id !== turnId));
      setInput((current) => {
        const next = current.trim() ? current : question;
        resetRecentQuestionNavigation(next);
        return next;
      });
      setError(humanizeError(e));
      setStatusAnnouncement("");
      if (!useAssistantUi.getState().open) setHasUnread(true);
    } finally {
      locallyStoppedRequestsRef.current.delete(requestId);
      if (activeRequestRef.current === requestId) {
        activeRequestRef.current = null;
        if (mountedRef.current) {
          setBusy(false);
          setStopping(false);
        }
      }
    }
  }

  async function copyAnswer(turn: Turn) {
    if (!turn.answer || !navigator.clipboard?.writeText) {
      setError(t("assistant.clipboardUnavailable"));
      return;
    }
    try {
      await navigator.clipboard.writeText(turn.answer);
      setCopiedTurnId(turn.id);
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedTurnId(null), 1500);
    } catch (e) {
      setError(t("assistant.copyFailed", { error: humanizeError(e) }));
    }
  }

  /** 把一条回答追加进当前视频的笔记（Tiptap 文档）。 */
  async function saveToNotes(turn: Turn) {
    const videoId = turn.context?.video_id ?? context.video_id;
    if (!videoId) {
      setError(t("assistant.notesNeedVideo"));
      return;
    }
    try {
      await notesCoordinator.appendAnswer(videoId, turn.answer);
      void queryClient.invalidateQueries({ queryKey: qk.artifact("notes", videoId) });
      setSavedToNotesTurnId(turn.id);
      if (saveToNotesTimerRef.current != null) window.clearTimeout(saveToNotesTimerRef.current);
      saveToNotesTimerRef.current = window.setTimeout(() => setSavedToNotesTurnId(null), 1500);
    } catch (e) {
      setError(humanizeError(e));
    }
  }

  /**
   * 同一个问题再问一遍。
   *
   * 关键是**先把上下文退回提问之前**，否则模型看得见自己刚才那次回答，「重新生成」就变成了
   * 「顺着刚才继续说」——而用户点它，恰恰是因为刚才那次不满意。
   *
   * 被停掉的那一轮是个例外：它整轮都没进上下文（后端返回的 history 被丢弃了），
   * 现在的 history 已经就是提问之前的样子，再退一轮会把上一次真正的问答也砍掉。
   */
  function regenerate(turn: Turn) {
    if (busy || activeRequestRef.current || actionExecutionCountRef.current > 0) return;
    const before = turn.canceled
      ? historyRef.current
      : historyBeforeLastQuestion(historyRef.current);
    historyRef.current = before;
    setHistory(before);
    setTurns((previous) => previous.filter((item) => item.id !== turn.id));
    void send(turn.question, false);
  }

  function jumpToLatest() {
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
    followScrollRef.current = true;
    setScrolledAway(false);
  }

  async function stop() {
    const requestId = activeRequestRef.current;
    if (!requestId || stopping) return;
    // 先记下用户意图，再发取消 IPC。即便 ask 与 cancel 同时完成，也绝不能执行
    // 用户已经叫停的主题、导航或写操作提案。
    locallyStoppedRequestsRef.current.add(requestId);
    setStopping(true);
    setError("");
    try {
      await ipc.assistant.cancel(requestId);
    } catch (e) {
      setStopping(false);
      setError(humanizeError(e));
    }
  }

  function activateConversation(
    conversationId: string,
    nextState: AssistantConversationsState,
    session: AssistantSession,
  ) {
    const nextEpoch = conversationEpochRef.current + 1;
    activeConversationIdRef.current = conversationId;
    conversationEpochRef.current = nextEpoch;
    setConversationEpoch(nextEpoch);
    setConversationState(nextState);
    setTurns(session.turns);
    historyRef.current = session.history;
    setHistory(session.history);
    sessionSnapshotRef.current = session;
    hadPendingTurnRef.current = false;
    setInput(session.draft);
    resetRecentQuestionNavigation(session.draft);
    setError("");
    setStatusAnnouncement("");
    setCopiedTurnId(null);
    setSavedToNotesTurnId(null);
    setHiddenTurnCount(0);
    setRenamingId(null);
    setRenameDraft("");
    setBusy(false);
    setStopping(false);
    actionExecutionCountRef.current = 0;
    setActionExecutionCount(0);
    followScrollRef.current = true;
    setScrolledAway(false);
    setHistoryOpen(false);
    writeAssistantSession(session);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function switchConversation(conversationId: string) {
    if (busy || activeRequestRef.current || actionExecutionCountRef.current > 0) return;
    if (conversationId === activeConversationIdRef.current) {
      setHistoryOpen(false);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    clearScheduledPersistence();
    if (!persistConversationSnapshot(activeConversationIdRef.current, sessionSnapshotRef.current)) {
      setError(t("assistant.conversationSaveFailed"));
      setHistoryOpen(false);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    const target = readAssistantConversation(conversationId);
    if (!target) return;
    const activated = trySetActiveAssistantConversation(conversationId);
    if (!activated.persisted) {
      setError(t("assistant.conversationSaveFailed"));
      setHistoryOpen(false);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    activateConversation(conversationId, activated.state, target.session);
  }

  function startNewConversation() {
    if (busy || activeRequestRef.current || actionExecutionCountRef.current > 0) return;
    clearScheduledPersistence();
    if (
      activeConversationIdRef.current &&
      !persistConversationSnapshot(activeConversationIdRef.current, sessionSnapshotRef.current)
    ) {
      setError(t("assistant.conversationSaveFailed"));
      return;
    }
    const created = tryCreateAssistantConversation();
    if (!created.persisted || !created.createdId) {
      setHistoryOpen(false);
      setError(
        created.status === "limit"
          ? t("assistant.conversationLimitReached", { count: MAX_ASSISTANT_CONVERSATIONS })
          : t("assistant.conversationSaveFailed"),
      );
      return;
    }
    activateConversation(created.createdId, created.state, EMPTY_ASSISTANT_SESSION);
  }

  function focusConversationControl(
    conversationId: string,
    controls: RefObject<Map<string, HTMLButtonElement>>,
  ) {
    requestAnimationFrame(() => controls.current.get(conversationId)?.focus());
  }

  function cancelConversationRename(conversationId: string) {
    setRenamingId(null);
    setRenameDraft("");
    focusConversationControl(conversationId, renameButtonRefs);
  }

  function submitConversationRename(conversationId: string) {
    const title = renameDraft.trim();
    if (!title) {
      cancelConversationRename(conversationId);
      return;
    }
    const renamed = tryRenameAssistantConversation(conversationId, title);
    if (!renamed.persisted) {
      setError(t("assistant.conversationHistorySaveFailed"));
      return;
    }
    setConversationState(renamed.state);
    setError("");
    setStatusAnnouncement(t("assistant.conversationRenamed", { title }));
    setRenamingId(null);
    setRenameDraft("");
    focusConversationControl(conversationId, conversationButtonRefs);
  }

  async function removeConversation(conversationId: string) {
    if (
      busy ||
      activeRequestRef.current ||
      actionExecutionCountRef.current > 0 ||
      deletingConversationIdRef.current
    ) {
      return;
    }
    const conversation = conversationState.conversations.find(({ id }) => id === conversationId);
    if (!conversation) return;
    const title = conversation.title || t("assistant.untitledConversation");
    const index = conversationState.conversations.findIndex(({ id }) => id === conversationId);
    const focusAfterDeleteId =
      conversationState.conversations[index + 1]?.id ??
      conversationState.conversations[index - 1]?.id ??
      null;
    let restoreDeleteFocus = true;
    deletingConversationIdRef.current = conversationId;
    setDeletingConversationId(conversationId);
    setError("");
    setStatusAnnouncement("");
    try {
      const confirmed = await confirmDialog(
        t("assistant.deleteConversationConfirm", { title }),
        {
          title: t("assistant.deleteConversationTitle"),
          kind: "warning",
          okLabel: t("assistant.deleteConversationAction"),
          cancelLabel: t("assistant.deleteConversationCancel"),
        },
      );
      if (!confirmed) return;

      const deleted = tryDeleteAssistantConversation(conversationId);
      if (!deleted.persisted) {
        setError(t("assistant.conversationHistorySaveFailed"));
        return;
      }

      const announcement = t("assistant.conversationDeleted", { title });
      if (conversationId === activeConversationIdRef.current && deleted.state.activeId) {
        const target = readAssistantConversation(deleted.state.activeId);
        if (!target) {
          setConversationState(deleted.state);
          setError(t("assistant.conversationHistorySaveFailed"));
          return;
        }
        restoreDeleteFocus = false;
        activateConversation(deleted.state.activeId, deleted.state, target.session);
        setStatusAnnouncement(announcement);
        return;
      }

      restoreDeleteFocus = false;
      setConversationState(deleted.state);
      setStatusAnnouncement(announcement);
      const nextFocusId = focusAfterDeleteId ?? deleted.state.activeId;
      if (nextFocusId) focusConversationControl(nextFocusId, conversationButtonRefs);
    } catch (cause) {
      setError(t("assistant.deleteConversationFailed", { error: humanizeError(cause) }));
    } finally {
      deletingConversationIdRef.current = null;
      setDeletingConversationId(null);
      if (restoreDeleteFocus) pendingDeleteFocusRef.current = conversationId;
    }
  }

  // 工作台隐藏主导航后，面板自己的右下角操作仍占用一条触控操作轨道。
  // 助手入口必须停在这条轨道上方，不能与生成/导出按钮争抢同一组像素。
  const launcherInWorkbench = mobile && !bottomNavigationVisible;
  const launcherBottom = bottomNavigationVisible
    ? "calc(56px + env(safe-area-inset-bottom, 0px) + 24px)"
    : launcherInWorkbench
      ? "calc(env(safe-area-inset-bottom, 0px) + 88px)"
      : "calc(env(safe-area-inset-bottom, 0px) + 24px)";
  // 桌面端只有浮动一种形态：覆盖在内容上、可拖动，不挤占播放器与学习面板的空间。
  const panelShown = open;
  const shell = mobile
    ? "fixed inset-x-0 z-[47] h-[70dvh] max-h-[calc(100dvh-56px)] rounded-t-2xl border-t"
    : "fixed z-40 h-[min(720px,calc(100dvh-2rem))] max-w-[calc(100vw-2rem)] rounded-2xl border";
  const panelBottom = bottomNavigationVisible
    ? "calc(56px + env(safe-area-inset-bottom, 0px))"
    : "env(safe-area-inset-bottom, 0px)";

  return (
    <>
      {!panelShown && launcherVisible && (
      <button
        ref={launcherRef}
        type="button"
        aria-label={t("assistant.openAssistant")}
        aria-busy={busy || undefined}
        title={t("assistant.openWithShortcut", { shortcut: toggleShortcutLabel() })}
        data-dock-side={mobile ? undefined : side}
        onClick={() => {
          if (suppressLauncherClickRef.current) {
            // 用掉就清：这一下是拖动的尾巴，后面那次才是真点击。
            suppressLauncherClickRef.current = false;
            return;
          }
          openFromDock();
        }}
        onPointerDown={mobile ? undefined : beginDockDrag}
        style={
          mobile
            ? { bottom: launcherBottom }
            : launcherPosition
              ? { left: launcherPosition.x, top: launcherPosition.y }
              : { top: dockTop }
        }
        // 底色用 surface-panel 而不是 surface-card：深色主题下 card 是一层 3.5% 的白，
        // 它是给「铺在某块不透明面板上的卡片」用的。球和面板都浮在整个应用之上，
        // 底下没有那层不透明的东西——直接用就成了一块透明玻璃，字浮在页面内容上。
        // hover 同理不能换成 card-hover（7% 的白），一悬停球就没了。
        className={
          mobile
            ? `ca-touch-44 fixed right-4 z-40 grid h-12 w-12 place-items-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-panel)] shadow-[var(--shadow-pop)] transition-colors hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] motion-reduce:transition-none ${launcherInWorkbench ? "ca-workbench-assistant-launcher" : ""}`
            : `ca-touch-44 fixed z-40 grid h-14 w-14 touch-none select-none cursor-grab active:cursor-grabbing place-items-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-panel)] shadow-[var(--shadow-pop)] transition hover:scale-105 hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] motion-reduce:transition-none motion-reduce:hover:scale-100 ${
                launcherPosition ? "" : side === "left" ? "left-3" : "right-3"
              }`
        }
      >
        {busy ? (
          <LoaderCircle className="h-5 w-5 animate-spin text-[var(--accent-text)]" aria-hidden="true" />
        ) : (
          <Sparkles className="h-5 w-5 text-[var(--accent-text)]" aria-hidden="true" />
        )}
        {hasUnread && !busy && (
          <span
            aria-hidden="true"
            className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface-panel)] bg-[var(--accent)]"
          />
        )}
      </button>
      )}
      {open && mobile && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("assistant.closeAssistant")}
          onClick={() => collapseToNearestSide(true)}
          className="fixed inset-0 z-[46] cursor-default bg-black/20 motion-reduce:transition-none"
        />
      )}
    <aside
      ref={panelRef}
      aria-labelledby="assistant-panel-title"
      aria-modal={mobile ? true : undefined}
      role={mobile ? "dialog" : "complementary"}
      hidden={!panelShown}
      onKeyDown={(event) => {
        if (event.key === "Tab" && mobile) {
          const focusable = focusableElements(event.currentTarget);
          if (focusable.length === 0) {
            event.preventDefault();
            return;
          }
          const current = document.activeElement as HTMLElement | null;
          const currentIndex = current ? focusable.indexOf(current) : -1;
          const nextIndex = event.shiftKey
            ? currentIndex <= 0
              ? focusable.length - 1
              : currentIndex - 1
            : currentIndex === focusable.length - 1
              ? 0
              : currentIndex + 1;
          event.preventDefault();
          focusable[nextIndex]?.focus();
          return;
        }
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        // 范围菜单的 Escape 由 AssistantComposer 自行处理并拦截。
        if (headerMenuOpen) {
          setHeaderMenuOpen(false);
          requestAnimationFrame(() => headerMenuTriggerRef.current?.focus());
          return;
        }
        if (historyOpen) {
          setHistoryOpen(false);
          setRenamingId(null);
          setRenameDraft("");
          requestAnimationFrame(() => historyButtonRef.current?.focus());
          return;
        }
        collapseToNearestSide(true);
      }}
      data-dragging={mobile ? undefined : dragging}
      data-snap-side={mobile ? undefined : snapSide ?? undefined}
      style={
        mobile
          ? { bottom: panelBottom, transform: sheetDragY != null ? `translateY(${sheetDragY}px)` : undefined }
          : { left: position.x, top: position.y, width: panelWidth }
      }
      className={`${panelShown ? "flex" : "hidden"} ${shell} flex-col border-[var(--border-subtle)] bg-[var(--surface-panel)] shadow-[var(--shadow-pop)] ${
        snapSide ? "ring-2 ring-[var(--accent)]" : ""
      } ${sheetDragY != null ? "transition-none" : ""}`}
    >
      {mobile && (
        <div
          className="flex flex-none justify-center pb-1 pt-2"
          onPointerDown={beginSheetCloseDrag}
        >
          <span className="h-1 w-10 rounded-full bg-[var(--border-control)]" aria-hidden="true" />
        </div>
      )}
      {/* 朝向屏幕内侧的那条边是宽度抓手。固定宽度对一段带列表和公式的长回答太窄了。
          抓取区全高、骑在边框上（内外各 6px），不占内容宽度；可见反馈就是面板那条边本身：
          指示层与面板外框重合、同半径圆角，悬停/拖动/聚焦时整条边连同上下圆角一起点亮。 */}
      {!mobile && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("assistant.adjustWidth")}
          aria-valuenow={panelWidth}
          aria-valuemin={MIN_PANEL_WIDTH}
          aria-valuemax={MAX_PANEL_WIDTH}
          tabIndex={0}
          onPointerDown={beginResize}
          onKeyDown={resizeWithKeyboard}
          data-resizing={panelWidth !== width || undefined}
          className={`group absolute inset-y-0 z-10 w-3 cursor-col-resize touch-none focus-visible:outline-none ${
            side === "right" ? "-left-[6px]" : "-right-[6px]"
          }`}
        >
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute -inset-y-px w-4 border-transparent transition-colors motion-reduce:transition-none group-hover:border-[var(--accent)] group-focus-visible:border-[var(--focus-ring)] group-data-[resizing]:border-[var(--accent)] ${
              side === "right"
                ? "left-[5px] rounded-l-2xl border-l-2"
                : "right-[5px] rounded-r-2xl border-r-2"
            }`}
          />
        </div>
      )}
      <header className="flex items-center gap-1 border-b border-[var(--border-subtle)] px-3 py-2">
        {/* 提问范围原先挤在标题旁边，11px 一行灰字。它决定了「这个视频」指的是谁，
            该待在你打字的地方，而不是滚动区顶上那条最容易被忽略的边。 */}
        {mobile ? (
          <>
            <Sparkles className="h-4 w-4 flex-none text-[var(--accent-text)]" />
            <span
              id="assistant-panel-title"
              className="min-w-0 flex-1 text-sm font-medium text-[var(--text-strong)]"
            >
              {t("assistant.title")}
            </span>
          </>
        ) : (
          <button
            type="button"
            aria-label={t("assistant.dragPanel")}
            title={t("assistant.dragPanel")}
            onPointerDown={beginPanelDrag}
            onKeyDown={movePanelWithKeyboard}
            className="-ml-1 flex min-w-0 flex-1 touch-none select-none items-center gap-1.5 rounded-md px-1 py-1 text-left cursor-grab active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <GripHorizontal className="h-4 w-4 flex-none text-[var(--text-faint)]" />
            <Sparkles className="h-4 w-4 flex-none text-[var(--accent-text)]" />
            <span
              id="assistant-panel-title"
              className="min-w-0 flex-1 text-sm font-medium text-[var(--text-strong)]"
            >
              {t("assistant.title")}
            </span>
          </button>
        )}
        {(conversationState.conversations.length > 1 || turns.length > 0 || history.length > 0) && (
          <Button
            ref={historyButtonRef}
            size="icon"
            variant="ghost"
            aria-label={
              historyOpen
                ? t("assistant.closeConversationHistory")
                : t("assistant.conversationHistory")
            }
            title={
              historyOpen
                ? t("assistant.closeConversationHistory")
                : t("assistant.conversationHistory")
            }
            aria-expanded={historyOpen}
            aria-controls="assistant-conversation-history"
            disabled={busy || actionExecutionBusy || conversationMutationBusy}
            onClick={() => {
              if (historyOpen) {
                setRenamingId(null);
                setRenameDraft("");
                setHistoryOpen(false);
                return;
              }
              setError("");
              setStatusAnnouncement("");
              setHistoryOpen(true);
            }}
            className="ca-touch-44"
          >
            <HistoryIcon className="h-4 w-4" />
          </Button>
        )}
        {(turns.length > 0 || history.length > 0) && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("assistant.newChat")}
            title={t("assistant.newChat")}
            disabled={busy || actionExecutionBusy || conversationMutationBusy}
            onClick={startNewConversation}
            className="ca-touch-44"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
        )}
        {/* 换边是一辈子用不了几次的一次性设置，收进「⋯」；
            常驻按钮只留高频的：历史、新会话、关闭。 */}
        {!mobile && (
          <div
            ref={headerMenuRef}
            className="relative"
          >
            <Button
              ref={headerMenuTriggerRef}
              size="icon"
              variant="ghost"
              aria-label={t("assistant.headerMenu")}
              aria-haspopup="menu"
              aria-expanded={headerMenuOpen}
              title={t("assistant.headerMenu")}
              onClick={() => setHeaderMenuOpen((value) => !value)}
              className="ca-touch-44"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
            {headerMenuOpen && (
              <Menu
                aria-label={t("assistant.headerMenu")}
                onClose={() => {
                  setHeaderMenuOpen(false);
                  requestAnimationFrame(() => headerMenuTriggerRef.current?.focus());
                }}
                className="absolute right-0 top-full z-30 mt-1"
              >
                <MenuItem
                  className="flex items-center gap-2"
                  onClick={() => {
                    movePanelToSide(side === "left" ? "right" : "left");
                    setHeaderMenuOpen(false);
                    requestAnimationFrame(() => headerMenuTriggerRef.current?.focus());
                  }}
                >
                  {side === "left" ? (
                    <ChevronRight className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronLeft className="h-3.5 w-3.5" />
                  )}
                  {side === "left" ? t("assistant.dockRight") : t("assistant.dockLeft")}
                </MenuItem>
              </Menu>
            )}
          </div>
        )}
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("assistant.collapseAssistant")}
          title={t("assistant.collapseWithShortcut", { shortcut: toggleShortcutLabel() })}
          onClick={() => collapseToNearestSide(true)}
          className="ca-touch-44"
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
      {historyOpen ? (
        <ConversationHistory
          conversations={conversationState}
          error={error}
          statusAnnouncement={statusAnnouncement}
          busy={busy}
          actionExecutionBusy={actionExecutionBusy}
          conversationMutationBusy={conversationMutationBusy}
          renamingId={renamingId}
          renameDraft={renameDraft}
          deletingConversationId={deletingConversationId}
          conversationButtonRefs={conversationButtonRefs}
          renameButtonRefs={renameButtonRefs}
          deleteButtonRefs={deleteButtonRefs}
          onSwitch={switchConversation}
          onStartRename={(id, title) => {
            setError("");
            setStatusAnnouncement("");
            setRenamingId(id);
            setRenameDraft(title);
          }}
          onRenameDraftChange={setRenameDraft}
          onSubmitRename={submitConversationRename}
          onCancelRename={cancelConversationRename}
          onRemove={(id) => void removeConversation(id)}
        />
      ) : (
      <>
      <div
        ref={scrollRef}
        role="log"
        aria-live="off"
        aria-relevant="additions"
        aria-busy={busy}
        onScroll={() => {
          const box = scrollRef.current;
          if (!box) return;
          const atEnd = isNearScrollEnd(box);
          followScrollRef.current = atEnd;
          setScrolledAway(!atEnd);
        }}
        className="flex-1 space-y-4 overflow-y-auto px-3 py-3"
      >
        {turns.length === 0 && !busy && !error && (
          <AssistantEmptyState
            scopeLabel={scopeLabel}
            context={resolvedContext}
            actionExecutionBusy={actionExecutionBusy}
            onSend={(prompt) => void send(prompt)}
          />
        )}
        {hiddenTurnCount > 0 && (
          <p className="text-center ca-t-2xs text-[var(--text-faint)]">
            {t("assistant.hiddenTurns", { count: hiddenTurnCount })}
          </p>
        )}
        {turns.map((turn) => (
          <div key={turn.id} className="ca-msg-in space-y-2">
            <AssistantTurn
              turn={turn}
              isLast={turn.id === turns[turns.length - 1]?.id}
              isPendingTurn={turn.id === pendingTurn?.id}
              mobile={mobile}
              busy={busy}
              actionExecutionBusy={actionExecutionBusy}
              hasVideoContext={Boolean(turn.context?.video_id ?? context.video_id)}
              copied={copiedTurnId === turn.id}
              savedToNotes={savedToNotesTurnId === turn.id}
              onCopy={(item) => void copyAnswer(item)}
              onSaveToNotes={(item) => void saveToNotes(item)}
              onRegenerate={regenerate}
              onSeek={seekInTurn}
              onNavigate={navigateFromTurn}
              onOutcome={(id, outcome) => commitActionOutcome(id, outcome, conversationEpoch)}
              onExecutionStart={(id, actions) => beginActionExecution(id, actions, conversationEpoch)}
              onExecutionEnd={endActionExecution}
              onApplied={onActionApplied}
            />
          </div>
        ))}
        {error && (
          <div
            role="alert"
            className="border-l-2 border-[var(--status-err)] pl-2 text-xs text-[var(--status-err)]"
          >
            <span>{error}</span>
          </div>
        )}
      </div>

      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {statusAnnouncement}
      </div>

      {/* 翻上去看旧回答时，新回答落在屏幕外，原来没有任何提示，也没有回来的路——
          只能自己往下拖。给一个浮在滚动区底部的按钮。 */}
      {scrolledAway && turns.length > 0 && <JumpToLatest onClick={jumpToLatest} />}
      </>
      )}
      </div>

      {/* 输入框、范围提示和按钮合成一块。整个面板只保留外框一条线：
          composer 自身的描边就是与消息区的分界，不再叠一条 border-t。 */}
      {!historyOpen && (
        <AssistantComposer
          inputRef={inputRef}
          input={input}
          onInput={setInputFromUser}
          onKeyDown={(event) => {
            if (navigateRecentQuestions(event)) return;
            // Enter 发送、Shift+Enter 换行。输入法组词时的 Enter 不能当发送，
            // 否则中文用户每选一次候选词就误发一条。
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          busy={busy}
          stopping={stopping}
          actionExecutionBusy={actionExecutionBusy}
          onSend={() => void send()}
          onStop={stop}
          scopeLabel={scopeLabel}
          scopeOptions={scopeOptions}
          scopeChoice={scopeChoice}
          onScopeChoice={setScopeChoice}
        />
      )}
    </aside>
    </>
  );
}
