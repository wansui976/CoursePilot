import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  isWideWorkbench,
  PLAYER_MIN_WIDTH,
  STUDY_PANEL_MIN,
  STUDY_RESIZER_WIDTH,
} from "./workbenchLayout";
import { BookOpenText, ChevronLeft, ChevronRight, Minimize2 } from "lucide-react";
import { readVideoResumeState, writeVideoResumeState } from "@/lib/resumeState";

const PANEL_WIDTH_STORAGE_KEY = "course-ai-study-panel-width";
const STUDY_PANEL_MAX = 720;
// 学习面板最小宽度：保证核心资料页签和正文都可正常阅读。
const STUDY_PANEL_DEFAULT = 480;
/** 分隔线拖到比最小宽度再窄这么多时松手，就收起面板（VS Code 式拖到底收起）。 */
const COLLAPSE_SNAP = 96;

function clampWidth(width: number, max = STUDY_PANEL_MAX) {
  return Math.min(max, Math.max(STUDY_PANEL_MIN, width));
}

function readGlobalPanelWidth() {
  if (typeof window === "undefined") return STUDY_PANEL_DEFAULT;
  // 没存过要走默认：Number(null) 是 0（有限数），不先判空会被夹成下限。
  const raw = window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
  if (!raw) return STUDY_PANEL_DEFAULT;
  const saved = Number(raw);
  return Number.isFinite(saved) ? clampWidth(saved) : STUDY_PANEL_DEFAULT;
}

/** 面板宽度与收起状态按视频记忆；该视频没存过宽度时沿用全局最近一次的宽度。 */
function readVideoLayout(videoId: string) {
  const saved = readVideoResumeState(videoId);
  return {
    width: saved.studyPanelWidth != null ? clampWidth(saved.studyPanelWidth) : readGlobalPanelWidth(),
    collapsed: saved.studyPanelCollapsed ?? false,
  };
}

/** 给定容器宽度下面板能拿到的上限：至少给播放器留 PLAYER_MIN_WIDTH。 */
function maxPanelWidthFor(containerWidth: number) {
  return containerWidth > 0
    ? clampWidth(containerWidth - PLAYER_MIN_WIDTH - STUDY_RESIZER_WIDTH)
    : STUDY_PANEL_MAX;
}

/**
 * 学习工作台的两栏布局：左播放器列、右学习面板，中间可拖分隔条。
 *
 * 宽屏（左右能同时放下面板下限与播放器下限）时分栏，可拖宽、可整列收起；
 * 否则上下叠放。宽度、收起状态由本组件持有并持久化，外层只给内容和可用宽度。
 */
