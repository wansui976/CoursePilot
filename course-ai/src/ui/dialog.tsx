import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { useOptionalShell } from "@/app/shell";
import { useKeyboardInset } from "@/lib/useKeyboardInset";
import { cn } from "@/lib/utils";

const SIZE = {
  xs: "max-w-xs",
  sm: "max-w-sm",
  md: "max-w-[420px]",
  lg: "max-w-[460px]",
  /** 左右分栏的浏览型对话框（如笔记历史）。 */
  xl: "max-w-[760px]",
} as const;

/**
 * 应用内统一的居中模态框（基于 Radix Dialog）。
 *
 * 统一的是各处原先各写一遍的部分：遮罩与面板外观、进出动画挂钩（.ca-dialog-overlay 与
 * [role=dialog][data-state]）、「忙时锁住」——`locked` 为真时 Esc、点遮罩、onOpenChange
 * 都不会关闭——以及打开/关闭时的焦点落点。
 *
 * 始终带 aria-modal="true"：Home 的 Android 返回键靠它找到最上层模态并转成 Esc。
 *
 * 窄屏（手机、平板竖屏的叠放布局）默认呈现为底部弹层：贴底、满宽、顶部抓手，
 * 单手够得着；往下拖过一段距离松手即关闭（locked 时拖不动）。弹层跟随软键盘上移。
 */
export function Modal({
  open,
  onOpenChange,
  locked = false,
  title,
  icon,
  description,
  trigger,
  size = "md",
  tone = "default",
  role = "dialog",
  overlayTestId,
  portalContainer,
  initialFocusRef,
  returnFocusTo,
  className,
  titleClassName,
  descriptionClassName,
  headerAction,
  presentation = "auto",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 进行中不可中断（导入、恢复等）：屏蔽所有关闭途径。 */
  locked?: boolean;
  title: ReactNode;
  icon?: ReactNode;
  description?: ReactNode;
  /** 可选触发按钮（asChild 渲染），拿到 aria-expanded / aria-controls。 */
  trigger?: ReactNode;
  size?: keyof typeof SIZE;
  /** warning：破坏性确认，用警示色描边。 */
  tone?: "default" | "warning";
  role?: "dialog" | "alertdialog";
  overlayTestId?: string;
  portalContainer?: HTMLElement | null;
  /** 打开后聚焦的元素；不给则由 Radix 聚焦第一个可聚焦元素。 */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** 关闭后焦点回到哪里；不给则回到打开前的焦点（Radix 默认）。 */
  returnFocusTo?: () => HTMLElement | null | undefined;
  className?: string;
  titleClassName?: string;
  descriptionClassName?: string;
  /** 标题行右侧（如关闭按钮）。 */
  headerAction?: ReactNode;
  /** auto：叠放布局（手机）用底部弹层，其余居中。 */
  presentation?: "auto" | "center" | "sheet";
  children: ReactNode;
}) {
  const shell = useOptionalShell();
  const sheet = presentation === "sheet" || (presentation === "auto" && Boolean(shell?.isPhoneDevice));
  const block = (event: Event) => {
    if (locked) event.preventDefault();
  };
  const drag = useSheetDrag({ enabled: sheet && !locked, onDismiss: () => onOpenChange(false) });
  const keyboard = useKeyboardInset();
  const heading = (
    <Dialog.Title
      className={cn(
        "flex items-center gap-2 text-sm font-semibold text-[var(--text-strong)]",
        titleClassName,
      )}
    >
      {icon}
      {title}
    </Dialog.Title>
  );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && locked) return;
        onOpenChange(next);
      }}
    >
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal container={portalContainer ?? undefined}>
        <Dialog.Overlay
          data-testid={overlayTestId}
          className={cn(
            "ca-dialog-overlay fixed inset-0 z-50 flex justify-center bg-black/50",
            sheet ? "items-end p-0" : "items-center p-4",
          )}
        >
          <Dialog.Content
            role={role}
            aria-modal="true"
            {...(description ? {} : { "aria-describedby": undefined })}
            onOpenAutoFocus={
              initialFocusRef
                ? (event) => {
                    event.preventDefault();
                    initialFocusRef.current?.focus();
                  }
                : undefined
            }
            onCloseAutoFocus={
              returnFocusTo
                ? (event) => {
                    event.preventDefault();
                    returnFocusTo()?.focus();
                  }
                : undefined
            }
            onEscapeKeyDown={block}
            onInteractOutside={block}
            onPointerDownOutside={block}
            data-presentation={sheet ? "sheet" : "center"}
            ref={drag.contentRef}
            style={
              sheet
                ? {
                    // 底部留出 Home 指示条；键盘弹起时整块抬到键盘上沿。
                    paddingBottom: "calc(var(--safe-bottom) + 1rem)",
                    marginBottom: keyboard || undefined,
                    maxHeight: `calc(100dvh - var(--safe-top) - 1rem - ${keyboard}px)`,
                  }
                : undefined
            }
            className={cn(
              "w-full overflow-y-auto border bg-[var(--surface-panel)] p-4 text-[var(--text-normal)] shadow-[var(--shadow-pop)]",
              sheet
                ? "ca-sheet max-w-none rounded-t-2xl border-x-0 border-b-0 pt-0"
                : cn("max-h-[calc(100dvh-2rem)] rounded-2xl sm:p-5", SIZE[size]),
              tone === "warning" ? "border-[var(--status-warn)]" : "border-[var(--border-subtle)]",
              className,
            )}
          >
            {sheet && (
              <div
                aria-hidden="true"
                data-testid="sheet-handle"
                onPointerDown={drag.onPointerDown}
                onPointerMove={drag.onPointerMove}
                onPointerUp={drag.onPointerUp}
                onPointerCancel={drag.onPointerUp}
                className="sticky top-0 z-10 -mx-4 mb-1 flex touch-none justify-center bg-[var(--surface-panel)] pb-2 pt-2.5"
              >
                <span className="h-1 w-10 rounded-full bg-[var(--border-control)]" />
              </div>
            )}
            {headerAction ? (
              <div className="mb-3 flex items-center justify-between gap-3">
                {heading}
                {headerAction}
              </div>
            ) : (
              heading
            )}
            {description && (
              <Dialog.Description
                className={cn(
                  "mt-1 break-words text-xs leading-relaxed text-[var(--text-muted)]",
                  descriptionClassName,
                )}
              >
                {description}
              </Dialog.Description>
            )}
            {children}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** 关闭按钮等需要 Radix 关闭语义的元素。 */
