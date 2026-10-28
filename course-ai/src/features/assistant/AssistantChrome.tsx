import {
  useEffect,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  GripHorizontal,
  History as HistoryIcon,
  LoaderCircle,
  MessageSquarePlus,
  MessageSquareText,
  MoreHorizontal,
  X,
} from "lucide-react";
import { Button } from "@/ui/button";
import { Menu, MenuItem } from "@/ui/menu";
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH } from "@/stores/assistant";
import { toggleShortcutLabel } from "./assistantPanelModel";

/**
 * 助手面板的外壳部件：收起时的浮球、宽度抓手、标题栏。
 * 都是受控视图，状态留在 AssistantPanel。
 */

type DockSide = "left" | "right";

export function AssistantLauncher({
  launcherRef,
  mobile,
  side,
  busy,
  hasUnread,
  style,
  inWorkbench,
  hasCustomPosition,
  onClick,
  onPointerDown,
}: {
  launcherRef: RefObject<HTMLButtonElement | null>;
  mobile: boolean;
  side: DockSide;
  busy: boolean;
  hasUnread: boolean;
  style: CSSProperties;
  inWorkbench: boolean;
  hasCustomPosition: boolean;
  onClick: () => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      ref={launcherRef}
      type="button"
      data-tour="assistant"
      aria-label={t("assistant.openAssistant")}
      aria-busy={busy || undefined}
      title={t("assistant.openWithShortcut", { shortcut: toggleShortcutLabel() })}
      data-dock-side={mobile ? undefined : side}
      onClick={onClick}
      onPointerDown={onPointerDown}
      style={style}
      // 底色用 surface-panel 而不是 surface-card：深色主题下 card 是一层 3.5% 的白，
      // 它是给「铺在某块不透明面板上的卡片」用的。球和面板都浮在整个应用之上，
      // 底下没有那层不透明的东西——直接用就成了一块透明玻璃，字浮在页面内容上。
      // hover 同理不能换成 card-hover（7% 的白），一悬停球就没了。
      className={
        mobile
          ? // 手机：44px、半透明磨砂底、只留一层很轻的浮起，不再是一枚带大投影的白圆钮。
            `ca-touch-44 fixed z-40 grid h-11 w-11 place-items-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-panel)]/85 shadow-[var(--shadow-raise)] backdrop-blur transition-colors hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] motion-reduce:transition-none ${inWorkbench ? "ca-workbench-assistant-launcher" : ""}`
          : `ca-touch-44 fixed z-40 grid h-14 w-14 touch-none select-none cursor-grab active:cursor-grabbing place-items-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-panel)] shadow-[var(--shadow-pop)] transition hover:scale-105 hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] motion-reduce:transition-none motion-reduce:hover:scale-100 ${
              hasCustomPosition ? "" : side === "left" ? "left-3" : "right-3"
            }`
      }
    >
      {busy ? (
        <LoaderCircle className="h-5 w-5 animate-spin text-[var(--accent-text)]" aria-hidden="true" />
      ) : (
        <MessageSquareText className="h-5 w-5 text-[var(--text-normal)]" aria-hidden="true" />
      )}
      {hasUnread && !busy && (
        <span
          aria-hidden="true"
          className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface-panel)] bg-[var(--accent)]"
        />
      )}
    </button>
  );
}

/**
 * 朝向屏幕内侧的那条边是宽度抓手。固定宽度对一段带列表和公式的长回答太窄了。
 * 抓取区全高、骑在边框上（内外各 6px），不占内容宽度；可见反馈就是面板那条边本身：
 * 指示层与面板外框重合、同半径圆角，悬停/拖动/聚焦时整条边连同上下圆角一起点亮。
 */
export function PanelResizeHandle({
  side,
  panelWidth,
  resizing,
  onPointerDown,
  onKeyDown,
}: {
  side: DockSide;
  panelWidth: number;
  resizing: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("assistant.adjustWidth")}
      aria-valuenow={panelWidth}
      aria-valuemin={MIN_PANEL_WIDTH}
      aria-valuemax={MAX_PANEL_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      data-resizing={resizing || undefined}
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
  );
}

