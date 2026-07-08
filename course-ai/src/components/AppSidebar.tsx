import {
  ClipboardList,
  Library,
  Loader2,
  Moon,
  PanelLeftClose,
  Plus,
  Settings,
  Sun,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { CourseList, useCreateCourse } from "@/components/CourseList";
import type { Video } from "@/lib/types";

/** 全局唯一左侧栏:展开=宽栏、折叠=图标栏(Task 3),课程库与工作台共用。 */
export function AppSidebar({
  view,
  collapsed,
  onToggleCollapsed,
  selectedCourseId,
  onSelectCourse,
  courseName,
  videos = [],
  selectedVideoId = null,
  onOpenVideo,
  onBackToLibrary,
  theme,
  themeToggleLabel,
  onToggleTheme,
  onOpenSettings,
  onOpenRecycleBin,
  queueOpen,
  queueCount,
  onToggleQueue,
}: {
  view: "library" | "workbench";
  collapsed: boolean;
  onToggleCollapsed: () => void;
  selectedCourseId: string | null;
  onSelectCourse: (id: string) => void;
  courseName?: string;
  videos?: Video[];
  selectedVideoId?: string | null;
  onOpenVideo?: (id: string) => void;
  onBackToLibrary?: () => void;
  theme: "dark" | "light";
  themeToggleLabel: string;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onOpenRecycleBin: () => void;
  queueOpen: boolean;
  queueCount: number;
  onToggleQueue: () => void;
}) {
  const { createCourse, creatingCourse, createError } = useCreateCourse();

  if (collapsed) {
    // Task 3 实现;本任务先渲染占位,保证类型完整。折叠态相关 props 暂由此分支引用。
    void view;
    void courseName;
    void videos;
    void selectedVideoId;
    void onOpenVideo;
    void onBackToLibrary;
    return <nav className="ca-rail" aria-label="工具栏" />;
  }

  return (
    <aside aria-label="课程侧栏" className="ca-side">
      <div className="flex-none">
        <div className="ca-brand">
          <div className="logo">
            <Library className="h-4 w-4" />
          </div>
          <div className="label">
            <h1>课程库</h1>
          </div>
          <button
            type="button"
            aria-label="折叠侧栏"
            title="折叠侧栏"
            className="ca-icon-btn ml-auto"
            onClick={onToggleCollapsed}
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
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
      </div>
      <div className="ca-nav-label">我的课程</div>
      <div className="ca-nav">
        <CourseList
          selectedCourseId={selectedCourseId}
          onSelect={onSelectCourse}
          queueOpen={queueOpen}
        />
      </div>
      <div className="mt-4 flex flex-none flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
        <Button
          size="icon"
          variant="ghost"
          onClick={onToggleTheme}
          title={themeToggleLabel}
          aria-label={themeToggleLabel}
        >
          {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={onOpenRecycleBin}
          title="回收站"
          aria-label="回收站"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
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
    </aside>
  );
}