export const ModalClose = Dialog.Close;

/** 往下拖这么远（或甩得够快）松手就关。 */
const SHEET_DISMISS_PX = 96;
const SHEET_DISMISS_VELOCITY = 0.6; // px/ms

/** 底部弹层的下拉关闭：拖动时直接改 transform（不过 React），松手决定关闭还是弹回。 */
function useSheetDrag({ enabled, onDismiss }: { enabled: boolean; onDismiss: () => void }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [start] = useState(() => ({ y: 0, t: 0, id: -1, dy: 0 }));

  function setOffset(dy: number, animate: boolean) {
    const el = contentRef.current;
    if (!el) return;
    el.style.transition = animate ? "transform 0.2s cubic-bezier(0.2, 0, 0, 1)" : "none";
    el.style.transform = dy > 0 ? `translateY(${dy}px)` : "";
  }

  return {
    contentRef,
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
      if (!enabled) return;
      start.y = event.clientY;
      start.t = performance.now();
      start.id = event.pointerId;
      start.dy = 0;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 测试环境 / 旧 WebKit 不支持也无妨。
      }
    },
    onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
      if (!enabled || event.pointerId !== start.id) return;
      start.dy = Math.max(0, event.clientY - start.y);
      setOffset(start.dy, false);
    },
    onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
      if (!enabled || event.pointerId !== start.id) return;
      start.id = -1;
      const elapsed = Math.max(1, performance.now() - start.t);
      if (start.dy > SHEET_DISMISS_PX || start.dy / elapsed > SHEET_DISMISS_VELOCITY) {
        // 先清掉 inline transform：退场动画从 translateY(0) 起播，带着拖动偏移会先弹回顶部再下滑。
        setOffset(0, false);
        onDismiss();
        return;
      }
      setOffset(0, true);
    },
  };
}
