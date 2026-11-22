import type { HTMLAttributes, ReactNode } from "react";
import type { CourseColor } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 「板书与荧光笔」里的小记号：时间戳芯片、荧光笔高亮、键帽、标签。
 * 样式在 styles/design.css。黄色只表示「课上的某个时刻」，别拿时间戳芯片当普通徽章用。
 */

/** 毫秒 → m:ss / h:mm:ss（等宽数字）。 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${String(m).padStart(2, "0")}:${ss}`;
}

const PLAY_GLYPH = (
  <svg viewBox="0 0 10 10" aria-hidden="true">
    <path d="M2 1.2v7.6L8.6 5z" />
  </svg>
);

/**
 * 时间戳芯片：点一下跳到那一秒。没有 onSeek 时是不可点的安静版本（列表里的时长）。
 * label 可在时间后面补一句（「24:05 · 回到这一秒」）。
 */
export function Timestamp({
  ms,
  onSeek,
  label,
  quiet = false,
  className,
}: {
  ms: number;
  onSeek?: (ms: number) => void;
  label?: ReactNode;
  quiet?: boolean;
  className?: string;
}) {
  const text = formatClock(ms);
  if (!onSeek || quiet) {
    return (
      <span className={cn("ca-time", quiet && "quiet", className)}>
        {text}
        {label ? <> · {label}</> : null}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cn("ca-time", className)}
      onClick={() => onSeek(ms)}
      aria-label={label ? `${text} ${typeof label === "string" ? label : ""}`.trim() : undefined}
    >
      {PLAY_GLYPH}
      {text}
      {label ? <> · {label}</> : null}
    </button>
  );
}

/** 荧光笔高亮：画在文字下半部，跨行时每行各画一段。 */
export function Mark({ children, className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("ca-mark", className)} {...props}>
      {children}
    </span>
  );
}

/** 键帽：快捷键提示。 */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn("ca-kbd", className)}>{children}</kbd>;
}

export type TagColor = CourseColor | "gray";

/** 方角标签：课程、知识点、用户标签。颜色取标签色板的 bg/text 配对，两种主题都 ≥4.9:1。 */
export function Tag({
  color = "gray",
  size = "md",
  children,
  className,
}: {
  color?: TagColor | null;
  size?: "sm" | "md";
  children: ReactNode;
  className?: string;
}) {
  const c = color ?? "gray";
  return (
    <span
      className={cn("ca-tag", size === "sm" && "sm", className)}
      style={{ background: `var(--tag-${c}-bg)`, color: `var(--tag-${c}-text)` }}
    >
      {children}
    </span>
  );
}
