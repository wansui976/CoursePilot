import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type BadgeTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "processing";

const toneClass: Record<BadgeTone, string> = {
  neutral: "neutral",
  success: "success",
  warning: "warning",
  danger: "danger",
  processing: "processing",
};

export function Badge({
  tone = "neutral",
  dot = true,
  className,
  children,
  ...props
}: {
  tone?: BadgeTone;
  dot?: boolean;
  className?: string;
  children: ReactNode;
} & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("ca-badge", toneClass[tone], className)} {...props}>
      {dot && <span aria-hidden="true" className="dot" />}
      {children}
    </span>
  );
}
