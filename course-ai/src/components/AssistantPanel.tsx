import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useQueryClient } from "@tanstack/react-query";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  ArrowDown,
  ArrowUpRight,
  AtSign,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  GripHorizontal,
  History as HistoryIcon,
  LoaderCircle,
  MessageSquarePlus,
  Move,
  PanelLeft,
  PenLine,
  RefreshCw,
  Save,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AssistantActionList,
  type AssistantActionOutcome,
} from "@/components/AssistantActionCard";
import { AssistantToolChips } from "@/components/AssistantToolChips";
import {
  boundTrustedAssistantHistory,
  capAssistantText,
  getAssistantInteractionState,
  historyBeforeLastQuestion,
  MAX_ASSISTANT_ANSWER_CHARS,
  MAX_ASSISTANT_REASONING_CHARS,
  MAX_ASSISTANT_TURNS,
  reconcileAssistantToolRuns,
  writeAssistantSession,
  type AssistantSession,
  type AssistantCheckpoint,
  type AssistantCheckpointActionKind,
  type AssistantToolRun,
  type AssistantToolRunStatus,
  type AssistantTurnRecord,
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
  clampPanelWidth,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  type DockSide,
  useAssistantUi,
} from "@/stores/assistant";
import { useInlineAsk } from "@/stores/inlineAsk";
import { useTheme } from "@/stores/theme";
import { renderMarkdown } from "@/lib/renderMarkdown";
import type {
  AgentStopReason,
  AssistantAction,
  AssistantContext,
  AssistantMessage,
  AssistantReply,
  AssistantUsage,
  ToolExecutionStatus,
} from "@/lib/types";

/**
 * 常驻的全局助手面板。
 *
 * 桌面端可拖动，移到左右边缘时吸附成窄条；手机端没有「边缘停靠」的余地，
 * 改成底部抽屉——两种外壳共用同一套状态和消息流，切换的只是容器。
 */

/** 一次完整回答实际消耗的 token 数：输入 + 正式输出 + 推理模型的思考输出。 */
function usageTokens(usage: AssistantUsage): number {
  return usage.prompt_tokens + usage.completion_tokens + usage.reasoning_tokens;
}

const PANEL_MAX_HEIGHT = 720;
const VIEWPORT_GAP = 16;
const EDGE_SNAP_DISTANCE = 28;
const SCROLL_FOLLOW_THRESHOLD = 32;
const SESSION_PERSIST_DELAY_MS = 250;
// 只让用户操作确定能写进会话快照的轮次；否则第 21-50 轮的旧确认卡仍可见，
// 但 serializer 会裁掉它的 executing checkpoint。
const MAX_RENDERED_TURNS = MAX_ASSISTANT_TURNS;
const MAX_STREAMED_TOOLS = 50;
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])';
/// 收起时那颗球的直径。停靠位置的夹取与展开/收起时的居中都按它算，
/// 改了尺寸这些数会自动跟上。
const LAUNCHER_SIZE = 56;
/// 球贴边时离边框的距离，与它的 left-3 / right-3 一致——拖动时按同一个数夹取，
/// 松手贴回去才不会横着弹一下。
const LAUNCHER_MARGIN = 12;
const KEYBOARD_MOVE_STEP = 24;
const KEYBOARD_RESIZE_STEP = 32;

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
const DRAG_START_DISTANCE = 4;

interface PanelPosition {
  x: number;
  y: number;
}

