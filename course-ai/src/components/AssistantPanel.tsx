import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  GripHorizontal,
  LoaderCircle,
  MessageSquarePlus,
  Send,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AssistantActionList } from "@/components/AssistantActionCard";
import { AssistantToolChips } from "@/components/AssistantToolChips";
import {
  clearAssistantSession,
  readAssistantSession,
  writeAssistantSession,
  type AssistantTurnRecord,
} from "@/lib/assistantSession";
import { humanizeError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import { isMobile, isTablet } from "@/lib/platform";
import { formatMs } from "@/lib/time";
import { type DockSide, useAssistantUi } from "@/stores/assistant";
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

const PANEL_WIDTH = 360;
const PANEL_MAX_HEIGHT = 720;
const VIEWPORT_GAP = 16;
const EDGE_SNAP_DISTANCE = 28;
/// 收起时那颗球的直径。停靠位置的夹取与展开/收起时的居中都按它算，
/// 改了尺寸这些数会自动跟上。
const LAUNCHER_SIZE = 56;
/// 球贴边时离边框的距离，与它的 left-3 / right-3 一致——拖动时按同一个数夹取，
/// 松手贴回去才不会横着弹一下。
const LAUNCHER_MARGIN = 12;
const KEYBOARD_MOVE_STEP = 24;
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

function fallbackPanelSize() {
  const viewport = viewportSize();
  return {
    width: Math.min(PANEL_WIDTH, Math.max(0, viewport.width - VIEWPORT_GAP * 2)),
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

function initialDockTop() {
  const { height } = viewportSize();
  return Math.max(VIEWPORT_GAP, height - LAUNCHER_SIZE - 24);
}

type Turn = AssistantTurnRecord;

function formatPosition(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function contextLabel(context: AssistantContext) {
  if (context.video_id) {
    return context.position_ms != null && context.position_ms > 0
      ? `当前视频 · ${formatPosition(context.position_ms)}`
      : "当前视频";
  }
  if (context.course_id) return "当前课程";
  return "全部课程";
}

function suggestionsFor(context: AssistantContext) {
  if (context.video_id) {
    return [
      { label: "概括当前视频", prompt: "概括当前视频的主要内容" },
      { label: "查找例题", prompt: "查找当前视频里讲例题的位置" },
      { label: "梳理知识重点", prompt: "梳理当前视频最重要的知识点" },
    ];
  }
  if (context.course_id) {
    return [
      { label: "概览这门课程", prompt: "概览这门课程的主要内容" },
      { label: "查看视频目录", prompt: "列出这门课程的全部视频" },
      { label: "查找课程重点", prompt: "查找这门课程最重要的知识点" },
    ];
  }
  return [
    { label: "查看我的课程", prompt: "列出我的全部课程" },
    { label: "规划下一步学习", prompt: "根据我的课程规划下一步学习" },
    { label: "切换到夜间模式", prompt: "切换到夜间模式" },
  ];
}

export function AssistantPanel({
  context,
  onNavigate,
  compact = false,
  bottomNavigationVisible = false,
}: {
  context: AssistantContext;
  /** 打开视频 / 跳转由外层执行——只有它知道播放器和路由。 */
  onNavigate: (action: AssistantAction) => void;
  /** 跟随 Home 的实际布局档位；窄窗口即使是桌面 UA 也应使用抽屉。 */
  compact?: boolean;
  /** 课程库窄屏下底部有 56px 主导航，抽屉和入口都要避开它。 */
  bottomNavigationVisible?: boolean;
}) {
  const { open, side, setOpen, dock } = useAssistantUi();
  const [initialSession] = useState(readAssistantSession);
  const [input, setInput] = useState(initialSession.draft);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [turns, setTurns] = useState<Turn[]>(initialSession.turns);
  const [history, setHistory] = useState<AssistantMessage[]>(initialSession.history);
  const [conversationEpoch, setConversationEpoch] = useState(0);
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<DragSession | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const suppressLauncherClickRef = useRef(false);
  const activeRequestRef = useRef<string | null>(null);
  const locallyStoppedRequestsRef = useRef(new Set<string>());
  const historyRef = useRef(initialSession.history);
  const conversationEpochRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);
  const focusLauncherAfterCloseRef = useRef(false);
  // iPad 宽屏有足够空间使用可拖动面板；真正决定布局的是视口档位，不是触屏 UA。
  const mobile = compact || (isMobile() && !isTablet());
  const [position, setPosition] = useState<PanelPosition>(() => initialPanelPosition(side));
  const [dockTop, setDockTop] = useState(initialDockTop);
  /** 拖动中球的落点；不在拖动时为 null，球回到 left-3 / right-3 + dockTop 的贴边位置。 */
  const [launcherPosition, setLauncherPosition] = useState<PanelPosition | null>(null);
  const [dragging, setDragging] = useState(false);
  const [snapSide, setSnapSide] = useState<DockSide | null>(null);
  const setThemePref = useTheme((state) => state.setPref);
  const pendingInlineAsk = useInlineAsk((state) => state.pending);
  const clearInlineAsk = useInlineAsk((state) => state.clear);
  const scopeLabel = contextLabel(context);

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
        video_id: turn.context.video_id,
        title: "原视频",
        at_ms: action.at_ms,
      });
      return;
    }
    onNavigate(action);
  }

  useEffect(() => {
    // 新一轮出来就滚到底，否则答案出现在视野外，看起来像没反应。
    // 直接写 scrollTop 而不是 scrollTo：后者在 jsdom 里根本不存在，
    // 而这行代码没必要为了一个平滑动画就在测试环境里炸掉。
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [turns, busy]);

  useEffect(() => {
    const pendingQuestion = turns.find((turn) => turn.pending)?.question ?? "";
    writeAssistantSession({ turns, history, draft: input || pendingQuestion });
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
    const draft = `请解释这段文稿${source}：\n\n${pendingInlineAsk.text}`;
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

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
      const requestId = activeRequestRef.current;
      if (requestId) void ipc.assistant.cancel(requestId);
    },
    [],
  );

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
    setInput("");
    setBusy(true);
    setStopping(false);
    setError("");
    // 长工具链可能要等几十秒；问题先进入对话，让用户立即确认自己发出了什么。
    setTurns((prev) => [
      ...prev,
      {
        id: turnId,
        question,
        answer: "",
        actions: [],
        tools: [],
        turns: 1,
        canceled: false,
        actionResults: [],
        pending: true,
        context: { ...context },
      },
    ]);
    try {
      const reply = await ipc.assistant.ask(question, context, historyAtSend, requestId);
      const locallyStopped = locallyStoppedRequestsRef.current.has(requestId);
      const canceled = reply.canceled || locallyStopped;
      // 后端也会清空取消轮次的动作；这里再守一次，避免旧后端或兼容端点让用户
      // 点停以后仍切主题、导航或冒出待确认操作。
      const actions = canceled ? [] : reply.actions;
      // 请求期间用户仍可能执行旧确认卡。那类结果已经追加进 historyRef，不能被
      // 此次回复的整包 history 覆盖；取消轮次自身则不能进入下一轮上下文。
      const actionEventsDuringRequest = historyRef.current.slice(historyAtSend.length);
      const nextHistory = [
        ...(canceled ? historyAtSend : reply.history),
        ...actionEventsDuringRequest,
      ];
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
                answer: locallyStopped && !reply.canceled ? "" : reply.answer,
                actions,
                tools: reply.tools_used,
                turns: reply.turns,
                canceled,
                pending: false,
              }
            : turn,
        ),
      );
    } catch (e) {
      // 把问题放回输入框：让用户能直接重发，而不是重新打一遍。
      setTurns((prev) => prev.filter((turn) => turn.id !== turnId));
      setInput(question);
      setError(humanizeError(e));
    } finally {
      locallyStoppedRequestsRef.current.delete(requestId);
      if (activeRequestRef.current === requestId) {
        activeRequestRef.current = null;
        setBusy(false);
        setStopping(false);
      }
    }
  }

  async function copyAnswer(turn: Turn) {
    if (!turn.answer || !navigator.clipboard?.writeText) {
      setError("当前环境无法使用剪贴板");
      return;
    }
    try {
      await navigator.clipboard.writeText(turn.answer);
      setCopiedTurnId(turn.id);
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedTurnId(null), 1500);
    } catch (e) {
      setError(`复制失败：${humanizeError(e)}`);
    }
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
    historyRef.current = [
      ...historyRef.current,
      { role: "assistant", content: `（界面操作结果：${message}）` },
    ];
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
    if (busy) return;
    const nextEpoch = conversationEpochRef.current + 1;
    conversationEpochRef.current = nextEpoch;
    setConversationEpoch(nextEpoch);
    setTurns([]);
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
    ? "fixed inset-x-0 z-40 h-[70dvh] max-h-[calc(100dvh-56px)] rounded-t-2xl border-t"
    : "fixed z-40 h-[min(720px,calc(100dvh-2rem))] w-[360px] max-w-[calc(100vw-2rem)] rounded-2xl border";
  const panelBottom = bottomNavigationVisible
    ? "calc(56px + env(safe-area-inset-bottom, 0px))"
    : "env(safe-area-inset-bottom, 0px)";

  return (
    <>
      {!open && (
      <button
        ref={launcherRef}
        type="button"
        aria-label="打开助手"
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
    <aside
      ref={panelRef}
      aria-label="助手"
      hidden={!open}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        collapseToNearestSide(true);
      }}
      data-dragging={mobile ? undefined : dragging}
      data-snap-side={mobile ? undefined : snapSide ?? undefined}
      style={mobile ? { bottom: panelBottom } : { left: position.x, top: position.y }}
      className={`${open ? "flex" : "hidden"} ${shell} flex-col border-[var(--border-subtle)] bg-[var(--surface-panel)] shadow-[var(--shadow-pop)] ${
        snapSide ? "ring-2 ring-[var(--accent)]" : ""
      }`}
    >
      <header className="flex items-center gap-1 border-b border-[var(--border-subtle)] px-3 py-2">
        {mobile ? (
          <>
            <Sparkles className="h-4 w-4 flex-none text-[var(--accent)]" />
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="text-sm font-medium text-[var(--text-strong)]">助手</span>
              <span
                aria-label={`当前提问范围：${scopeLabel}`}
                className="truncate text-[11px] text-[var(--text-faint)]"
              >
                {scopeLabel}
              </span>
            </span>
          </>
        ) : (
          <button
            type="button"
            aria-label="拖动助手面板"
            title="拖动助手面板"
            onPointerDown={beginPanelDrag}
            onKeyDown={movePanelWithKeyboard}
            className="-ml-1 flex min-w-0 flex-1 touch-none select-none items-center gap-1.5 rounded-md px-1 py-1 text-left cursor-grab active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <GripHorizontal className="h-4 w-4 flex-none text-[var(--text-faint)]" />
            <Sparkles className="h-4 w-4 flex-none text-[var(--accent)]" />
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="text-sm font-medium text-[var(--text-strong)]">助手</span>
              <span
                aria-label={`当前提问范围：${scopeLabel}`}
                className="truncate text-[11px] font-normal text-[var(--text-faint)]"
              >
                {scopeLabel}
              </span>
            </span>
          </button>
        )}
        {(turns.length > 0 || history.length > 0) && (
          <Button
            size="icon"
            variant="ghost"
            aria-label="新对话"
            title="新对话"
            disabled={busy}
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
            aria-label={side === "left" ? "停靠到右边" : "停靠到左边"}
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
          aria-label="收起助手"
          onClick={() => collapseToNearestSide()}
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        className="flex-1 space-y-3 overflow-y-auto px-3 py-3"
      >
        {turns.length === 0 && !busy && !error && (
          <div className="flex min-h-full items-center">
            <div className="grid w-full gap-2">
              {suggestionsFor(context).map((suggestion) => (
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

            {turn.answer && (
              <div className="flex justify-start">
                {/* 回答天然带 Markdown（列表、加粗、公式），当纯文本铺出来满屏 ** 和 -，
                    比没有格式还难读。复用问答面板那套渲染器，顺带白拿了
                    公式渲染和 [mm:ss] 可点击跳转。 */}
                <div className="group max-w-[92%]">
                  <div className="break-words rounded-2xl rounded-bl-sm border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-normal)]">
                    {renderMarkdown(turn.answer, (ms) =>
                      navigateFromTurn(turn, { kind: "seek_to", at_ms: ms }),
                    )}
                  </div>
                  <div className="mt-0.5 flex h-7 items-center">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={copiedTurnId === turn.id ? "已复制" : "复制回答"}
                      title={copiedTurnId === turn.id ? "已复制" : "复制回答"}
                      onClick={() => void copyAnswer(turn)}
                      className="h-7 w-7 text-[var(--text-faint)]"
                    >
                      {copiedTurnId === turn.id ? (
                        <Check className="h-3.5 w-3.5 text-[var(--status-ok)]" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            <AssistantActionList
              actions={turn.actions}
              onNavigate={(action) => navigateFromTurn(turn, action)}
              onResult={(message) => recordActionResult(turn.id, message, conversationEpoch)}
            />

            {turn.actionResults.length > 0 && (
              <div aria-label="操作记录" className="space-y-1">
                {turn.actionResults.map((result, index) => (
                  <p
                    key={`${turn.id}-result-${index}`}
                    className="flex items-start gap-1.5 text-[11px] text-[var(--text-muted)]"
                  >
                    <span
                      className="mt-[0.45em] h-1.5 w-1.5 flex-none rounded-full bg-[var(--accent)]"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 break-words">操作结果：{result}</span>
                  </p>
                ))}
              </div>
            )}

            {turn.turns > 1 && (
              // 来回几次要让人看见：每一轮的工具结果都留在上下文里，花销是乘法涨的。
              <p className="text-[10px] text-[var(--text-faint)]">来回 {turn.turns} 轮</p>
            )}
            {turn.canceled && (
              <p className="flex items-center gap-1 text-[10px] text-[var(--text-faint)]">
                <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
                已停止，未继续执行
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
            <span>{stopping ? "正在停止…" : "正在思考并调用工具…"}</span>
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

      <div className="flex items-end gap-2 border-t border-[var(--border-subtle)] p-2">
        <textarea
          ref={inputRef}
          aria-label="对助手说"
          rows={1}
          value={input}
          placeholder="想做什么？"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter 发送、Shift+Enter 换行。输入法组词时的 Enter 不能当发送，
            // 否则中文用户每选一次候选词就误发一条。
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          className="max-h-24 flex-1 resize-none rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2.5 py-2 text-sm text-[var(--text-strong)] outline-none placeholder:text-[var(--text-faint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        />
        {busy ? (
          <Button
            size="icon"
            variant="outline"
            aria-label="停止生成"
            title="停止生成"
            disabled={stopping}
            onClick={stop}
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </Button>
        ) : (
          <Button
            size="icon"
            aria-label="发送"
            disabled={!input.trim()}
            onClick={() => void send()}
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </aside>
    </>
  );
}
