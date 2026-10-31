import * as React from "react";
import { createPortal } from "react-dom";
import { useOptionalShell } from "@/app/shell";
import { cn } from "@/lib/utils";

type MenuProps = React.HTMLAttributes<HTMLDivElement> & {
  onClose?: () => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
};

export function Menu({
  className,
  children,
  onClose,
  onKeyDown,
  triggerRef,
  ...props
}: MenuProps) {
  const menuRef = React.useRef<HTMLDivElement>(null);

  const enabledItems = React.useCallback(() => {
    if (!menuRef.current) return [];
    return Array.from(
      menuRef.current.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])',
      ),
    );
  }, []);

  React.useLayoutEffect(() => {
    enabledItems()[0]?.focus();
  }, [enabledItems]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;

    if (event.key === "Tab") {
      // Tab follows the document order instead of the menu's roving focus model.
      // Closing without preventing the event lets the browser choose the next target.
      onClose?.();
      return;
    }

    const items = enabledItems();
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex: number | null = null;

    if (event.key === "ArrowDown") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = currentIndex < 0
        ? items.length - 1
        : (currentIndex - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
      triggerRef?.current?.focus();
      return;
    } else {
      return;
    }

    if (nextIndex == null || !items[nextIndex]) return;
    event.preventDefault();
    items[nextIndex].focus();
  }

  // 叠放布局（手机）：菜单改成贴底的操作弹层，挂到 body 上，避免被卡片的 overflow 裁掉。
  // 调用方都按「点在菜单外」收起菜单（document 上的 pointerdown）；挂出去以后菜单不再是
  // 调用方容器的子孙，所以在菜单根上截住 pointerdown，点菜单项不会被当成点外面。
  const sheet = Boolean(useOptionalShell()?.isPhoneDevice);
  const menu = (
    <div
      ref={menuRef}
      role="menu"
      data-sheet={sheet || undefined}
      className={cn("ca-menu", sheet ? "ca-menu-sheet" : className)}
      onKeyDown={handleKeyDown}
      {...props}
      // 展开在 props 之后：手机上必须截住 pointerdown，否则点菜单项会被当成「点外面」立刻关掉。
      onPointerDown={sheet ? (event) => event.stopPropagation() : props.onPointerDown}
    >
      {children}
    </div>
  );
  if (!sheet || typeof document === "undefined") return menu;
  return createPortal(
    <>
      <div
        aria-hidden="true"
        className="ca-menu-scrim"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onClose?.()}
      />
      {menu}
    </>,
    document.body,
  );
}

export function MenuItem({
  className,
  tone = "default",
  type = "button",
  tabIndex = -1,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "default" | "danger";
}) {
  return (
    <button
      type={type}
      role="menuitem"
      tabIndex={tabIndex}
      className={cn("ca-menu-item", tone === "danger" && "danger", className)}
      {...props}
    />
  );
}
