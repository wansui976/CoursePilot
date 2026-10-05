import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode, RefObject } from "react";
import { cn } from "@/lib/utils";

const SIZE = {
  xs: "max-w-xs",
  sm: "max-w-sm",
  md: "max-w-[420px]",
  lg: "max-w-[460px]",
} as const;

/**
 * 应用内统一的居中模态框（基于 Radix Dialog）。
 *
 * 统一的是各处原先各写一遍的部分：遮罩与面板外观、进出动画挂钩（.ca-dialog-overlay 与
 * [role=dialog][data-state]）、「忙时锁住」——`locked` 为真时 Esc、点遮罩、onOpenChange
 * 都不会关闭——以及打开/关闭时的焦点落点。
 *
 * 始终带 aria-modal="true"：Home 的 Android 返回键靠它找到最上层模态并转成 Esc。
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
  children: ReactNode;
}) {
  const block = (event: Event) => {
    if (locked) event.preventDefault();
  };
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
          className="ca-dialog-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
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
            className={cn(
              "max-h-[calc(100dvh-2rem)] w-full overflow-y-auto rounded-2xl border bg-[var(--surface-panel)] p-4 text-[var(--text-normal)] shadow-[var(--shadow-pop)] sm:p-5",
              SIZE[size],
              tone === "warning" ? "border-[var(--status-warn)]" : "border-[var(--border-subtle)]",
              className,
            )}
          >
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
