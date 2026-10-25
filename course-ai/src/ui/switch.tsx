import { cn } from "@/lib/utils";

/** 系统设置风格的开关：role="switch" + aria-checked。
 *  44px 触摸区由 .ca-switch 的透明伪元素补足，不能借用 ca-touch-44：那条规则用
 *  min-width/min-height 撑命中区，会把 38×22 的药丸拉成 44×44 的圆——触屏上开与关
 *  都成了一个带白点的圆球，像单选按钮而不是开关。 */
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
        "ca-switch inline-flex h-[22px] w-[38px] flex-none items-center rounded-full border transition-colors duration-150",
        checked
          ? "border-[var(--accent)] bg-[var(--accent)]"
          : "border-[var(--border-subtle)] bg-[var(--surface-card-hover)]",
        className,
      )}
    >
      <span
        className={cn(
          "block h-[16px] w-[16px] rounded-full bg-white shadow-[var(--shadow-raise)] transition-transform duration-150",
          checked ? "translate-x-[19px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}
