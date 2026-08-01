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
  ChevronLeft,
  ChevronRight,
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
import { humanizeError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import { isMobile } from "@/lib/platform";
import { type DockSide, useAssistantUi } from "@/stores/assistant";
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
const DOCK_STRIP_HEIGHT = 112;
const KEYBOARD_MOVE_STEP = 24;
const DRAG_START_DISTANCE = 4;

interface PanelPosition {
  x: number;
  y: number;
}

interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  panelWidth: number;
  panelHeight: number;
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
  return Math.max(VIEWPORT_GAP, height - DOCK_STRIP_HEIGHT - 24);
}

interface Turn {
  id: string;
  question: string;
  answer: string;
  actions: AssistantAction[];
  tools: string[];
  /** 这一轮来回了几次。花了多少钱要让人看得见。 */
  turns: number;
  canceled: boolean;
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
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [history, setHistory] = useState<AssistantMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<DragSession | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const activeRequestRef = useRef<string | null>(null);
  const mobile = compact || isMobile();
  const [position, setPosition] = useState<PanelPosition>(() => initialPanelPosition(side));
  const [dockTop, setDockTop] = useState(initialDockTop);
  const [dragging, setDragging] = useState(false);
  const [snapSide, setSnapSide] = useState<DockSide | null>(null);
  const setThemePref = useTheme((state) => state.setPref);

  // 回答里的 [mm:ss] 点了就跳。助手常说「在 12:30 讲到」，让它可点是顺手的事。
  const onSeek = (ms: number) => onNavigate({ kind: "seek_to", at_ms: ms });

