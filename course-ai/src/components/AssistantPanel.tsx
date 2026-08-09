import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  AlertCircle,
  ArrowDown,
  ArrowUpRight,
  AtSign,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  GripHorizontal,
  LoaderCircle,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AssistantActionList } from "@/components/AssistantActionCard";
import { AssistantToolChips } from "@/components/AssistantToolChips";
import {
  boundTrustedAssistantHistory,
  capAssistantText,
  clearAssistantSession,
  getAssistantInteractionState,
  historyBeforeLastQuestion,
  MAX_ASSISTANT_ANSWER_CHARS,
  MAX_ASSISTANT_REASONING_CHARS,
  readAssistantSession,
  writeAssistantSession,
  type AssistantCheckpoint,
  type AssistantCheckpointActionKind,
  type AssistantTurnRecord,
} from "@/lib/assistantSession";
import { humanizeError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
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
import type { AssistantAction, AssistantContext, AssistantMessage } from "@/lib/types";

/**
 * 常驻的全局助手面板。
 *
 * 桌面端可拖动，移到左右边缘时吸附成窄条；手机端没有「边缘停靠」的余地，
 * 改成底部抽屉——两种外壳共用同一套状态和消息流，切换的只是容器。
 */

const PANEL_MAX_HEIGHT = 720;
const VIEWPORT_GAP = 16;
const EDGE_SNAP_DISTANCE = 28;
const SCROLL_FOLLOW_THRESHOLD = 32;
const SESSION_PERSIST_DELAY_MS = 250;
const MAX_RENDERED_TURNS = 50;
const MAX_STREAMED_TOOLS = 50;
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
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
};

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
      { label: t("assistant.suggestSummarizeVideo"), prompt: "概括当前视频的主要内容" },
      { label: t("assistant.suggestFindExamples"), prompt: "查找当前视频里讲例题的位置" },
      { label: t("assistant.suggestKeyPoints"), prompt: "梳理当前视频最重要的知识点" },
    ];
  }
  if (context.course_id) {
    return [
      { label: t("assistant.suggestOverviewCourse"), prompt: "概览这门课程的主要内容" },
      { label: t("assistant.suggestVideoList"), prompt: "列出这门课程的全部视频" },
      { label: t("assistant.suggestCourseKeyPoints"), prompt: "查找这门课程最重要的知识点" },
    ];
  }
  return [
    { label: t("assistant.suggestMyCourses"), prompt: "列出我的全部课程" },
    { label: t("assistant.suggestPlanStudy"), prompt: "根据我的课程规划下一步学习" },
    { label: t("assistant.suggestDarkMode"), prompt: "切换到夜间模式" },
  ];
}