export function AssistantHeader({
  mobile,
  side,
  historyButtonRef,
  menuRef,
  menuTriggerRef,
  showHistoryButton,
  historyOpen,
  showNewChat,
  controlsDisabled,
  menuOpen,
  canCopyConversation,
  onToggleHistory,
  onNewChat,
  onMenuOpenChange,
  onMoveToSide,
  onCopyConversation,
  onCollapse,
  onDragStart,
  onDragKeyDown,
}: {
  mobile: boolean;
  side: DockSide;
  historyButtonRef: RefObject<HTMLButtonElement | null>;
  menuRef: RefObject<HTMLDivElement | null>;
  menuTriggerRef: RefObject<HTMLButtonElement | null>;
  showHistoryButton: boolean;
  historyOpen: boolean;
  showNewChat: boolean;
  /** 生成中、执行确认卡、删会话时，历史与新会话都不可用。 */
  controlsDisabled: boolean;
  menuOpen: boolean;
  canCopyConversation: boolean;
  onToggleHistory: () => void;
  onNewChat: () => void;
  onMenuOpenChange: (open: boolean) => void;
  onMoveToSide: (side: DockSide) => void;
  onCopyConversation: () => void;
  onCollapse: () => void;
  onDragStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onDragKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useTranslation();
  const closeMenu = () => {
    onMenuOpenChange(false);
    requestAnimationFrame(() => menuTriggerRef.current?.focus());
  };

  // 头部「⋯」菜单：点菜单外任意处收起。
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      if (menuTriggerRef.current?.contains(event.target as Node)) return;
      onMenuOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen, menuRef, menuTriggerRef, onMenuOpenChange]);

  const title = (
    <span id="assistant-panel-title" className="min-w-0 flex-1 text-sm font-medium text-[var(--text-strong)]">
      {t("assistant.title")}
    </span>
  );

  return (
    <header className="flex items-center gap-1 border-b border-[var(--border-faint)] px-3 py-2">
      {/* 提问范围原先挤在标题旁边，11px 一行灰字。它决定了「这个视频」指的是谁，
          该待在你打字的地方，而不是滚动区顶上那条最容易被忽略的边。 */}
      {mobile ? (
        title
      ) : (
        <button
          type="button"
          aria-label={t("assistant.dragPanel")}
          title={t("assistant.dragPanel")}
          onPointerDown={onDragStart}
          onKeyDown={onDragKeyDown}
          className="-ml-1 flex min-w-0 flex-1 touch-none select-none items-center gap-1.5 rounded-md px-1 py-1 text-left cursor-grab active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <GripHorizontal className="h-4 w-4 flex-none text-[var(--text-faint)]" />
          {title}
        </button>
      )}
      {showHistoryButton && (
        <Button
          ref={historyButtonRef}
          size="icon"
          variant="ghost"
          aria-label={historyOpen ? t("assistant.closeConversationHistory") : t("assistant.conversationHistory")}
          title={historyOpen ? t("assistant.closeConversationHistory") : t("assistant.conversationHistory")}
          aria-expanded={historyOpen}
          aria-controls="assistant-conversation-history"
          disabled={controlsDisabled}
          onClick={onToggleHistory}
          className="ca-touch-44"
        >
          <HistoryIcon className="h-4 w-4" />
        </Button>
      )}
      {showNewChat && (
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("assistant.newChat")}
          title={t("assistant.newChat")}
          disabled={controlsDisabled}
          onClick={onNewChat}
          className="ca-touch-44"
        >
          <MessageSquarePlus className="h-4 w-4" />
        </Button>
      )}
      {/* 换边是一辈子用不了几次的一次性设置，收进「⋯」；
          常驻按钮只留高频的：历史、新会话、关闭。 */}
      {!mobile && (
        <div ref={menuRef} className="relative">
          <Button
            ref={menuTriggerRef}
            size="icon"
            variant="ghost"
            aria-label={t("assistant.headerMenu")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={t("assistant.headerMenu")}
            onClick={() => onMenuOpenChange(!menuOpen)}
            className="ca-touch-44"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
          {menuOpen && (
            <Menu
              aria-label={t("assistant.headerMenu")}
              onClose={closeMenu}
              // 触发它的按钮只有 36px 宽；不给宽度时菜单被压成按钮那么窄，中文一字一行。
              className="absolute right-0 top-full z-30 mt-1 w-max min-w-[160px] whitespace-nowrap"
            >
              <MenuItem
                className="flex items-center gap-2"
                onClick={() => {
                  onMoveToSide(side === "left" ? "right" : "left");
                  closeMenu();
                }}
              >
                {side === "left" ? (
                  <ChevronRight className="h-3.5 w-3.5" />
                ) : (
                  <ChevronLeft className="h-3.5 w-3.5" />
                )}
                {side === "left" ? t("assistant.dockRight") : t("assistant.dockLeft")}
              </MenuItem>
              <MenuItem
                className="flex items-center gap-2"
                disabled={!canCopyConversation}
                onClick={() => {
                  onCopyConversation();
                  closeMenu();
                }}
              >
                <ClipboardCopy className="h-3.5 w-3.5" />
                {t("assistant.copyConversation")}
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
        onClick={onCollapse}
        className="ca-touch-44"
      >
        <X className="h-4 w-4" />
      </Button>
    </header>
  );
}
