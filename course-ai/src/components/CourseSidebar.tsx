import {
  ClipboardList,
  Library,
  Loader2,
  Moon,
  Plus,
  Settings,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Button } from "@/components/ui/button";
import { CourseList, useCreateCourse } from "@/components/CourseList";
import { cn } from "@/lib/utils";

export function CourseSidebar({
  selectedCourseId,
  onSelect,
  onOpenSettings,
  onToggleTheme,
  theme,
  themeToggleLabel,
  queueOpen = false,
  queueCount = 0,
  onToggleQueue,
  onOpenRecycleBin,
  onCloseDrawer,
  className,
  variant = "sidebar",
}: {
  selectedCourseId: string | null;
  onSelect: (id: string) => void;
  onOpenSettings?: () => void;
  onToggleTheme?: () => void;
  theme: "dark" | "light";
  themeToggleLabel: string;
  queueOpen?: boolean;
  queueCount?: number;
  onToggleQueue?: () => void;
  onOpenRecycleBin?: () => void;
  onCloseDrawer?: () => void;
  className?: string;
  variant?: "sidebar" | "screen";
}) {
  const { createCourse, creatingCourse, createError } = useCreateCourse();

  return (
    <aside
      aria-label="课程侧栏"
      className={cn(
        variant === "screen" ? "ca-course-screen" : "ca-side",
        className,
      )}
    >
      <div className="flex-none">
        <div className="ca-brand">
          <div className="logo">
            <Library className="h-4 w-4" />
          </div>
          <div className="label">
            <h1>课程库</h1>
          </div>
          {onCloseDrawer && (
            <button
              type="button"
              aria-label="关闭课程库"
              className="ca-icon-btn ml-auto"
              onClick={onCloseDrawer}
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {variant === "screen" && onOpenRecycleBin && (
            <button
              type="button"
              aria-label="回收站"
              title="回收站"
              className="ca-icon-btn ml-auto"
              onClick={onOpenRecycleBin}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button
          aria-label="新建课程"
          className="ca-new-btn"
          size="sm"
          variant="outline"
          disabled={creatingCourse}
          onClick={() => void createCourse()}
        >
          {creatingCourse ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {creatingCourse ? "创建中" : "新建课程"}
        </Button>
        {createError && <ErrorNote className="mt-2" error={createError} />}
        {onToggleQueue && (
          <Button
            aria-label="处理队列"
            className={`ca-nav-item mt-2 w-full justify-start ${queueOpen ? "active" : ""}`}
            size="sm"
            variant="ghost"
            onClick={onToggleQueue}
          >
            <ClipboardList className="h-4 w-4" />
            处理队列
            {queueCount > 0 && (
              <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-[11px] leading-none text-primary">
                {queueCount}
              </span>
            )}
          </Button>
        )}
      </div>
      <div className="ca-nav-label">
        我的课程
      </div>
      <div className="ca-nav">
        <CourseList
          selectedCourseId={selectedCourseId}
          onSelect={onSelect}
          queueOpen={queueOpen}
        />
      </div>
      {variant !== "screen" && (
        <div className="mt-4 flex flex-none flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
          <Button
            size="icon"
            variant="ghost"
            onClick={onToggleTheme}
            title={themeToggleLabel}
            aria-label={themeToggleLabel}
          >
            {theme === "light" ? (
              <Moon className="h-4 w-4" />
            ) : (
              <Sun className="h-4 w-4" />
            )}
          </Button>
          {onOpenRecycleBin && (
            <Button
              size="icon"
              variant="ghost"
              onClick={onOpenRecycleBin}
              title="回收站"
              aria-label="回收站"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button
            className="min-w-0 flex-1 justify-start"
            size="sm"
            variant="ghost"
            onClick={onOpenSettings}
          >
            <Settings className="h-4 w-4" />
            设置
          </Button>
        </div>
      )}
    </aside>
  );
}