export function AssistantPanel({
  context,
  onNavigate,
  onActionApplied,
  compact = false,
  bottomNavigationVisible = false,
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
}) {
  const { t } = useTranslation();
  const { open, side, width, setOpen, dock, setWidth } = useAssistantUi();
  const [initialSession] = useState(readAssistantSession);
  const [input, setInput] = useState(initialSession.draft);
  const [busy, setBusy] = useState(false);
  const [actionExecutionCount, setActionExecutionCount] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [turns, setTurns] = useState<Turn[]>(initialSession.turns);
  const [history, setHistory] = useState<AssistantMessage[]>(initialSession.history);
  const [conversationEpoch, setConversationEpoch] = useState(0);
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followScrollRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<DragSession | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const suppressLauncherClickRef = useRef(false);
  const activeRequestRef = useRef<string | null>(null);
  const actionExecutionCountRef = useRef(0);
  const mountedRef = useRef(true);
  const locallyStoppedRequestsRef = useRef(new Set<string>());
  const historyRef = useRef(initialSession.history);
  const conversationEpochRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);
  const persistTimerRef = useRef<number | null>(null);
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
  const toggleRef = useRef(() => {});
  const panelWidth = resizeWidth ?? width;

  // 「现在在干什么」跟着流走：工具执行优先于此前已经吐出的思考或过场正文。
  const pendingTurn = turns.find((turn) => turn.pending);
  const activeToolLabel = pendingTurn?.activeTool
    ? t(`assistantTools.${pendingTurn.activeTool.name}`, {
        defaultValue: pendingTurn.activeTool.name,
      })
    : null;
  const streamingLabel = activeToolLabel
    ? t("assistant.usingTool", { tool: activeToolLabel })
    : pendingTurn?.answer
      ? t("assistant.answering")
      : pendingTurn?.reasoning
        ? t("assistant.thinkingStatus")
        : t("assistant.thinkingWithTools");
  const setThemePref = useTheme((state) => state.setPref);
  const pendingInlineAsk = useInlineAsk((state) => state.pending);
  const clearInlineAsk = useInlineAsk((state) => state.clear);
  const scopeLabel = contextLabel(context, t);
  const actionExecutionBusy = actionExecutionCount > 0;

  function beginActionExecution() {
    if (actionExecutionCountRef.current > 0) return false;
    actionExecutionCountRef.current = 1;
    setActionExecutionCount(1);
    return true;
  }

  function endActionExecution() {
    actionExecutionCountRef.current = 0;
    setActionExecutionCount(0);
  }

  function markTurnActionsResolved(
    turnId: string,
    resolvedActions: AssistantAction[],
    epoch: number,
  ) {
    if (epoch !== conversationEpochRef.current || resolvedActions.length === 0) return;
    const resolved = new Set(resolvedActions);
    setTurns((previous) =>
      previous.map((turn) => {
        if (turn.id !== turnId) return turn;
        const indexes = new Set(turn.resolvedActionIndexes ?? []);
        turn.actions.forEach((action, index) => {
          if (resolved.has(action)) indexes.add(index);
        });
        return indexes.size === (turn.resolvedActionIndexes?.length ?? 0)
          ? turn
          : { ...turn, resolvedActionIndexes: [...indexes].sort((a, b) => a - b) };
      }),
    );
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
  sessionSnapshotRef.current = { turns, history, draft: input || pendingQuestion };
  useEffect(() => {
    const hasPendingTurn = turns.some((turn) => turn.pending);
    const requestJustFinished = hadPendingTurnRef.current && !hasPendingTurn;
    hadPendingTurnRef.current = hasPendingTurn;
    if (persistTimerRef.current != null) window.clearTimeout(persistTimerRef.current);
    if (requestJustFinished) {
      writeAssistantSession(sessionSnapshotRef.current);
      persistTimerRef.current = null;
      return;
    }
    persistTimerRef.current = window.setTimeout(() => {
      writeAssistantSession(sessionSnapshotRef.current);
      persistTimerRef.current = null;
    }, SESSION_PERSIST_DELAY_MS);
    return () => {
      if (persistTimerRef.current != null) window.clearTimeout(persistTimerRef.current);
    };
  }, [history, input, turns]);

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
    setInput((current) =>
      current.trim() ? `${current.trimEnd()}\n\n${draft}` : draft,
    );
    setOpen(true);
    clearInlineAsk();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [clearInlineAsk, pendingInlineAsk, setOpen]);

  useEffect(() => {
    if (open || !focusLauncherAfterCloseRef.current) return;
    focusLauncherAfterCloseRef.current = false;
    requestAnimationFrame(() => launcherRef.current?.focus());
  }, [open]);

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
      if (persistTimerRef.current != null) window.clearTimeout(persistTimerRef.current);
      writeAssistantSession(sessionSnapshotRef.current);
      const requestId = activeRequestRef.current;
      if (requestId) {
        locallyStoppedRequests.add(requestId);
        // IPC 会记住早于后端登记的取消，并在 ask 完成登记后补发。
        // 卸载后不能再展示错误，但也不能留下继续计费的无主请求。
        void ipc.assistant.cancel(requestId).catch(() => {});
      }
    };
  }, []);

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
    const anchor = fromLeftEdge ? position.x + startWidth : position.x;

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
      dockToStrip("left", next.y);
    } else if (
      event.key === "ArrowRight" &&
      next.x === viewport.width - panel.width - VIEWPORT_GAP
    ) {
      dockToStrip("right", next.y);
    } else {
      setPosition(next);
    }
  }

  async function send(suggestedQuestion?: string) {
    const question = (suggestedQuestion ?? input).trim();
    if (!question || busy || activeRequestRef.current) return;
    const requestId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const historyAtSend = historyRef.current;
    activeRequestRef.current = requestId;
    // 新问题是用户主动发起的导航点，无论此前停在哪一段，都把它带到最新内容。
    followScrollRef.current = true;
    setScrolledAway(false);
    // 只清从输入框发出的那一条。点建议、点重新回答时用户可能正打着别的字，
    // 不该被顺手抹掉。
    if (suggestedQuestion === undefined) setInput("");
    setBusy(true);
    setStopping(false);
    setError("");
    // 流式片段只做防抖持久化，但请求刚发出时先落一次草稿；即使应用随后退出，
    // 用户的问题也能回到输入框，而不是随着未完成轮次一起丢失。
    writeAssistantSession({ turns, history: historyAtSend, draft: input || question });
    // 长工具链可能要等几十秒；问题先进入对话，让用户立即确认自己发出了什么。
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
          context: { ...context },
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
        context,
        historyAtSend,
        requestId,
        (event) => {
          if (!mountedRef.current || event.type === "started") {
            return;
          } else if (event.type === "turn") {
            clearBufferedAnswer = true;
            bufferedAnswer = [];
            bufferedAnswerChars = 0;
            patch((item) => ({ ...item, activeTool: undefined }));
            scheduleStreamFlush();
          } else if (event.type === "reasoning") {
            bufferedReasoningChars = appendStreamChunk(
              bufferedReasoning,
              bufferedReasoningChars,
              event.delta,
              MAX_ASSISTANT_REASONING_CHARS,
            );
            scheduleStreamFlush();
          } else if (event.type === "token") {
            bufferedAnswerChars = appendStreamChunk(
              bufferedAnswer,
              bufferedAnswerChars,
              event.delta,
              MAX_ASSISTANT_ANSWER_CHARS,
            );
            scheduleStreamFlush();
          } else if (event.type === "tool") {
            bufferedTools = [...bufferedTools, event.name].slice(-MAX_STREAMED_TOOLS);
            patch((item) => ({
              ...item,
              activeTool: { callId: event.call_id, name: event.name },
            }));
            scheduleStreamFlush();
          } else if (event.type === "tool_finished") {
            patch((item) => ({
              ...item,
              activeTool:
                item.activeTool?.callId === event.call_id ? undefined : item.activeTool,
            }));
          }
        },
      );
      if (!mountedRef.current) return;
      flushStream();
      const locallyStopped = locallyStoppedRequestsRef.current.has(requestId);
      const canceled = reply.canceled || locallyStopped;
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
                  locallyStopped && !reply.canceled
                    ? ""
                    : capAssistantText(reply.answer, MAX_ASSISTANT_ANSWER_CHARS),
                actions,
                tools: reply.tools_used.slice(-MAX_STREAMED_TOOLS),
                canceled,
                // 用户叫停的那一轮已经有自己的说明，再挂一条「没得出结论」是在替它
                // 找借口——它没转不出来，是被你按停的。
                hitTurnLimit: reply.hit_turn_limit && !canceled,
                activeTool: undefined,
                pending: false,
              }
            : turn,
        ),
      );
    } catch (e) {
      if (!mountedRef.current) return;
      // 把问题放回输入框：让用户能直接重发，而不是重新打一遍。
      // 但输入框里已经有东西时不覆盖——那是他趁等待时打的，比这句重发的价值高。
      setTurns((prev) => prev.filter((turn) => turn.id !== turnId));
      setInput((current) => (current.trim() ? current : question));
      setError(humanizeError(e));
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
    void send(turn.question);
  }

  function jumpToLatest() {
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
    followScrollRef.current = true;
    setScrolledAway(false);
  }

  function recordActionResult(turnId: string, message: string, epoch: number) {
    // 用户可以在确认卡执行期间开始新对话。旧操作照常完成，但它的回执不能写进
    // 已经重置的会话，尤其不能混入新会话正在进行的请求。
    if (epoch !== conversationEpochRef.current) return;
    // 独立追加而不是改写“最后一条回答”：用户可能回头执行旧轮次的卡片，附到最新回答
    // 会把两个不相干的操作串在一起。assistant 角色也不会消耗后端的用户轮次上限。
    setTurns((previous) =>
      previous.map((turn) =>
        turn.id === turnId
          ? { ...turn, actionResults: [...turn.actionResults, message] }
          : turn,
      ),
    );
    historyRef.current = boundTrustedAssistantHistory([
      ...historyRef.current,
      { role: "assistant", content: t("assistant.uiActionResult", { message }) },
    ]);
    setHistory(historyRef.current);
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

  function startNewConversation() {
    if (busy || actionExecutionCountRef.current > 0) return;
    const nextEpoch = conversationEpochRef.current + 1;
    conversationEpochRef.current = nextEpoch;
    setConversationEpoch(nextEpoch);
    setTurns([]);
    followScrollRef.current = true;
    setScrolledAway(false);
    historyRef.current = [];
    setHistory([]);
    setInput("");
    setError("");
    clearAssistantSession();
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  const launcherBottom = bottomNavigationVisible
    ? "calc(56px + env(safe-area-inset-bottom, 0px) + 24px)"
    : "calc(env(safe-area-inset-bottom, 0px) + 24px)";
  const shell = mobile
    ? "fixed inset-x-0 z-[47] h-[70dvh] max-h-[calc(100dvh-56px)] rounded-t-2xl border-t"
    : "fixed z-40 h-[min(720px,calc(100dvh-2rem))] max-w-[calc(100vw-2rem)] rounded-2xl border";
  const panelBottom = bottomNavigationVisible
    ? "calc(56px + env(safe-area-inset-bottom, 0px))"
    : "env(safe-area-inset-bottom, 0px)";

  return (
    <>
      {!open && (
      <button
        ref={launcherRef}
        type="button"
        aria-label={t("assistant.openAssistant")}
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
            ? "ca-touch-44 fixed right-4 z-40 grid h-12 w-12 place-items-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-panel)] shadow-[var(--shadow-pop)] transition-colors hover:border-[var(--border-strong)] motion-reduce:transition-none"
            : `ca-touch-44 fixed z-40 grid h-14 w-14 touch-none select-none cursor-grab active:cursor-grabbing place-items-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-panel)] shadow-[var(--shadow-pop)] transition hover:scale-105 hover:border-[var(--border-strong)] motion-reduce:transition-none motion-reduce:hover:scale-100 ${
                launcherPosition ? "" : side === "left" ? "left-3" : "right-3"
              }`
        }
      >
        <Sparkles className="h-5 w-5 text-[var(--accent)]" aria-hidden="true" />
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
      hidden={!open}
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
        collapseToNearestSide(true);
      }}
      data-dragging={mobile ? undefined : dragging}
      data-snap-side={mobile ? undefined : snapSide ?? undefined}
      style={
        mobile
          ? { bottom: panelBottom }
          : { left: position.x, top: position.y, width: panelWidth }
      }
      className={`${open ? "flex" : "hidden"} ${shell} flex-col border-[var(--border-subtle)] bg-[var(--surface-panel)] shadow-[var(--shadow-pop)] ${
        snapSide ? "ring-2 ring-[var(--accent)]" : ""
      }`}
    >
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
          className={`absolute inset-y-3 z-10 w-1.5 cursor-col-resize touch-none rounded-full transition-colors hover:bg-[var(--accent-weak-2)] focus-visible:outline-none focus-visible:bg-[var(--accent)] motion-reduce:transition-none ${
            side === "right" ? "left-0" : "right-0"
          } ${resizeWidth === null ? "" : "bg-[var(--accent)]"}`}
        />
      )}
      <header className="flex items-center gap-1 border-b border-[var(--border-subtle)] px-3 py-2">
        {/* 提问范围原先挤在标题旁边，11px 一行灰字。它决定了「这个视频」指的是谁，
            该待在你打字的地方，而不是滚动区顶上那条最容易被忽略的边。 */}
        {mobile ? (
          <>
            <Sparkles className="h-4 w-4 flex-none text-[var(--accent)]" />
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
            className="-ml-1 flex min-w-0 flex-1 touch-none select-none items-center gap-1.5 rounded-md px-1 py-1 text-left cursor-grab active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <GripHorizontal className="h-4 w-4 flex-none text-[var(--text-faint)]" />
            <Sparkles className="h-4 w-4 flex-none text-[var(--accent)]" />
            <span
              id="assistant-panel-title"
              className="min-w-0 flex-1 text-sm font-medium text-[var(--text-strong)]"
            >
              {t("assistant.title")}
            </span>
          </button>
        )}
        {(turns.length > 0 || history.length > 0) && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("assistant.newChat")}
            title={t("assistant.newChat")}
            disabled={busy || actionExecutionBusy}
            onClick={startNewConversation}
          >
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
        )}
        {/* 手机端没有左右可停靠的空间，只有桌面端给这个按钮。 */}
        {!mobile && (
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
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("assistant.collapseAssistant")}
          title={t("assistant.collapseWithShortcut", { shortcut: toggleShortcutLabel() })}
          onClick={() => collapseToNearestSide()}
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
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
              {suggestionsFor(context, t).map((suggestion) => (
                <button
                  key={suggestion.prompt}
                  type="button"
                  onClick={() => void send(suggestion.prompt)}
                  className="ca-touch-44 flex w-full items-center justify-between gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2.5 text-left text-sm text-[var(--text-normal)] transition-colors hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] motion-reduce:transition-none"
                >
                  <span>{suggestion.label}</span>
                  <ArrowUpRight className="h-3.5 w-3.5 flex-none text-[var(--text-faint)]" />
                </button>
              ))}
            </div>
          </div>
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

            {/* 工具链摆在回答前面：它解释了这段回答是怎么来的，
                也让「一轮里悄悄调了三次搜索」这种事看得见。 */}
            <AssistantToolChips tools={turn.tools} />

            {/* 推理模型的思考。它比正文先到，所以不能塞在「有答案才渲染」的分支里——
                那样恰好在最想看它的那段时间（还没开始作答）什么都不显示。
                默认折叠：它是过程不是结论，摊开会把真正的回答挤下去。 */}
            {turn.reasoning && (
              <details className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card-hover)] px-2.5 py-1.5">
                <summary className="cursor-pointer select-none text-xs text-[var(--text-faint)]">
                  {t("assistant.thinking")}
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
                    公式渲染和 [mm:ss] 可点击跳转。 */}
                <div className="break-words text-sm leading-relaxed text-[var(--text-normal)]">
                  {renderMarkdown(turn.answer, (ms) =>
                    navigateFromTurn(turn, { kind: "seek_to", at_ms: ms }),
                  )}
                </div>
                {/* 每条回答底下常驻一排按钮，翻起来满屏都是灰图标。桌面端悬停或键盘聚焦才浮出来，
                    但位置一直留着——不留的话鼠标一进来整段就往上跳。触屏没有悬停，一直显示。 */}
                <div
                  className={`-ml-1.5 mt-0.5 flex h-7 items-center gap-0.5 ${
                    mobile
                      ? ""
                      : "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
                  }`}
                >
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={copiedTurnId === turn.id ? t("assistant.copiedLabel") : t("assistant.copyAnswer")}
                    title={copiedTurnId === turn.id ? t("assistant.copiedLabel") : t("assistant.copyAnswer")}
                    onClick={() => void copyAnswer(turn)}
                    className="h-7 w-7 text-[var(--text-faint)]"
                  >
                    {copiedTurnId === turn.id ? (
                      <Check className="h-3.5 w-3.5 text-[var(--status-ok)]" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
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
                      className="h-7 w-7 text-[var(--text-faint)]"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
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
              <div className="flex items-start gap-1.5 text-[11px] text-[var(--text-muted)]">
                <AlertCircle className="mt-[0.2em] h-3 w-3 flex-none" aria-hidden="true" />
                <span className="min-w-0 break-words">
                  {turn.hitTurnLimit
                    ? "助手连查了几轮也没能得出结论，已经停下。问得再具体一点通常能问出来。"
                    : "助手这次没有给出回答。"}
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
              onResult={(message) => recordActionResult(turn.id, message, conversationEpoch)}
              executionLocked={actionExecutionBusy}
              onExecutionStart={beginActionExecution}
              onExecutionEnd={endActionExecution}
              onActionsResolved={(actions) =>
                markTurnActionsResolved(turn.id, actions, conversationEpoch)
              }
              onApplied={onActionApplied}
            />

            {getAssistantInteractionState(turn).status === "expired" && (
              <div className="flex items-start gap-1.5 text-[11px] text-[var(--status-warn)]">
                <AlertCircle className="mt-[0.2em] h-3 w-3 flex-none" aria-hidden="true" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="break-words">
                    {turn.checkpoint?.expiredReason === "timeout"
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
        {busy && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 text-xs text-[var(--text-faint)]"
          >
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {/* 正文改成流式之后，字已经在往外冒的时候再说「正在思考」就不对了。 */}
            <span>{stopping ? t("assistant.stopping") : streamingLabel}</span>
          </div>
        )}
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
      </div>

      {/* 输入框、范围提示和按钮合成一块。原来三样东西各管各的，输入区看着像张随手贴的表单。 */}
      <div className="border-t border-[var(--border-subtle)] p-2">
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-input)] focus-within:border-[var(--accent)]">
          <div className="px-2.5 pt-1.5">
            <span
              aria-label={t("assistant.scopeLabel", { scope: scopeLabel })}
              title={t("assistant.scopeHint")}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--surface-card)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]"
            >
              <AtSign className="h-2.5 w-2.5 flex-none" aria-hidden="true" />
              <span className="truncate">{scopeLabel}</span>
            </span>
          </div>
          <div className="flex items-end gap-2 px-2 pb-1.5 pt-1">
            <textarea
              ref={inputRef}
              aria-label={t("assistant.inputLabel")}
              rows={1}
              value={input}
              placeholder={t("assistant.inputPlaceholder")}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
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
                className="h-8 w-8 flex-none rounded-lg"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                size="icon"
                aria-label={t("assistant.send")}
                title={t("assistant.sendTitle")}
                disabled={!input.trim()}
                onClick={() => void send()}
                className="h-8 w-8 flex-none rounded-lg"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </aside>
    </>
  );
}
