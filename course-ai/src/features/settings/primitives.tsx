/** 设置页通用的行、分组与字段组件（仿系统设置的分组卡片风格）。 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, Info, X } from "lucide-react";

export const FIELD =
  "w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-strong)] outline-none transition placeholder:text-[var(--text-faint)]";

/** 设置页的下拉框与其它表单共用 ui/select（去掉原生外观、自绘箭头）。 */
export { Select } from "@/ui/select";

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

/**
 * 设置项的说明：不再在标签下铺一段小字（满屏都是说明，真正的开关反而找不到），
 * 收成标签旁的一个 ⓘ，点开才弹出。
 *
 * 弹层挂到 body 上、按按钮的位置 fixed 定位：设置分组卡片是 overflow:hidden，放在行里会被裁掉。
 * 点外面、按 Esc、页面滚动都会收起（滚动后位置就对不上了，不如直接收）。
 */
function HintButton({ label, hint }: { label: string; hint: ReactNode }) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const open = anchor !== null;
  const close = useCallback(() => setAnchor(null), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (popRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 只收说明，不让 Esc 再冒泡去关掉整个设置页。
      event.preventDefault();
      event.stopPropagation();
      close();
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [close, open]);

  // 弹层贴在按钮下方、左缘对齐；右边放不下就往左挪，始终留在视口里。
  const width = Math.min(320, (typeof window === "undefined" ? 1024 : window.innerWidth) - 24);
  const left = anchor
    ? Math.max(12, Math.min(anchor.left - 10, window.innerWidth - width - 12))
    : 0;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="ca-hint-button"
        aria-label={t("settings.hintFor", { label })}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(event) =>
          setAnchor(open ? null : event.currentTarget.getBoundingClientRect())
        }
      >
        <Info aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      {anchor &&
        createPortal(
          <div
            ref={popRef}
            id={id}
            role="note"
            aria-label={t("settings.hintFor", { label })}
            className="ca-hint-pop"
            style={{ top: anchor.bottom + 6, left, width }}
          >
            {hint}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * 设置项的标签 + 可选的 ⓘ 说明 + 可选的状态。
 *
 * 说明（hint）是「这一项是干什么的」，收进 ⓘ；状态（status）是「现在怎么样」——密钥配没配、
 * 检查更新的结果、刚操作完的反馈——藏起来就等于没告诉用户，始终写在标签下。
 */
function RowLabel({
  label,
  hint,
  status,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  status?: ReactNode;
  htmlFor?: string;
}) {
  return (
    <>
      <div className="flex items-center gap-1">
        <label
          htmlFor={htmlFor}
          className="block text-sm font-medium tracking-[-0.01em] text-[var(--text-strong)]"
        >
          {label}
        </label>
        {hint && <HintButton label={label} hint={hint} />}
      </div>
      {status && <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">{status}</p>}
    </>
  );
}

/** 一行设置：标签在左、控件在右（紧凑）。hint 收在标签旁的 ⓘ 里，点开看；status 常显在标签下。 */
export function Row({
  label,
  hint,
  status,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  status?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[44px] flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <RowLabel label={label} hint={hint} status={status} htmlFor={htmlFor} />
      </div>
      <div className="w-full sm:w-auto sm:flex-none">{children}</div>
    </div>
  );
}

/** 整行铺开的设置（控件较宽或多行时用）：标签在上、控件占满整行。 */
export function StackRow({
  label,
  hint,
  status,
  htmlFor,
  children,
}: {
  label?: string;
  hint?: ReactNode;
  status?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="px-4 py-3.5">
      {label ? (
        <RowLabel label={label} hint={hint} status={status} htmlFor={htmlFor} />
      ) : (
        // 没有标签的整行（极少）：没地方挂 ⓘ，说明照旧写在上面。
        hint && <p className="text-xs leading-relaxed text-[var(--text-muted)]">{hint}</p>
      )}
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
