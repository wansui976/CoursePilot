import { cn } from "@/lib/utils";

/** 系统设置风格的开关：role="switch" + aria-checked，44px 触摸区由 ca-touch-44 提供。 */
export function Switch({
  id,
  checked,
  onCheckedChange,
  className,
  "aria-label": ariaLabel,
}: {
  id?: string;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "ca-touch-44 relative inline-flex h-[22px] w-[38px] flex-none items-center rounded-full border transition-colors duration-150",
        checked
          ? "border-[var(--accent)] bg-[var(--accent)]"
          : "border-[var(--border-subtle)] bg-[var(--surface-card-hover)]",
        className,
      )}
    >
      <span
        className={cn(
          "block h-[16px] w-[16px] rounded-full bg-white shadow transition-transform duration-150",
          checked ? "translate-x-[19px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}