interface DragSession {
  source: "panel" | "dock";
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  /** 被拖对象的尺寸：面板拖的是面板，球拖的是球。 */
  width: number;
  height: number;
  moved: boolean;
  position: PanelPosition;
  snapSide: DockSide | null;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function viewportSize() {
  if (typeof window === "undefined") return { width: 1024, height: 768 };
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * 面板还没排版时的估算尺寸。宽度直接从 store 读当前值而不是收参数：这些估算会在
 * 窗口 resize 之类的长期监听里被调用，收参数的话闭包会把某一次渲染时的宽度冻在里面，
 * 用户拉宽面板之后那些监听还按旧宽度算。
 */
function fallbackPanelSize() {
  const viewport = viewportSize();
  return {
    width: Math.min(
      useAssistantUi.getState().width,
      Math.max(0, viewport.width - VIEWPORT_GAP * 2),
    ),
    height: Math.min(PANEL_MAX_HEIGHT, Math.max(0, viewport.height - VIEWPORT_GAP * 2)),
  };
}

function initialPanelPosition(side: DockSide): PanelPosition {
  const viewport = viewportSize();
  const panel = fallbackPanelSize();
  return {
    x: side === "left" ? VIEWPORT_GAP : viewport.width - panel.width - VIEWPORT_GAP,
    y: VIEWPORT_GAP,
  };
}

/** 呼出快捷键的显示写法。Mac 用 ⌘，其余平台用 Ctrl。 */
function toggleShortcutLabel() {
  if (typeof navigator === "undefined") return "Ctrl+J";
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "⌘J" : "Ctrl+J";
}

function initialDockTop() {
  const { height } = viewportSize();
  return Math.max(VIEWPORT_GAP, height - LAUNCHER_SIZE - 24);
}

type Turn = AssistantTurnRecord & {
  /** 只存在于当前流式请求中；完成后不落入会话存储。 */
  activeTool?: { callId: string; name: string };
  /** 最近一次工具结束状态；只用于当前请求的阶段反馈。 */
  toolExecutionStatus?: ToolExecutionStatus;
  toolExecutionName?: string;
  /** 工具链已撞上限、正在强制总结；只用于当前请求的阶段反馈。 */
  turnLimitNoticed?: boolean;
};

/** 提问范围的用户选择。auto 跟随界面当前选中项，其余三档显式覆盖。 */
type ScopeChoice = "auto" | "video" | "course" | "all";

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

function formatConversationTime(updatedAt: number, locale: string) {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(updatedAt));
  } catch {
    return "";
  }
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

const CHECKPOINT_ACTION_LABEL_KEYS: Record<AssistantCheckpointActionKind, string> = {
  open_video: "assistantTools.open_video",
  seek_to: "assistantTools.seek_to",
  propose_rename: "assistantActions.renameTitle",
  propose_delete: "assistantActions.deleteTitle",
  propose_setting: "assistantActions.settingTitle",
  propose_import: "assistantActions.importTitle",
  propose_create_course: "assistantActions.createTitle",
  propose_rename_course: "assistantActions.courseRenameTitle",
};

function checkpointSummary(checkpoint: AssistantCheckpoint, t: TFunction) {
  const visible = checkpoint.targets.slice(0, 3).map((target) => {
    const action = t(CHECKPOINT_ACTION_LABEL_KEYS[target.action], {
      defaultValue: target.action,
    });
    const subject =
      target.label && target.courseLabel
        ? t("assistant.checkpointTargetCourse", {
            target: target.label,
            course: target.courseLabel,
          })
        : target.label ?? target.courseLabel;
    return subject ? t("assistant.checkpointTarget", { action, target: subject }) : action;
  });
  const hidden = checkpoint.targets.length - visible.length;
  return t("assistant.checkpointSummary", {
    targets: visible.join(t("assistant.checkpointSeparator")),
    more: hidden > 0 ? t("assistant.checkpointMore", { count: hidden }) : "",
  });
}

function suggestionsFor(context: AssistantContext, t: TFunction) {
  if (context.video_id) {
    return [
      {
        label: t("assistant.suggestSummarizeVideo"),
        prompt: t("assistant.suggestSummarizeVideoPrompt"),
      },
      {
        label: t("assistant.suggestFindExamples"),
        prompt: t("assistant.suggestFindExamplesPrompt"),
      },
      {
        label: t("assistant.suggestKeyPoints"),
        prompt: t("assistant.suggestKeyPointsPrompt"),
      },
    ];
  }
  if (context.course_id) {
    return [
      {
        label: t("assistant.suggestOverviewCourse"),
        prompt: t("assistant.suggestOverviewCoursePrompt"),
      },
      {
        label: t("assistant.suggestVideoList"),
        prompt: t("assistant.suggestVideoListPrompt"),
      },
      {
        label: t("assistant.suggestCourseKeyPoints"),
        prompt: t("assistant.suggestCourseKeyPointsPrompt"),
      },
    ];
  }
  return [
    { label: t("assistant.suggestMyCourses"), prompt: t("assistant.suggestMyCoursesPrompt") },
    {
      label: t("assistant.suggestPlanStudy"),
      prompt: t("assistant.suggestPlanStudyPrompt"),
    },
    { label: t("assistant.suggestDarkMode"), prompt: t("assistant.suggestDarkModePrompt") },
  ];
}

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
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { open, side, width, mode, setOpen, dock, setWidth, setMode } = useAssistantUi();
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
  const dragRef = useRef<DragSession | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const suppressLauncherClickRef = useRef(false);
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
  const focusLauncherAfterCloseRef = useRef(false);
  // iPad 宽屏有足够空间使用可拖动面板；真正决定布局的是视口档位，不是触屏 UA。
  const mobile = compact || (isMobile() && !isTablet());
  const [position, setPosition] = useState<PanelPosition>(() => initialPanelPosition(side));
  const [dockTop, setDockTop] = useState(initialDockTop);
  /** 拖动中球的落点；不在拖动时为 null，球回到 left-3 / right-3 + dockTop 的贴边位置。 */
  const [launcherPosition, setLauncherPosition] = useState<PanelPosition | null>(null);
  const [dragging, setDragging] = useState(false);
  const [snapSide, setSnapSide] = useState<DockSide | null>(null);
  /** 用户翻上去看旧消息了吗。翻上去了就给一个「回到最新」的按钮，不然新回答落在屏幕外没人知道。 */
  const [scrolledAway, setScrolledAway] = useState(false);
  /** 拖动内侧边框时的实时宽度。松手才写进偏好，免得一次拖动往磁盘上写几十遍。 */
  const [resizeWidth, setResizeWidth] = useState<number | null>(null);
  /** 收起后又有新回答落下、用户还没回来看过。给球挂一个「完成点」。 */
  const [hasUnread, setHasUnread] = useState(false);
  /** 刚保存到笔记的那条回答，短暂显示对勾反馈。 */
  const [savedToNotesTurnId, setSavedToNotesTurnId] = useState<string | null>(null);
  /** 被 MAX_RENDERED_TURNS 截掉、不再显示在列表里的更早轮次数量。 */
  const [hiddenTurnCount, setHiddenTurnCount] = useState(0);
  /** 用户显式选择的提问范围；auto 跟随当前选中项。 */
  const [scopeChoice, setScopeChoice] = useState<ScopeChoice>("auto");
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const scopeMenuId = `assistant-scope-menu-${useId()}`;
  /** 正在重命名的会话 id 与其输入草稿。 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  /** 移动抽屉下滑关闭手势的实时位移；null 表示未在拖拽。 */
  const [sheetDragY, setSheetDragY] = useState<number | null>(null);
  const toggleRef = useRef(() => {});
  const navigateFromTurnRef = useRef<(turn: Turn, action: AssistantAction) => void>(() => {});
  const scopeMenuRef = useRef<HTMLDivElement>(null);
  const scopeTriggerRef = useRef<HTMLButtonElement>(null);
  const scopeItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const conversationButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const renameButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const deleteButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const panelWidth = resizeWidth ?? width;

