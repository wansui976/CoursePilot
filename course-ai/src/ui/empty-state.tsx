import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div role="status" className={cn("ca-empty-state", className)}>
      <h2 className="ca-empty-state-title">{title}</h2>
      {description && <p className="ca-empty-state-description">{description}</p>}
      {action && <div className="ca-empty-state-action">{action}</div>}
    </div>
  );
}

/**
 * 空态只有一句标题、一句说明和可选的动作——不放图标方块（居中大图标 + 两行字是模板化
 * 界面的标志，图标也说不出比标题更多的信息）。
 */

/**
 * 面板里的空态：在剩余空间中居中。
 *
 * 「这里还什么都没有」在学习工作台的每个页签都会遇到——新导入的视频，摘要、章节、题目、
 * 课件、片段全是空的。这个时刻此前每个面板各写各的：有的左对齐贴在顶上，有的居中，
 * 字色一半用 faint 一半用 muted，只有课件页手搓了个图标。同一件事看上去像六个人做的。
 * 收到这里之后，加空态只需给图标和两句话。
 */
export function PanelEmptyState(props: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-[220px] items-center justify-center px-4 py-8">
      <EmptyState {...props} />
    </div>
  );
}