  useEffect(() => {
    // 新一轮出来就滚到底，否则答案出现在视野外，看起来像没反应。
    // 直接写 scrollTop 而不是 scrollTo：后者在 jsdom 里根本不存在，
    // 而这行代码没必要为了一个平滑动画就在测试环境里炸掉。
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [turns, busy]);

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
        clamp(current, VIEWPORT_GAP, viewport.height - DOCK_STRIP_HEIGHT - VIEWPORT_GAP),
      );
    };

    window.addEventListener("resize", keepInsideViewport);
    return () => window.removeEventListener("resize", keepInsideViewport);
  }, [mobile]);

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
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

  function dockToStrip(nextSide: DockSide, y: number) {
    const { height } = viewportSize();
    const panel = measurePanel();
    const centeredTop = y + panel.height / 2 - DOCK_STRIP_HEIGHT / 2;
    setDockTop(
      clamp(centeredTop, VIEWPORT_GAP, height - DOCK_STRIP_HEIGHT - VIEWPORT_GAP),
    );
    dock(nextSide);
    setOpen(false);
  }

  function openFromDock() {
    const panel = measurePanel();
    const centeredTop = dockTop + DOCK_STRIP_HEIGHT / 2 - panel.height / 2;
    setPosition(positionAtSide(side, centeredTop));
    setOpen(true);
  }

  function collapseToNearestSide() {
    const panel = measurePanel();
    const nearestSide: DockSide =
      position.x + panel.width / 2 < viewportSize().width / 2 ? "left" : "right";
    dockToStrip(nearestSide, position.y);
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
    const nearLeft = rawX <= EDGE_SNAP_DISTANCE;
    const nearRight =
      rawX + session.panelWidth >= viewport.width - EDGE_SNAP_DISTANCE;
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
            ? viewport.width - session.panelWidth
            : clamp(
                rawX,
                VIEWPORT_GAP,
                viewport.width - session.panelWidth - VIEWPORT_GAP,
              ),
      y: clamp(
        rawY,
        VIEWPORT_GAP,
        viewport.height - session.panelHeight - VIEWPORT_GAP,
      ),
    };
    session.snapSide = nextSnapSide;
    setPosition(session.position);
    setSnapSide(nextSnapSide);
    return session;
  }

  function beginPanelDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (mobile || (event.pointerType === "mouse" && event.button !== 0)) return;

    dragCleanupRef.current?.();
    const panel = measurePanel();
    const rect = panelRef.current?.getBoundingClientRect();
    const panelLeft = rect?.width ? rect.left : position.x;
    const panelTop = rect?.height ? rect.top : position.y;
    const handle = event.currentTarget;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - panelLeft,
      offsetY: event.clientY - panelTop,
      panelWidth: panel.width,
      panelHeight: panel.height,
      moved: false,
      position,
      snapSide: null,
    };
    setDragging(true);
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

  function movePanelWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (mobile) return;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      dockToStrip(event.key === "Home" ? "left" : "right", position.y);
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
    activeRequestRef.current = requestId;
    setInput("");
    setBusy(true);
    setStopping(false);
    setError("");
    try {
      const reply = await ipc.assistant.ask(question, context, history, requestId);
      // 后端也会清空取消轮次的动作；这里再守一次，避免旧后端或兼容端点让用户
      // 点停以后仍切主题、导航或冒出待确认操作。
      const actions = reply.canceled ? [] : reply.actions;
      setHistory(reply.history);
      // 主题当场生效。它无破坏性、一眼可见，再让人点一次只是把一步变两步。
      for (const action of actions) {
        if (action.kind === "set_theme") setThemePref(action.pref);
      }
      setTurns((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          question,
          answer: reply.answer,
          actions,
          tools: reply.tools_used,
          turns: reply.turns,
          canceled: reply.canceled,
        },
      ]);
    } catch (e) {
      // 把问题放回输入框：让用户能直接重发，而不是重新打一遍。
      setInput(question);
      setError(humanizeError(e));
    } finally {
      if (activeRequestRef.current === requestId) {
        activeRequestRef.current = null;
        setBusy(false);
        setStopping(false);
      }
    }
  }

  async function stop() {
    const requestId = activeRequestRef.current;
    if (!requestId || stopping) return;
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
    setTurns([]);
    setHistory([]);
    setInput("");
    setError("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  if (!open) {
    const mobileBottom = bottomNavigationVisible
      ? "calc(56px + env(safe-area-inset-bottom, 0px) + 24px)"
      : "24px";
    return (
      <button
        type="button"
        aria-label="打开助手"
        data-dock-side={mobile ? undefined : side}
        onClick={openFromDock}
        style={mobile ? { bottom: mobileBottom } : { top: dockTop }}
        className={
          mobile
            ? "ca-touch-44 fixed right-4 z-40 grid h-12 w-12 place-items-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-lg transition-colors hover:bg-[var(--surface-card-hover)] motion-reduce:transition-none"
            : `fixed z-40 grid h-28 w-11 place-items-center border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-lg transition-colors hover:bg-[var(--surface-card-hover)] motion-reduce:transition-none ${
                side === "left"
                  ? "left-0 rounded-r-lg border-l-0"
                  : "right-0 rounded-l-lg border-r-0"
              }`
        }
      >
        <span className="flex flex-col items-center gap-3" aria-hidden="true">
          <Sparkles className="h-5 w-5 text-[var(--accent)]" />
          {mobile ? null : side === "left" ? (
            <ChevronRight className="h-4 w-4 text-[var(--text-faint)]" />
          ) : (
            <ChevronLeft className="h-4 w-4 text-[var(--text-faint)]" />
          )}
        </span>
      </button>
    );
  }

  const shell = mobile
    ? "fixed inset-x-0 z-40 h-[70vh] rounded-t-2xl border-t"
    : "fixed z-40 h-[min(720px,calc(100dvh-2rem))] w-[360px] max-w-[calc(100vw-2rem)] rounded-2xl border";
  const mobileBottom = bottomNavigationVisible
    ? "calc(56px + env(safe-area-inset-bottom, 0px))"
    : "0px";

  return (
    <aside
      ref={panelRef}
      aria-label="助手"
      data-dragging={mobile ? undefined : dragging}
      data-snap-side={mobile ? undefined : snapSide ?? undefined}
      style={mobile ? { bottom: mobileBottom } : { left: position.x, top: position.y }}
      className={`${shell} flex flex-col border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-xl ${
        snapSide ? "ring-2 ring-[var(--accent)]" : ""
      }`}
    >
      <header className="flex items-center gap-1 border-b border-[var(--border-subtle)] px-3 py-2">
        {mobile ? (
          <>
            <Sparkles className="h-4 w-4 flex-none text-[var(--accent)]" />
            <span className="flex-1 text-sm font-medium text-[var(--text-strong)]">助手</span>
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
            <span className="truncate text-sm font-medium text-[var(--text-strong)]">助手</span>
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
          onClick={collapseToNearestSide}
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
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
                <div className="max-w-[92%] break-words rounded-2xl rounded-bl-sm border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-normal)]">
                  {renderMarkdown(turn.answer, onSeek)}
                </div>
              </div>
            )}

            <AssistantActionList actions={turn.actions} onNavigate={onNavigate} />

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
          className="max-h-24 flex-1 resize-none rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2.5 py-2 text-sm text-[var(--text-strong)] outline-none placeholder:text-[var(--text-faint)]"
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
  );
}
