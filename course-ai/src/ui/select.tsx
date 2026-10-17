import type { ChangeEvent, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 下拉框。原生 <select> 在 macOS / iOS 的 WKWebView 里会画成系统的灰色弹出按钮（带上下
 * 双箭头），和应用里扁平的控件格格不入；Chromium 里又是另一副样子。这里统一去掉原生外观、
 * 自绘箭头。展开时仍是系统原生的选择器（iOS 滚轮、Android 列表），可访问性也不变。
 */

const FIELD =
  "w-full cursor-pointer appearance-none rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] py-2 pl-3 pr-9 text-sm text-[var(--text-strong)] outline-none transition focus-visible:border-[var(--accent-text)] disabled:cursor-not-allowed disabled:opacity-60";

/** 表单里的下拉框：与输入框同款外观，占满一行。 */
export function Select({
  id,
  value,
  onChange,
  disabled,
  className,
  "aria-label": ariaLabel,
  children,
}: {
  id?: string;
  /** undefined 时不受控（显示第一项），与原生 <select> 一致。 */
  value: string | undefined;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("relative", className)}>
      <select
        id={id}
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-label={ariaLabel}
        className={FIELD}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]"
      />
    </div>
  );
}

/**
 * 工具条里的下拉框：外观与旁边的图标按钮一致（无边框、悬停浅底），宽度只按当前选项的文字。
 * 显示的是一段普通文字 + 小箭头，真正的 <select> 透明地铺在上面接住点击——不依赖只有
 * Chromium 支持的 field-sizing，WebKit 里也不会按最长的选项撑宽、挤到旁边的按钮。
 */
export function GhostSelect<T extends string>({
  value,
  onChange,
  options,
  disabled,
  "aria-label": ariaLabel,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  disabled?: boolean;
  "aria-label": string;
  className?: string;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <span
      className={cn(
        "ca-touch-44 relative inline-flex h-8 flex-none items-center justify-center gap-0.5 whitespace-nowrap rounded-md px-1.5 text-xs text-[var(--text-muted)] transition-colors",
        "hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]",
        "has-[select:focus-visible]:outline has-[select:focus-visible]:outline-2 has-[select:focus-visible]:outline-[var(--focus-ring)]",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      <span aria-hidden="true">{current?.label ?? value}</span>
      <ChevronDown aria-hidden="true" className="h-3 w-3 flex-none opacity-70" />
      <select
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
        // 只铺满外框：触控放大加在外框上，免得透明层伸出去抢走旁边按钮的点击。
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}
