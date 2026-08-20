import * as React from "react";
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

  return (
    <div
      ref={menuRef}
      role="menu"
      className={cn("ca-menu", className)}
      onKeyDown={handleKeyDown}
      {...props}
    >
      {children}
    </div>
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