  // 「现在在干什么」跟着流走：工具执行优先于此前已经吐出的思考或过场正文。
  const pendingTurn = turns.find((turn) => turn.pending);
  function streamingLabelFor(turn: Turn) {
    const activeToolLabel = turn.activeTool
      ? t(`assistantTools.${turn.activeTool.name}`, { defaultValue: turn.activeTool.name })
      : null;
    const finishedToolLabel = turn.toolExecutionName
      ? t(`assistantTools.${turn.toolExecutionName}`, { defaultValue: turn.toolExecutionName })
      : null;
    return activeToolLabel
      ? t("assistant.usingTool", { tool: activeToolLabel })
      : turn.turnLimitNoticed
        ? t("assistant.turnLimitSummarizing")
        : turn.toolExecutionStatus === "failed"
        ? t("assistant.toolFailedContinuing", { tool: finishedToolLabel })
        : turn.toolExecutionStatus === "canceled"
          ? t("assistant.toolCanceled", { tool: finishedToolLabel })
          : turn.answer
            ? t("assistant.answering")
            : (turn.toolRuns?.length ?? 0) > 0 || turn.tools.length
              ? t("assistant.organizing")
              : t("assistant.thinkingStatus");
  }
  const streamingLabel = pendingTurn ? streamingLabelFor(pendingTurn) : "";
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
  const scopeOptions: { value: ScopeChoice; label: string; enabled: boolean }[] = [
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

  const closeScopeMenu = useCallback((restoreFocus = true) => {
    setScopeMenuOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => scopeTriggerRef.current?.focus());
    }
  }, []);

  const handleScopeMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const items = scopeItemRefs.current.filter(
        (item): item is HTMLButtonElement => !!item && !item.disabled,
      );
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeScopeMenu();
        return;
      }
      if (event.key === "Tab") {
        closeScopeMenu(false);
        return;
      }
      if (!items.length) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      let next: number | null = null;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        next = current < 0 ? 0 : (current + 1) % items.length;
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        next = current <= 0 ? items.length - 1 : current - 1;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = items.length - 1;
      }
      if (next == null) return;
      event.preventDefault();
      items[next]?.focus();
    },
    [closeScopeMenu],
  );
  const actionExecutionBusy = actionExecutionCount > 0;
  const conversationMutationBusy = deletingConversationId !== null;
  const generationStatus = stopping ? t("assistant.stopping") : streamingLabel;

  // 视觉阶段和读屏通知共用一个 live region，但不能互相遮住：旧确认卡可能在新一轮
  // 生成期间完成，动作回执必须先被读屏播报，再由下一次阶段变化接管通知文本。
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
  }, [open]);

  // 展开即视为「已读」，清掉球上的完成点。
  useEffect(() => {
    if (open) setHasUnread(false);
  }, [open]);

  // 范围菜单：点菜单外任意处收起。
  useEffect(() => {
    if (!scopeMenuOpen) return;
    const frame = requestAnimationFrame(() => {
      const enabled = scopeItemRefs.current.filter(
        (item): item is HTMLButtonElement => !!item && !item.disabled,
      );
      const selectedIndex = enabled.findIndex(
        (item) => item.getAttribute("aria-checked") === "true",
      );
      (enabled[selectedIndex >= 0 ? selectedIndex : 0] ?? enabled[0])?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      if (scopeMenuRef.current?.contains(event.target as Node)) return;
      closeScopeMenu(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [closeScopeMenu, scopeMenuOpen]);

  useEffect(() => {
    if (!open || !mobile) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, mobile]);

  useEffect(() => {
    if (mobile) return;

    const keepInsideViewport = () => {
      const panel = measurePanel();
      const viewport = viewportSize();
      setPosition((current) => ({
        x: clamp(current.x, VIEWPORT_GAP, viewport.width - panel.width - VIEWPORT_GAP),
        y: clamp(current.y, VIEWPORT_GAP, viewport.height - panel.height - VIEWPORT_GAP),
      }));
      setDockTop((current) =>
        clamp(current, VIEWPORT_GAP, viewport.height - LAUNCHER_SIZE - VIEWPORT_GAP),
      );
    };

    window.addEventListener("resize", keepInsideViewport);
    return () => window.removeEventListener("resize", keepInsideViewport);
  }, [mobile]);

  useEffect(() => {
    mountedRef.current = true;
    const locallyStoppedRequests = locallyStoppedRequestsRef.current;
    return () => {
      mountedRef.current = false;
      dragCleanupRef.current?.();
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

  function measurePanel() {
    const fallback = fallbackPanelSize();
    const rect = panelRef.current?.getBoundingClientRect();
    return {
      width: rect?.width || fallback.width,
      height: rect?.height || fallback.height,
    };
  }

  function positionAtSide(nextSide: DockSide, y: number) {
    const viewport = viewportSize();
    const panel = measurePanel();
    return {
      x:
        nextSide === "left"
          ? VIEWPORT_GAP
          : viewport.width - panel.width - VIEWPORT_GAP,
      y: clamp(y, VIEWPORT_GAP, viewport.height - panel.height - VIEWPORT_GAP),
    };
  }

  function movePanelToSide(nextSide: DockSide) {
    dock(nextSide);
    setPosition((current) => positionAtSide(nextSide, current.y));
  }

  function dockToStrip(nextSide: DockSide, y: number, focusLauncher = false) {
    const { height } = viewportSize();
    const panel = measurePanel();
    const centeredTop = y + panel.height / 2 - LAUNCHER_SIZE / 2;
    setDockTop(
      clamp(centeredTop, VIEWPORT_GAP, height - LAUNCHER_SIZE - VIEWPORT_GAP),
    );
    dock(nextSide);
    focusLauncherAfterCloseRef.current = focusLauncher;
    setOpen(false);
  }

  function openFromDock() {
    const panel = measurePanel();
    const centeredTop = dockTop + LAUNCHER_SIZE / 2 - panel.height / 2;
    setPosition(positionAtSide(side, centeredTop));
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function collapseToNearestSide(focusLauncher = false) {
    const panel = measurePanel();
    const nearestSide: DockSide =
      position.x + panel.width / 2 < viewportSize().width / 2 ? "left" : "right";
    dockToStrip(nearestSide, position.y, focusLauncher);
  }

  function enterDockMode() {
    setMode("docked");
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function exitDockMode() {
    setMode("float");
    collapseToNearestSide(true);
  }

  function updateDrag(clientX: number, clientY: number) {
    const session = dragRef.current;
    if (!session) return null;

    if (!session.moved) {
      const distance = Math.hypot(clientX - session.startX, clientY - session.startY);
      if (distance < DRAG_START_DISTANCE) return session;
      session.moved = true;
    }

    const viewport = viewportSize();
    const rawX = clientX - session.offsetX;
    const rawY = clientY - session.offsetY;

    if (session.source === "dock") {
      // 球跟着指针走，松手时贴回最近的一边。
      //
      // 这里原先还有一档「向内拖过 16px 就展开成面板」。挪个位置和打开面板是两件事，
      // 揉进同一个手势的结果是：想把球往下挪一点，整块面板弹了出来——16px 的门槛低到
      // 任何一次真实拖动都会顺手越过。开面板交给点击就够了。
      const x = clamp(
        rawX,
        LAUNCHER_MARGIN,
        viewport.width - session.width - LAUNCHER_MARGIN,
      );
      const y = clamp(
        rawY,
        VIEWPORT_GAP,
        viewport.height - session.height - VIEWPORT_GAP,
      );
      session.position = { x, y };
      session.snapSide = x + session.width / 2 < viewport.width / 2 ? "left" : "right";
      setLauncherPosition(session.position);
      return session;
    }

    const nearLeft = rawX <= EDGE_SNAP_DISTANCE;
    const nearRight =
      rawX + session.width >= viewport.width - EDGE_SNAP_DISTANCE;
    const nextSnapSide: DockSide | null =
      nearLeft && nearRight
        ? clientX < viewport.width / 2
          ? "left"
          : "right"
        : nearLeft
          ? "left"
          : nearRight
            ? "right"
            : null;

    session.position = {
      x:
        nextSnapSide === "left"
          ? 0
          : nextSnapSide === "right"
            ? viewport.width - session.width
            : clamp(rawX, VIEWPORT_GAP, viewport.width - session.width - VIEWPORT_GAP),
      y: clamp(rawY, VIEWPORT_GAP, viewport.height - session.height - VIEWPORT_GAP),
    };
    session.snapSide = nextSnapSide;
    setPosition(session.position);
    setSnapSide(nextSnapSide);
    return session;
  }

  function trackDrag(event: ReactPointerEvent<HTMLButtonElement>, session: DragSession) {
    if (mobile || (event.pointerType === "mouse" && event.button !== 0)) return;

    dragCleanupRef.current?.();
    const handle = event.currentTarget;
    dragRef.current = session;
    setDragging(session.source === "panel");
    setSnapSide(null);

    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // WebView / jsdom 可能没有指针捕获；window 监听仍能保证拖出标题栏后继续移动。
    }

    const removeListeners = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      try {
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      } catch {
        // 与 setPointerCapture 相同，缺少该 API 时无需额外处理。
      }
      if (dragCleanupRef.current === removeListeners) dragCleanupRef.current = null;
    };

    const finish = (pointerEvent: PointerEvent, cancelled: boolean) => {
      const session = dragRef.current;
      if (!session || pointerEvent.pointerId !== session.pointerId) return;
      const completed = cancelled ? session : updateDrag(pointerEvent.clientX, pointerEvent.clientY);
      removeListeners();
      dragRef.current = null;
      setDragging(false);
      setSnapSide(null);

      if (completed?.source === "dock") {
        setLauncherPosition(null);
        if (!completed.moved) return;
        // 拖完浏览器还会补一个 click，得把它吃掉。
        //
        // 原来是置位后用 setTimeout(0) 复位，指望「click 比定时器先到」。真实浏览器里
        // pointerup 与 click 之间隔着一次事件循环，定时器完全可能插在中间先跑——
        // 于是标志被提前清掉，那一下拖动结束就顺手把面板打开了。
        // 测试没抓到是因为它把 pointerUp 和 click 排在同一个同步块里，定时器根本没机会跑。
        //
        // 改成由 click 自己消费；万一这次没有 click（比如松手时指针已经离开按钮），
        // 下一次 pointerdown 会清掉它，不会误伤后面那次真正的点击。
        suppressLauncherClickRef.current = true;
        // 取消（指针被系统收走）就当这次拖动没发生过：球回到原来贴边的位置。
        if (cancelled) return;
        setDockTop(completed.position.y);
        if (completed.snapSide) dock(completed.snapSide);
        return;
      }

      if (!cancelled && completed?.moved && completed.snapSide) {
        dockToStrip(completed.snapSide, completed.position.y);
      }
    };

    function onMove(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== dragRef.current?.pointerId) return;
      pointerEvent.preventDefault();
      updateDrag(pointerEvent.clientX, pointerEvent.clientY);
    }

    function onUp(pointerEvent: PointerEvent) {
      finish(pointerEvent, false);
    }

    function onCancel(pointerEvent: PointerEvent) {
      finish(pointerEvent, true);
    }

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    dragCleanupRef.current = removeListeners;
  }

  function beginPanelDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (mobile || (event.pointerType === "mouse" && event.button !== 0)) return;

    const panel = measurePanel();
    const rect = panelRef.current?.getBoundingClientRect();
    const panelLeft = rect?.width ? rect.left : position.x;
    const panelTop = rect?.height ? rect.top : position.y;
    trackDrag(event, {
      source: "panel",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - panelLeft,
      offsetY: event.clientY - panelTop,
      width: panel.width,
      height: panel.height,
      moved: false,
      position,
      snapSide: null,
    });
  }

  function beginDockDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (mobile || (event.pointerType === "mouse" && event.button !== 0)) return;
    // 上一次拖动如果没等到 click（松手时指针已经不在球上），标志会留着。
    // 每次按下先清一次，保证它只压制紧随其后的那一下。
    suppressLauncherClickRef.current = false;

    // 按球自己的盒子算偏移量，指针才会稳稳停在按下时的那一点上。
    const viewport = viewportSize();
    const rect = event.currentTarget.getBoundingClientRect();
    const ball = {
      x: rect.width
        ? rect.left
        : side === "left"
          ? LAUNCHER_MARGIN
          : viewport.width - LAUNCHER_SIZE - LAUNCHER_MARGIN,
      y: rect.height ? rect.top : dockTop,
    };
    trackDrag(event, {
      source: "dock",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - ball.x,
      offsetY: event.clientY - ball.y,
      width: LAUNCHER_SIZE,
      height: LAUNCHER_SIZE,
      moved: false,
      position: ball,
      snapSide: side,
    });
  }

  /**
   * 拉宽/收窄面板。
   *
   * 固定 360px 对一段带列表和公式的长回答太窄了——每行放不下十几个字，一条列表项要折三行。
   * 抓手放在朝向屏幕内侧的那条边（停在右边就抓左边框），拖的时候贴边的那一侧不动：
   * 面板向内长出来，而不是整块跟着手跑出屏幕。
   */
  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (mobile || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    dragCleanupRef.current?.();

    const handle = event.currentTarget;
    const { pointerId } = event;
    const fromLeftEdge = side === "right";
    const startX = event.clientX;
    const startWidth = measurePanel().width;
    // 不动的那条边。左边框拖动时右边固定，反之亦然。
    // 浮动面板按 position（渲染真实值）；停靠侧栏时贴边渲染、position 是旧值，
    // 改按实测矩形，jsdom 里矩形为 0 时退到贴边位置（右 0 → viewport.width，左 0 → 0）。
    let anchor: number;
    if (docked) {
      const rect = panelRef.current?.getBoundingClientRect();
      const viewport = viewportSize();
      const panelLeft = rect?.width ? rect.left : side === "left" ? 0 : viewport.width - startWidth;
      const panelRight = rect?.width ? rect.right : panelLeft + startWidth;
      anchor = fromLeftEdge ? panelRight : panelLeft;
    } else {
      anchor = fromLeftEdge ? position.x + startWidth : position.x;
    }

    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // 与拖动一样：没有指针捕获时靠 window 监听也能跟到底。
    }

    const widthAt = (clientX: number) => {
      const viewport = viewportSize();
      const room = fromLeftEdge ? anchor - VIEWPORT_GAP : viewport.width - anchor - VIEWPORT_GAP;
      const dragged = fromLeftEdge ? startX - clientX : clientX - startX;
      const wanted = clampPanelWidth(startWidth + dragged);
      // 视口比偏好上限还窄时，宽度让位给视口，但不缩到读不了。
      return Math.min(wanted, Math.max(MIN_PANEL_WIDTH, room));
    };

    const apply = (clientX: number) => {
      const next = widthAt(clientX);
      setResizeWidth(next);
      if (fromLeftEdge) setPosition((current) => ({ ...current, x: anchor - next }));
      return next;
    };

    const removeListeners = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      try {
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      } catch {
        // 同上，缺少该 API 时无需额外处理。
      }
      if (dragCleanupRef.current === removeListeners) dragCleanupRef.current = null;
    };

    function onMove(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== pointerId) return;
      pointerEvent.preventDefault();
      apply(pointerEvent.clientX);
    }

    function onUp(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== pointerId) return;
      setWidth(apply(pointerEvent.clientX));
      setResizeWidth(null);
      removeListeners();
    }

    function onCancel(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== pointerId) return;
      // 指针被系统收走就当这次没拖过：回到偏好里存着的宽度。
      setResizeWidth(null);
      if (fromLeftEdge) setPosition((current) => ({ ...current, x: anchor - startWidth }));
      removeListeners();
    }

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    dragCleanupRef.current = removeListeners;
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    // 抓手在哪边，「往外拉」就是哪个方向：停在右边时抓的是左边框，向左即变宽。
    const widen = side === "right" ? "ArrowLeft" : "ArrowRight";
    const narrow = side === "right" ? "ArrowRight" : "ArrowLeft";
    const delta =
      event.key === widen
        ? KEYBOARD_RESIZE_STEP
        : event.key === narrow
          ? -KEYBOARD_RESIZE_STEP
          : 0;
    if (!delta) return;
    event.preventDefault();

    const next = clampPanelWidth(width + delta);
    setWidth(next);
    if (side === "right") {
      const viewport = viewportSize();
      setPosition((current) => ({
        ...current,
        x: clamp(current.x + (width - next), VIEWPORT_GAP, viewport.width - next - VIEWPORT_GAP),
      }));
    }
  }

  function movePanelWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (mobile) return;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      dockToStrip(event.key === "Home" ? "left" : "right", position.y, true);
      return;
    }

    const step = event.shiftKey ? KEYBOARD_MOVE_STEP * 2 : KEYBOARD_MOVE_STEP;
    const delta =
      event.key === "ArrowLeft"
        ? { x: -step, y: 0 }
        : event.key === "ArrowRight"
          ? { x: step, y: 0 }
          : event.key === "ArrowUp"
            ? { x: 0, y: -step }
            : event.key === "ArrowDown"
              ? { x: 0, y: step }
              : null;
    if (!delta) return;
    event.preventDefault();

    const viewport = viewportSize();
    const panel = measurePanel();
    const next = {
      x: clamp(
        position.x + delta.x,
        VIEWPORT_GAP,
        viewport.width - panel.width - VIEWPORT_GAP,
      ),
      y: clamp(
        position.y + delta.y,
        VIEWPORT_GAP,
        viewport.height - panel.height - VIEWPORT_GAP,
      ),
    };
    if (event.key === "ArrowLeft" && next.x === VIEWPORT_GAP) {
      dockToStrip("left", next.y, true);
    } else if (
      event.key === "ArrowRight" &&
      next.x === viewport.width - panel.width - VIEWPORT_GAP
    ) {
      dockToStrip("right", next.y, true);
    } else {
      setPosition(next);
    }
  }

  // 移动抽屉的下滑关闭：从抓手往下拖，越过阈值就收起。只用 pointer capture，
  // 不必像桌面面板那样挂 window 监听——这里是垂直单方向，手势要简单可靠。
  const SHEET_CLOSE_THRESHOLD = 120;
  function beginSheetCloseDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!mobile || (event.pointerType === "mouse" && event.button !== 0)) return;
    const handle = event.currentTarget;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // 缺少 pointer capture 时手势不可靠，直接放弃。
    }
    const startY = event.clientY;
    const onMove = (moveEvent: PointerEvent) => {
      setSheetDragY(Math.max(0, moveEvent.clientY - startY));
    };
    const onEnd = (endEvent: PointerEvent) => {
      const dy = endEvent.clientY - startY;
      setSheetDragY(null);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      try {
        if (handle.hasPointerCapture(endEvent.pointerId)) {
          handle.releasePointerCapture(endEvent.pointerId);
        }
      } catch {
        // 同上。
      }
      if (dy > SHEET_CLOSE_THRESHOLD) collapseToNearestSide(true);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }

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
      void queryClient.invalidateQueries({ queryKey: ["notes", videoId] });
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
  // 桌面端「停靠为侧栏」：贴边全高、内容让位，不再盖在阅读物上。
  const docked = !mobile && mode === "docked";
  const panelShown = docked || open;
  const shell = mobile
    ? "fixed inset-x-0 z-[47] h-[70dvh] max-h-[calc(100dvh-56px)] rounded-t-2xl border-t"
    : docked
      ? "fixed z-40 top-0 bottom-0 rounded-none border"
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
        if (scopeMenuOpen) {
          closeScopeMenu();
          return;
        }
        if (historyOpen) {
          setHistoryOpen(false);
          setRenamingId(null);
          setRenameDraft("");
          requestAnimationFrame(() => historyButtonRef.current?.focus());
          return;
        }
        if (docked) {
          exitDockMode();
          return;
        }
        collapseToNearestSide(true);
      }}
      data-dragging={mobile ? undefined : dragging}
      data-snap-side={mobile ? undefined : snapSide ?? undefined}
      style={
        mobile
          ? { bottom: panelBottom, transform: sheetDragY != null ? `translateY(${sheetDragY}px)` : undefined }
          : docked
            ? side === "left"
              ? { left: 0, top: 0, width: panelWidth }
              : { right: 0, top: 0, width: panelWidth }
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
      {/* 朝向屏幕内侧的那条边是宽度抓手。固定宽度对一段带列表和公式的长回答太窄了。 */}
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
          className={`absolute inset-y-3 z-10 w-2 cursor-col-resize touch-none rounded-full bg-[var(--border-subtle)] transition-colors hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:bg-[var(--focus-ring)] motion-reduce:transition-none ${
            side === "right" ? "left-0" : "right-0"
          } ${resizeWidth === null ? "" : "bg-[var(--accent)]"}`}
        />
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
        ) : docked ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1">
            <Sparkles className="h-4 w-4 flex-none text-[var(--accent-text)]" />
            <span
              id="assistant-panel-title"
              className="min-w-0 flex-1 text-sm font-medium text-[var(--text-strong)]"
            >
              {t("assistant.title")}
            </span>
          </span>
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
        {/* 手机端没有左右可停靠的空间，只有桌面端给这个按钮；停靠成侧栏后位置固定，也无需左右切换。 */}
        {!mobile && !docked && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={side === "left" ? t("assistant.dockRight") : t("assistant.dockLeft")}
            onClick={() => movePanelToSide(side === "left" ? "right" : "left")}
          >
            {side === "left" ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </Button>
        )}
        {/* 桌面端「停靠为侧栏 / 恢复浮动」。 */}
        {!mobile && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={docked ? t("assistant.undock") : t("assistant.dockAsSidebar")}
            title={docked ? t("assistant.undock") : t("assistant.dockAsSidebar")}
            onClick={docked ? exitDockMode : enterDockMode}
            className="ca-touch-44"
          >
            {docked ? <Move className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("assistant.collapseAssistant")}
          title={t("assistant.collapseWithShortcut", { shortcut: toggleShortcutLabel() })}
          onClick={() => (docked ? exitDockMode() : collapseToNearestSide(true))}
          className="ca-touch-44"
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
      {historyOpen ? (
        <section
          id="assistant-conversation-history"
          aria-labelledby="assistant-conversation-history-title"
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="border-b border-[var(--border-subtle)] px-3 py-2.5">
            <h2
              id="assistant-conversation-history-title"
              className="text-sm font-medium text-[var(--text-strong)]"
            >
              {t("assistant.conversationHistory")}
            </h2>
          </div>
          {error && (
            <div
              role="alert"
              className="m-3 mb-1 flex items-start gap-1.5 rounded-lg bg-[var(--status-err-bg)] px-2.5 py-2 text-xs text-[var(--status-err)]"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
          {conversationState.conversations.length > 0 ? (
            <div
              role="list"
              aria-label={t("assistant.conversationList")}
              className="min-h-0 flex-1 overflow-y-auto"
            >
              {conversationState.conversations.map((conversation) => {
                const current = conversation.id === conversationState.activeId;
                const updatedAt = formatConversationTime(
                  conversation.updatedAt,
                  i18n.resolvedLanguage ?? i18n.language,
                );
                const conversationTitle =
                  conversation.title || t("assistant.untitledConversation");
                return (
                  <div
                    key={conversation.id}
                    role="listitem"
                    className="flex items-center border-b border-[var(--border-subtle)]"
                  >
                    {renamingId === conversation.id ? (
                      <div className="flex min-h-[52px] min-w-0 flex-1 items-center gap-2 px-3 py-2">
                        <input
                          autoFocus
                          value={renameDraft}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                              event.preventDefault();
                              event.stopPropagation();
                              submitConversationRename(conversation.id);
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              event.stopPropagation();
                              cancelConversationRename(conversation.id);
                            }
                          }}
                          aria-label={t("assistant.renameConversationLabel")}
                          className="min-w-0 flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)] outline-none focus-visible:border-[var(--focus-ring)]"
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={t("assistant.renameSaveTarget", {
                            title: renameDraft.trim() || conversationTitle,
                          })}
                          disabled={conversationMutationBusy}
                          onClick={() => submitConversationRename(conversation.id)}
                          className="ca-touch-44 h-8 w-8"
                        >
                          <Check className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <button
                        ref={(node) => {
                          if (node) conversationButtonRefs.current.set(conversation.id, node);
                          else conversationButtonRefs.current.delete(conversation.id);
                        }}
                        type="button"
                        aria-current={current ? "true" : undefined}
                        disabled={busy || actionExecutionBusy || conversationMutationBusy}
                        onClick={() => switchConversation(conversation.id)}
                        className="ca-touch-44 flex min-h-[52px] min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-[var(--text-strong)]">
                            {conversationTitle}
                          </span>
                          {updatedAt && (
                            <time
                              dateTime={new Date(conversation.updatedAt).toISOString()}
                              className="mt-0.5 block text-[11px] text-[var(--text-faint)]"
                            >
                              {updatedAt}
                            </time>
                          )}
                        </span>
                        {current && (
                          <span className="flex flex-none items-center gap-1 text-[11px] text-[var(--accent-text)]">
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                            {t("assistant.currentConversation")}
                          </span>
                        )}
                      </button>
                    )}
                    {renamingId !== conversation.id && (
                      <button
                        ref={(node) => {
                          if (node) renameButtonRefs.current.set(conversation.id, node);
                          else renameButtonRefs.current.delete(conversation.id);
                        }}
                        type="button"
                        aria-label={t("assistant.renameConversationTarget", {
                          title: conversationTitle,
                        })}
                        title={t("assistant.renameConversationTarget", {
                          title: conversationTitle,
                        })}
                        disabled={busy || actionExecutionBusy || conversationMutationBusy}
                        onClick={() => {
                          setError("");
                          setStatusAnnouncement("");
                          setRenamingId(conversation.id);
                          setRenameDraft(conversation.title);
                        }}
                        className="ca-touch-44 grid h-8 w-8 flex-none place-items-center rounded-md text-[var(--text-faint)] transition-colors hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                      >
                        <PenLine className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      ref={(node) => {
                        if (node) deleteButtonRefs.current.set(conversation.id, node);
                        else deleteButtonRefs.current.delete(conversation.id);
                      }}
                      type="button"
                      aria-label={t("assistant.deleteConversationTarget", {
                        title: conversationTitle,
                      })}
                      title={t("assistant.deleteConversationTarget", {
                        title: conversationTitle,
                      })}
                      disabled={busy || actionExecutionBusy || conversationMutationBusy}
                      onClick={() => void removeConversation(conversation.id)}
                      className="ca-touch-44 grid h-8 w-8 flex-none place-items-center rounded-md text-[var(--text-faint)] transition-colors hover:bg-[var(--surface-card-hover)] hover:text-[var(--status-err)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {deletingConversationId === conversation.id ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="px-3 py-6 text-center text-xs text-[var(--text-faint)]">
              {t("assistant.emptyConversationHistory")}
            </p>
          )}
          <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {statusAnnouncement}
          </div>
        </section>
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
          <div className="flex min-h-full flex-col justify-center gap-4">
            <div>
              <p className="text-[15px] font-medium text-[var(--text-strong)]">{t("assistant.greeting")}</p>
              <p className="mt-1 text-xs leading-relaxed text-[var(--text-faint)]">
                {t("assistant.greetingHint", { scope: scopeLabel })}
              </p>
            </div>
            <div className="grid w-full gap-2">
              {suggestionsFor(resolvedContext, t).map((suggestion) => (
                <button
                  key={suggestion.prompt}
                  type="button"
                  disabled={actionExecutionBusy}
                  onClick={() => void send(suggestion.prompt)}
                  className="ca-touch-44 flex w-full items-center justify-between gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2.5 text-left text-sm text-[var(--text-normal)] transition-colors hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                >
                  <span>{suggestion.label}</span>
                  <ArrowUpRight className="h-3.5 w-3.5 flex-none text-[var(--text-faint)]" />
                </button>
              ))}
            </div>
          </div>
        )}
        {hiddenTurnCount > 0 && (
          <p className="text-center text-[11px] text-[var(--text-faint)]">
            {t("assistant.hiddenTurns", { count: hiddenTurnCount })}
          </p>
        )}
        {turns.map((turn) => (
          <div key={turn.id} className="space-y-2">
            {/* 自己说的话靠右、带底色；助手的靠左。一眼能分清谁说的，
                比让两边都是同一坨灰字强得多。 */}
            <div className="flex justify-end">
              <p
                data-testid="user-bubble"
                className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-[var(--accent-weak)] px-3 py-1.5 text-sm text-[var(--accent-text)]"
              >
                {turn.question}
              </p>
            </div>

            {/* 提问后、第一个工具/正文到达前，助手槽位是空的。给一个内联「正在思考」，
                别让用户对着自己刚发的话干等。纯视觉：读屏状态由底部 live region 统一播报，
                这里不加 role，避免多出一个 status 抢播。
                只对唯一 pending 的回合显示：曾出现过同问题产生两个 pending 回合、界面
                同时显示两条「整理结果」的情况（其中一条永远卡住）。收敛到 pendingTurn（第一个
                pending）后，无论数据层有几个，界面始终只有一条状态，不会重复。 */}
            {turn.pending &&
              !turn.answer &&
              turn.id === pendingTurn?.id && (
                <div aria-hidden="true" className="flex items-center gap-2 text-xs text-[var(--text-faint)]">
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  <span>{streamingLabelFor(turn)}</span>
                </div>
              )}

            {/* 工具链摆在回答前面：它解释了这段回答是怎么来的，
                也让「一轮里悄悄调了三次搜索」这种事看得见。 */}
            <AssistantToolChips tools={turn.tools} toolRuns={turn.toolRuns} />

            {/* 推理模型的思考。它比正文先到，所以不能塞在「有答案才渲染」的分支里——
                那样恰好在最想看它的那段时间（还没开始作答）什么都不显示。
                默认折叠：它是过程不是结论，摊开会把真正的回答挤下去。 */}
            {turn.reasoning && (
              <details className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card-hover)] px-2.5 py-1.5">
                <summary className="cursor-pointer select-none rounded text-xs text-[var(--text-faint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
                  {turn.pending ? (
                    <span className="inline-flex items-center gap-1.5">
                      <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
                      {t("assistant.thinking")}
                    </span>
                  ) : (
                    t("assistant.thinking")
                  )}
                </summary>
                <div className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-muted)]">
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
                {/* 回答天然带 Markdown（列表、加粗、公式），当纯文本铺出来满屏 ** 和 -，
                    比没有格式还难读。复用问答面板那套渲染器，顺带白拿了
                    公式渲染和 [mm:ss] 可点击跳转。整段用 memo 包住，避免无关状态变化
                    反复重解析已完成的回答。 */}
                <MemoAnswer answer={turn.answer} turn={turn} onSeek={seekInTurn} />
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
                    aria-label={copiedTurnId === turn.id ? t("assistant.copiedLabel") : t("assistant.copyAnswer")}
                    title={copiedTurnId === turn.id ? t("assistant.copiedLabel") : t("assistant.copyAnswer")}
                    onClick={() => void copyAnswer(turn)}
                    className="ca-touch-44 h-7 w-7 text-[var(--text-faint)]"
                  >
                    {copiedTurnId === turn.id ? (
                      <Check className="h-3.5 w-3.5 text-[var(--status-ok)]" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  {/* 有视频上下文时才能存进笔记：笔记是挂在视频上的。 */}
                  {(turn.context?.video_id ?? context.video_id) && (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={
                        savedToNotesTurnId === turn.id
                          ? t("assistant.savedToNotes")
                          : t("assistant.saveToNotes")
                      }
                      title={
                        savedToNotesTurnId === turn.id
                          ? t("assistant.savedToNotes")
                          : t("assistant.saveToNotes")
                      }
                      onClick={() => void saveToNotes(turn)}
                      className="ca-touch-44 h-7 w-7 text-[var(--text-faint)]"
                    >
                      {savedToNotesTurnId === turn.id ? (
                        <Check className="h-3.5 w-3.5 text-[var(--status-ok)]" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}
                  {/* 只给最后一轮。往回重生成会让它后面的问答全部失去依据——那已经是分支，
                      不是重试了。 */}
                  {turn.id === turns[turns.length - 1]?.id && (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("assistant.regenerate")}
                      title={t("assistant.regenerate")}
                      disabled={busy || actionExecutionBusy}
                      onClick={() => regenerate(turn)}
                      className="ca-touch-44 h-7 w-7 text-[var(--text-faint)]"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                {/* 这一轮实际花了多少，完成之后给一个不抢眼但可见的数字；
                    端点没报用量就不显示——把「没报」当成零消耗是撒谎。 */}
                {!turn.pending && turn.usage && (
                  <p
                    data-testid="turn-usage"
                    className="mt-0.5 text-[10px] text-[var(--text-faint)]"
                  >
                    {t("assistant.usageTokens", {
                      tokens: usageTokens(turn.usage).toLocaleString(),
                    })}
                  </p>
                )}
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
              <div className="flex items-start gap-1.5 text-[11px] text-[var(--text-muted)]">
                <AlertCircle className="mt-[0.2em] h-3 w-3 flex-none" aria-hidden="true" />
                <span className="min-w-0 break-words">
                  {turn.hitTurnLimit
                    ? t("assistant.turnLimitFallback")
                    : t("assistant.emptyAnswerFallback")}
                </span>
                {!turn.answer && turn.id === turns[turns.length - 1]?.id && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || actionExecutionBusy}
                    onClick={() => regenerate(turn)}
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
              onNavigate={(action) => navigateFromTurn(turn, action)}
              onOutcome={(outcome) =>
                commitActionOutcome(turn.id, outcome, conversationEpoch)
              }
              executionLocked={actionExecutionBusy}
              onExecutionStart={(actions) =>
                beginActionExecution(turn.id, actions, conversationEpoch)
              }
              onExecutionEnd={() => endActionExecution()}
              onApplied={onActionApplied}
            />

            {getAssistantInteractionState(turn).status === "expired" && (
              <div className="flex items-start gap-1.5 text-[11px] text-[var(--status-warn)]">
                <AlertCircle className="mt-[0.2em] h-3 w-3 flex-none" aria-hidden="true" />
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
                {turn.id === turns[turns.length - 1]?.id && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("assistant.recheckExpired")}
                    title={t("assistant.recheckExpired")}
                    disabled={busy || actionExecutionBusy}
                    onClick={() => regenerate(turn)}
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
              <p className="flex items-center gap-1 text-[10px] text-[var(--text-faint)]">
                <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
                {t("assistant.stopped")}
              </p>
            )}
          </div>
        ))}
        {error && (
          <div
            role="alert"
            className="flex items-start gap-1.5 rounded-lg bg-[var(--status-err-bg)] px-2.5 py-2 text-xs text-[var(--status-err)]"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={busy ? "flex items-center gap-2 px-3 pb-2 text-xs text-[var(--text-faint)]" : "sr-only"}
      >
        {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
        {busy && <span aria-hidden="true">{generationStatus}</span>}
        <span className={busy ? "sr-only" : undefined}>{statusAnnouncement}</span>
      </div>

      {/* 翻上去看旧回答时，新回答落在屏幕外，原来没有任何提示，也没有回来的路——
          只能自己往下拖。给一个浮在滚动区底部的按钮。 */}
      {scrolledAway && turns.length > 0 && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2.5 py-1 text-[11px] text-[var(--text-muted)] shadow-[var(--shadow-pop)] transition-colors hover:text-[var(--text-strong)] motion-reduce:transition-none"
        >
          <ArrowDown className="h-3 w-3" aria-hidden="true" />
          {t("assistant.scrollToLatest")}
        </button>
      )}
      </>
      )}
      </div>

      {/* 输入框、范围提示和按钮合成一块。原来三样东西各管各的，输入区看着像张随手贴的表单。 */}
      {!historyOpen && (
      <div className="border-t border-[var(--border-subtle)] p-2">
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-input)] focus-within:border-[var(--focus-ring)]">
          <div ref={scopeMenuRef} className="relative px-2.5 pt-1.5">
            <button
              ref={scopeTriggerRef}
              type="button"
              aria-label={t("assistant.scopeLabel", { scope: scopeLabel })}
              aria-haspopup="menu"
              aria-expanded={scopeMenuOpen}
              aria-controls={scopeMenuOpen ? scopeMenuId : undefined}
              title={t("assistant.scopeHint")}
              onClick={() => {
                if (scopeMenuOpen) closeScopeMenu();
                else setScopeMenuOpen(true);
              }}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--surface-card)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <AtSign className="h-2.5 w-2.5 flex-none" aria-hidden="true" />
              <span className="truncate">{scopeLabel}</span>
              <ChevronDown className="h-2.5 w-2.5 flex-none opacity-70" aria-hidden="true" />
            </button>
            {scopeMenuOpen && (
              <div
                id={scopeMenuId}
                role="menu"
                aria-label={t("assistant.scopeMenuLabel")}
                onKeyDown={handleScopeMenuKeyDown}
                className="absolute bottom-full left-0 z-20 mb-1 min-w-[180px] rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-1 shadow-[var(--shadow-pop)]"
              >
                {scopeOptions.map((option, index) => {
                  const active = option.value === scopeChoice;
                  return (
                    <button
                      key={option.value}
                      ref={(element) => {
                        scopeItemRefs.current[index] = element;
                      }}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      tabIndex={-1}
                      disabled={!option.enabled}
                      onClick={() => {
                        setScopeChoice(option.value);
                        closeScopeMenu();
                      }}
                      className="ca-touch-44 flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--text-normal)] transition-colors hover:bg-[var(--surface-card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span>{option.label}</span>
                      {active && (
                        <Check className="h-3.5 w-3.5 flex-none text-[var(--accent-text)]" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex items-end gap-2 px-2 pb-1.5 pt-1">
            <textarea
              ref={inputRef}
              aria-label={t("assistant.inputLabel")}
              rows={1}
              value={input}
              placeholder={t("assistant.inputPlaceholder")}
              onChange={(e) => setInputFromUser(e.target.value)}
              onKeyDown={(e) => {
                if (navigateRecentQuestions(e)) return;
                // Enter 发送、Shift+Enter 换行。输入法组词时的 Enter 不能当发送，
                // 否则中文用户每选一次候选词就误发一条。
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              className="ca-ask-input max-h-24 flex-1 resize-none bg-transparent px-0.5 py-1 text-sm text-[var(--text-strong)] outline-none placeholder:text-[var(--text-faint)]"
            />
            {busy ? (
              <Button
                size="icon"
                variant="outline"
                aria-label={t("assistant.stopGeneration")}
                title={t("assistant.stopGeneration")}
                disabled={stopping}
                onClick={stop}
                className="ca-touch-44 h-8 w-8 flex-none rounded-lg"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                size="icon"
                aria-label={t("assistant.send")}
                title={t("assistant.sendTitle")}
                disabled={!input.trim() || actionExecutionBusy}
                onClick={() => void send()}
                className="ca-touch-44 h-8 w-8 flex-none rounded-lg"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
      )}
    </aside>
    </>
  );
}
