/** 设置页通用的行、分组与字段组件（仿系统设置的分组卡片风格）。 */
import type { ChangeEvent, ReactNode } from "react";
import { Check, ChevronDown, X } from "lucide-react";

export const FIELD =
  "w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-strong)] outline-none transition placeholder:text-[var(--text-faint)]";

/** 统一外观的下拉框：去掉原生箭头，加自定义 chevron，和输入框风格一致。 */
export function Select({
  id,
  value,
  onChange,
  children,
}: {
  id?: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        onChange={onChange}
        className={`${FIELD} cursor-pointer appearance-none pr-9`}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
    </div>
  );
}

export function Group({
  header,
  footnote,
  children,
}: {
  header?: string;
  footnote?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mb-7">
      {header && (
        <h3 className="mb-2 px-4 ca-t-sm font-semibold text-[var(--text-muted)]">
          {header}
        </h3>
      )}
      <div className="divide-y divide-[var(--border-faint)] overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)]">
        {children}
      </div>
      {footnote && (
        <p className="mt-2 px-4 text-xs leading-relaxed text-[var(--text-muted)]">{footnote}</p>
      )}
    </div>
  );
}

/** 一行设置：标签在左、控件在右（紧凑）。hint 作为标签下的小字说明。 */
export function Row({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[44px] flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <label
          htmlFor={htmlFor}
          className="block text-sm font-medium tracking-[-0.01em] text-[var(--text-strong)]"
        >
          {label}
        </label>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">{hint}</p>}
      </div>
      <div className="w-full sm:w-auto sm:flex-none">{children}</div>
    </div>
  );
}

/** 整行铺开的设置（控件较宽或多行时用）：标签在上、控件占满整行。 */
export function StackRow({
  label,
  hint,
  htmlFor,
  children,
}: {
  label?: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="px-4 py-3.5">
      {label && (
        <label
          htmlFor={htmlFor}
          className="block text-sm font-medium tracking-[-0.01em] text-[var(--text-strong)]"
        >
          {label}
        </label>
      )}
      {hint && <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">{hint}</p>}
      <div className={label || hint ? "mt-2" : ""}>{children}</div>
    </div>
  );
}

export function SavedBadge({ text, isError = false }: { text: string; isError?: boolean }) {
  if (!text) return null;
  return (
    <span
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        isError
          ? "bg-[var(--status-err-bg)] text-[var(--status-err)]"
          : "bg-[var(--status-ok-bg)] text-[var(--status-ok)]"
      }`}
    >
      {isError ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}
      {text}
    </span>
  );
}
