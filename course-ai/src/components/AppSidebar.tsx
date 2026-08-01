import {
  Book,
  ClipboardList,
  LayoutDashboard,
  Library,
  Loader2,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Sun,
  Trash2,
} from "lucide-react";
import type { MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { CourseList, useCreateCourse } from "@/components/CourseList";
import { displayTitle } from "@/lib/videoTitle";
import { setThemeToggleOrigin } from "@/stores/theme";
import type { Video } from "@/lib/types";

/** 全局唯一左侧栏:展开=宽栏、折叠=图标栏(Task 3),课程库与工作台共用。 */
export function AppSidebar({
  view,
  collapsed,
  onToggleCollapsed,
  selectedCourseId,
  onSelectCourse,
  onClearCourseSelection,
  videos = [],
  selectedVideoId = null,
  onOpenVideo,
  onBackToLibrary,
  theme,
  themeToggleLabel,
  onToggleTheme,
  onOpenSettings,
  onOpenRecycleBin,
  onOpenDashboard,
  queueOpen,
  queueCount,
  onToggleQueue,
}: {
  view: "library" | "workbench";
  collapsed: boolean;
  onToggleCollapsed: () => void;
  selectedCourseId: string | null;
  onSelectCourse: (id: string) => void;
  onClearCourseSelection?: () => void;
  videos?: Video[];
  selectedVideoId?: string | null;
  onOpenVideo?: (id: string) => void;
  onBackToLibrary?: () => void;
  theme: "dark" | "light";
  themeToggleLabel: string;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onOpenRecycleBin: () => void;
  onOpenDashboard: () => void;
  queueOpen: boolean;
  queueCount: number;
  onToggleQueue: () => void;
}) {
  const { createCourse, creatingCourse, createError } = useCreateCourse();

  // 用按钮中心作圆形扩散起点（比 clientX/Y 稳，键盘/鼠标一致），再切换主题。
  function toggleThemeFrom(event: MouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setThemeToggleOrigin(rect.left + rect.width / 2, rect.top + rect.height / 2);
    onToggleTheme();
  }

  if (collapsed) {
    return (
      <>
        <nav className="ca-rail" aria-label="工具栏">
          {view === "workbench" && (
            <button
              type="button"
              className="rail-logo"
              title="返回课程库"
              aria-label="返回课程库"
              onClick={onBackToLibrary}
            >
              <Book className="h-[18px] w-[18px]" />
            </button>
          )}
          <button
            className="rail-btn"
            title="展开侧栏"
            aria-label="展开侧栏"
            onClick={onToggleCollapsed}
          >
            <PanelLeftOpen className="h-5 w-5" />
          </button>
          {view === "library" && (
            <button
              className={`rail-btn ${queueOpen ? "active" : ""}`}
              title="处理队列"
              aria-label="处理队列"
              onClick={onToggleQueue}
            >
              <ClipboardList className="h-5 w-5" />
              {queueCount > 0 && <span className="rail-badge">{queueCount}</span>}
            </button>
          )}
          <button
            className="rail-btn"
            title="学习面板"
            aria-label="学习面板"
            onClick={onOpenDashboard}
          >
            <LayoutDashboard className="h-5 w-5" />
          </button>
          <div className="rail-sp" />
          <button
            className="rail-btn"
            title={themeToggleLabel}
            aria-label={themeToggleLabel}
            onClick={toggleThemeFrom}
          >
            {theme === "light" ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
          </button>
          <button
            className="rail-btn"
            title="回收站"
            aria-label="回收站"
            onClick={onOpenRecycleBin}
          >
            <Trash2 className="h-5 w-5" />
          </button>
          <button
            className="rail-btn"
            title="设置"
            aria-label="设置"
            onClick={onOpenSettings}
          >
            <Settings className="h-5 w-5" />
          </button>
        </nav>
      </>
    );
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
        {view === "library" && (
          <>
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
          </>
        )}
      </div>
      <div className="ca-nav-label">我的课程</div>
      <div className="ca-nav">
        <CourseList
          selectedCourseId={selectedCourseId}
          onSelect={onSelectCourse}
          onClearSelection={onClearCourseSelection}
          queueOpen={queueOpen}
          selectedCourseExtra={
            view === "workbench" ? (
              <div className="ca-side-videos" aria-label="课程视频列表">
                {videos.map((video) => (
                  <button
                    key={video.id}
                    type="button"
                    className={`ca-side-video ${video.id === selectedVideoId ? "on" : ""}`}
                    aria-current={video.id === selectedVideoId ? "page" : undefined}
                    onClick={() => onOpenVideo?.(video.id)}
                  >
                    <span className="nm">{displayTitle(video.title)}</span>
                  </button>
                ))}
                {videos.length === 0 && (
                  <div className="ca-side-videos-empty">该课程暂无视频</div>
                )}
              </div>
            ) : undefined
          }
        />
      </div>
      <div className="mt-4 flex flex-none flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
        <Button
          size="icon"
          variant="ghost"
          onClick={toggleThemeFrom}
          title={themeToggleLabel}
          aria-label={themeToggleLabel}
        >
          {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={onOpenDashboard}
          title="学习面板"
          aria-label="学习面板"
        >
          <LayoutDashboard className="h-4 w-4" />
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
