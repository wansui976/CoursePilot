import { cn } from "@/lib/utils";

/** 单块骨架占位（脉冲动画在减少动效偏好下由全局规则自动停掉）。 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-md bg-[var(--surface-card-hover)]",
        className,
      )}
    />
  );
}

/** 多行正文骨架：模拟一段加载中的文字，最后一行短一些更自然。 */
export function TextSkeleton({
  lines = 4,
  className,
  label = "加载中…",
}: {
  lines?: number;
  className?: string;
  label?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn("space-y-2.5 p-4", className)}
    >
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn("h-3.5", i === lines - 1 ? "w-2/3" : "w-full")}
        />
      ))}
    </div>
  );
}
