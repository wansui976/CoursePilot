import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div role="status" className={cn("ca-empty-state", className)}>
      {icon && <div className="ca-empty-state-icon">{icon}</div>}
      <h2 className="ca-empty-state-title">{title}</h2>
      {description && <p className="ca-empty-state-description">{description}</p>}
      {action && <div className="ca-empty-state-action">{action}</div>}
    </div>
  );
}
