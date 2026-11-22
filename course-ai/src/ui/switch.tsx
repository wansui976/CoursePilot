import { cn } from "@/lib/utils";

/** 系统设置风格的开关：role="switch" + aria-checked。
 *  44px 触摸区由 .ca-switch 的透明伪元素补足，不能借用 ca-touch-44：那条规则用
 *  min-width/min-height 撑命中区，会把 32×18 的药丸拉成 44×44 的圆——触屏上开与关
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
        "ca-switch inline-flex h-[18px] w-[32px] flex-none items-center rounded-full transition-colors duration-150",
        checked
          ? "bg-[var(--accent)]"
          : "bg-[var(--border-strong)]",
        className,
      )}
    >
      <span
        className={cn(
          "block h-[14px] w-[14px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)]",
          checked ? "translate-x-[16px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}