export function WorkspaceLayout({
  videoId,
  shellWide,
  availableWidth,
  player,
  panel,
}: {
  videoId: string;
  /** 外壳是否处于桌面式左右布局（触控竖屏等情况一律叠放）。 */
  shellWide: boolean;
  /** 工作台实际可用宽度（已扣除 rail / 侧栏）。 */
  availableWidth: number;
  player: ReactNode;
  panel: ReactNode;
}) {
  const { t } = useTranslation();
  const [layoutVideoId, setLayoutVideoId] = useState(videoId);
  const [panelWidth, setPanelWidth] = useState(() => readVideoLayout(videoId).width);
  // 面板整体收起：专注看片时把右栏整个藏掉（不是拖到下限）。
  const [collapsedPref, setCollapsedPref] = useState(() => readVideoLayout(videoId).collapsed);
  const [isResizing, setIsResizing] = useState(false);
  // 拖动期间的实时宽度（用 ref，不触发重渲染；松手才提交到 state）。
  const liveWidthRef = useRef(panelWidth);
  // 拖拽 resize 的监听清理：中途卸载（快速切换视频/返回）时也要摘掉 window 上的监听，
  // 否则残留的 pointermove/pointerup 会引用已解绑的 DOM 节点。
  const resizeAbortRef = useRef<AbortController | null>(null);

  // 换视频：播放器不能重挂（不用 key），渲染期按新视频的记忆重置布局。
  if (layoutVideoId !== videoId) {
    const next = readVideoLayout(videoId);
    setLayoutVideoId(videoId);
    setPanelWidth(next.width);
    setCollapsedPref(next.collapsed);
  }

  useEffect(() => () => resizeAbortRef.current?.abort(), []);

  // 专注阅读：播放器让位、学习面板占满工作台，正文居中（参考 Apple 图书的阅读视图）。
  // 播放器只是隐藏，不卸载——正在播放的课可以继续听。不存储，是一次性的阅读状态。
  const [readingFocusPref, setReadingFocus] = useState(false);
  const readingFocus = isWideWorkbench(shellWide, availableWidth) && readingFocusPref;
  useEffect(() => {
    if (!readingFocus) return;
    function onKeyDown(event: KeyboardEvent) {
      // 菜单、对话框等先处理过的 Esc 不再拿来退出。
      if (event.key === "Escape" && !event.defaultPrevented) setReadingFocus(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [readingFocus]);

  const maxWidthForLayout = maxPanelWidthFor(availableWidth);
  const isWide = isWideWorkbench(shellWide, availableWidth);
  const widthForLayout = isResizing
    ? liveWidthRef.current
    : Math.min(panelWidth, maxWidthForLayout);
  // 收起只在分栏时有意义：叠放布局下面板总是展示。
  // 专注阅读时面板必然展开（就是要读它）。
  const collapsed = isWide && collapsedPref && !readingFocus;

  function persistWidth(width: number) {
    window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(width));
    writeVideoResumeState(videoId, { studyPanelWidth: width });
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    // 拖动期间直接改 .ca-wb 上的样式（不触发 React 重渲染、不写 storage），
    // 松手时才提交一次 state + 持久化，避免每次 pointermove 重渲染整个工作台。
    const wb = event.currentTarget.parentElement as HTMLElement | null;
    const startX = event.clientX;
    const startWidth = widthForLayout;
    liveWidthRef.current = startWidth;
    // 冻结右侧面板内容宽度：拖动期间内容不随列宽连续 reflow（长文稿尤其卡），
    // 松手后（去掉 is-resizing-panel 类）再一次性回流到最终宽度。
    wb?.style.setProperty("--panel-frozen-width", `${startWidth}px`);
    setIsResizing(true);
    const maxPanel = maxPanelWidthFor(wb?.clientWidth ?? 0);
    // rAF 合帧：一帧内多次 pointermove 只写一次（即只触发一次网格重排）。
    let raf = 0;
    let pendingX = startX;
    let collapseOnRelease = false;
    const apply = () => {
      raf = 0;
      const raw = startWidth - (pendingX - startX);
      const next = clampWidth(raw, maxPanel);
      liveWidthRef.current = next;
      // 拖过收起阈值：面板变淡提示「松手就收起」，往回拖即恢复。
      collapseOnRelease = raw < STUDY_PANEL_MIN - COLLAPSE_SNAP;
      if (collapseOnRelease) wb?.setAttribute("data-collapse-pending", "");
      else wb?.removeAttribute("data-collapse-pending");
      // 内联写 grid-template-columns（须与 globals.css 的 .ca-wb 列定义一致），
      // 而不是每帧改 --study-panel-width：自定义属性向整棵工作台子树继承，每帧一写
      // 会让全量文稿 DOM（数千节点）做样式重算——文稿打开时拖动卡顿的来源；
      // contain 只隔离布局/绘制，挡不住继承失效。内联属性只失效 .ca-wb 自身样式。
      wb?.style.setProperty("grid-template-columns", `minmax(0, 1fr) 1px ${next}px`);
    };
    const onMove = (move: PointerEvent) => {
      pendingX = move.clientX;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onUp = () => {
      if (raf) cancelAnimationFrame(raf);
      setIsResizing(false);
      wb?.removeAttribute("data-collapse-pending");
      if (collapseOnRelease) {
        // 收起时保留拖动前的宽度：再展开回到原来的样子。
        liveWidthRef.current = startWidth;
        wb?.style.removeProperty("grid-template-columns");
        setCollapsed(true);
        resizeAbortRef.current?.abort();
        resizeAbortRef.current = null;
        return;
      }
      const finalWidth = liveWidthRef.current;
      setPanelWidth(finalWidth);
      // 先把最终宽度写回稳态变量、再撤掉拖动期的内联覆盖：与 React 提交先后无关，
      // 计算宽度始终等于 finalWidth，不会闪动。
      wb?.style.setProperty("--study-panel-width", `${finalWidth}px`);
      wb?.style.removeProperty("grid-template-columns");
      persistWidth(finalWidth);
      // abort() 一并摘掉下面用同一 signal 注册的 pointermove/pointerup。
      resizeAbortRef.current?.abort();
      resizeAbortRef.current = null;
    };
    // 用 AbortController 统一管理监听：onUp 里 abort，组件卸载时的 effect 也 abort，
    // 两条路径都能确保监听不残留。
    resizeAbortRef.current?.abort();
    const controller = new AbortController();
    resizeAbortRef.current = controller;
    window.addEventListener("pointermove", onMove, { signal: controller.signal });
    window.addEventListener("pointerup", onUp, { signal: controller.signal });
  }

  function commitWidth(nextWidth: number, container: HTMLElement | null) {
    const next = clampWidth(nextWidth, maxPanelWidthFor(container?.clientWidth ?? 0));
    liveWidthRef.current = next;
    setPanelWidth(next);
    container?.style.setProperty("--study-panel-width", `${next}px`);
    persistWidth(next);
  }

  function resizeFromKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const container = event.currentTarget.parentElement as HTMLElement | null;
    const step = event.shiftKey ? 72 : 24;
    let next: number | null = null;

    if (event.key === "ArrowLeft") next = liveWidthRef.current + step;
    else if (event.key === "ArrowRight") next = liveWidthRef.current - step;
    else if (event.key === "Home") next = STUDY_PANEL_MIN;
    else if (event.key === "End") next = maxPanelWidthFor(container?.clientWidth ?? 0);
    else if (event.key === "Enter") next = STUDY_PANEL_DEFAULT;

    if (next == null) return;
    event.preventDefault();
    commitWidth(next, container);
  }

  // 面板收起/展开：收起时右栏整体隐藏（不占宽度），展开恢复上次宽度。
  function setCollapsed(next: boolean) {
    setCollapsedPref(next);
    writeVideoResumeState(videoId, { studyPanelCollapsed: next });
  }

  return (
    <div
      aria-label={t("home.workbenchLayout")}
      data-layout={isWide ? "wide" : "stacked"}
      data-panel-collapsed={collapsed ? "" : undefined}
      data-reading-focus={readingFocus ? "" : undefined}
      className={`ca-wb ${isResizing ? "is-resizing-panel" : ""}`}
      style={
        isWide
          ? ({ "--study-panel-width": `${collapsed ? 0 : widthForLayout}px` } as CSSProperties)
          : undefined
      }
    >
      {player}
      {isWide && !collapsed && (
        <div
          role="separator"
          aria-label={t("home.resizeStudy")}
          aria-orientation="vertical"
          aria-valuemin={STUDY_PANEL_MIN}
          aria-valuemax={Math.round(maxWidthForLayout)}
          aria-valuenow={Math.round(widthForLayout)}
          aria-valuetext={t("home.pixelValue", { width: Math.round(widthForLayout) })}
          tabIndex={0}
          title={t("home.resizeHint")}
          className={`ca-resizer ${isResizing ? "is-resizing" : ""}`}
          onPointerDown={beginResize}
          // 双击分隔条：把面板宽度复位到默认值，省去手动拖回。
          onDoubleClick={(event) =>
            commitWidth(STUDY_PANEL_DEFAULT, event.currentTarget.parentElement)
          }
          onKeyDown={resizeFromKeyboard}
        />
      )}
      {!collapsed && (
        <aside aria-label={t("home.studyPanel")} className="ca-panel-col">
          {panel}
        </aside>
      )}
      {isWide && (
        // 工作台工具：钉在标题行右端；专注阅读时移到面板右上角，只留「退出」。
        <div className="ca-wb-tools">
          {readingFocus ? (
            <button
              type="button"
              onClick={() => setReadingFocus(false)}
              aria-label={t("home.exitReadingFocus")}
              title={t("home.exitReadingFocus")}
              className="ca-wb-tool ca-touch-44"
            >
              <Minimize2 aria-hidden="true" className="h-[18px] w-[18px]" />
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setReadingFocus(true)}
                aria-label={t("home.readingFocus")}
                title={t("home.readingFocus")}
                className="ca-wb-tool ca-touch-44"
              >
                <BookOpenText aria-hidden="true" className="h-[18px] w-[18px]" />
              </button>
              <button
                type="button"
                onClick={() => setCollapsed(!collapsed)}
                aria-label={collapsed ? t("home.expandStudyPanel") : t("home.collapseStudyPanel")}
                aria-pressed={!collapsed}
                title={collapsed ? t("home.expandStudyPanel") : t("home.collapseStudyPanel")}
                className="ca-wb-tool ca-touch-44"
              >
                {/* 学习面板在右边：收起是往右推（>），展开是拉回来（<）。与左侧栏同一套箭头。 */}
                {collapsed ? (
                  <ChevronLeft aria-hidden="true" className="h-[18px] w-[18px]" />
                ) : (
                  <ChevronRight aria-hidden="true" className="h-[18px] w-[18px]" />
                )}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
