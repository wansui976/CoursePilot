import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  clampPanelWidth,
  MIN_PANEL_WIDTH,
  useAssistantUi,
  type DockSide,
} from "@/stores/assistant";

/**
 * 助手面板的「窗口化」：浮动拖动、贴边吸附、宽度调整、停靠切换、移动端抽屉手势。
 * 从 AssistantPanel 拆出的纯交互层——不含对话状态，只管这块面板在屏幕上的几何。
 */

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
const KEYBOARD_RESIZE_STEP = 32;
const DRAG_START_DISTANCE = 4;

export interface PanelPosition {
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

/** 浮球默认离窗口底边的距离：要越过学习面板右下角那排操作钮（bottom-3 + 36px 高）
 *  再留出间隙，否则默认位置正好盖住「生成 / 导出」这些按钮。 */
const LAUNCHER_BOTTOM_CLEARANCE = 72;

function initialDockTop() {
  const { height } = viewportSize();
  return Math.max(VIEWPORT_GAP, height - LAUNCHER_SIZE - LAUNCHER_BOTTOM_CLEARANCE);
}

export function usePanelWindowing({
  mobile,
  panelRef,
  focusInput,
}: {
  /** 手机端没有「边缘停靠」的余地，改用底部抽屉——不参与桌面窗口化。 */
  mobile: boolean;
  panelRef: React.RefObject<HTMLElement | null>;
  /** 打开/停靠后聚焦输入框；输入框归面板的对话层管，这里只拿回调。 */
  focusInput: () => void;
}) {
  const { side, width, dock, setWidth, setOpen } = useAssistantUi();
  const [position, setPosition] = useState<PanelPosition>(() => initialPanelPosition(side));
  const [dockTop, setDockTop] = useState(initialDockTop);
  /** 拖动中球的落点；不在拖动时为 null，球回到 left-3 / right-3 + dockTop 的贴边位置。 */
  const [launcherPosition, setLauncherPosition] = useState<PanelPosition | null>(null);
  const [dragging, setDragging] = useState(false);
  const [snapSide, setSnapSide] = useState<DockSide | null>(null);
  /** 拖动内侧边框时的实时宽度。松手才写进偏好，免得一次拖动往磁盘上写几十遍。 */
  const [resizeWidth, setResizeWidth] = useState<number | null>(null);
  /** 移动抽屉下滑关闭手势的实时位移；null 表示未在拖拽。 */
  const [sheetDragY, setSheetDragY] = useState<number | null>(null);
  const dragRef = useRef<DragSession | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  /** 球的点击压制标志：拖完浏览器补发的那个 click 要吃掉，不能顺手打开面板。 */
  const suppressLauncherClickRef = useRef(false);
  /** 收起后焦点是否该回到球上；由 dockToStrip 写、面板层在收起后消费。 */
  const focusLauncherAfterCloseRef = useRef(false);

  const measurePanel = useCallback(function measurePanel() {
    const fallback = fallbackPanelSize();
    const rect = panelRef.current?.getBoundingClientRect();
    return {
      width: rect?.width || fallback.width,
      height: rect?.height || fallback.height,
    };
  }, [panelRef]);

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
    focusInput();
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

  // 视口变化时把面板和球都夹回屏幕里。
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
  }, [mobile, measurePanel]);

  // 卸载时摘掉还没走完的拖动监听。
  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  return {
    position,
    dockTop,
    launcherPosition,
    dragging,
    snapSide,
    /** 渲染宽度：拖动中的实时值优先，松手后落回偏好值。 */
    panelWidth: resizeWidth ?? width,
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
  };
}
