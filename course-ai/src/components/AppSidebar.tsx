import {
  Book,
  ClipboardList,
  Library,
  List,
  Loader2,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Settings,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { IconButton } from "@/components/ui/icon-button";
import { CourseList, useCreateCourse } from "@/components/CourseList";
import { displayTitle } from "@/lib/videoTitle";
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

  // 折叠态「课程视频」弹层开关;离开工作台自动关(组件跨视图常驻,不重挂)。
  const [videosOpen, setVideosOpen] = useState(false);
  useEffect(() => {
    if (view !== "workbench") setVideosOpen(false);
  }, [view]);

  if (collapsed) {
    return (
      <>
        <nav className="ca-rail" aria-label="工具栏">
          {view === "workbench" ? (
            <button
              type="button"
              className="rail-logo"
              title="返回课程库"
              aria-label="返回课程库"
              onClick={onBackToLibrary}
            >
              <Book className="h-[18px] w-[18px]" />
            </button>
          ) : (
            <span className="rail-logo">
              <Book className="h-[18px] w-[18px]" />
            </span>
          )}
          <button
            className="rail-btn"
            title="展开侧栏"
            aria-label="展开侧栏"
            onClick={onToggleCollapsed}
          >
            <PanelLeftOpen className="h-5 w-5" />
          </button>
          <button
            className={`rail-btn ${queueOpen ? "active" : ""}`}
            title="处理队列"
            aria-label="处理队列"
            onClick={onToggleQueue}
          >
            <ClipboardList className="h-5 w-5" />
            {queueCount > 0 && <span className="rail-badge">{queueCount}</span>}
          </button>
          {view === "workbench" && (
            <button
              className={`rail-btn ${videosOpen ? "active" : ""}`}
              title="课程视频"
              aria-label="课程视频"
              aria-expanded={videosOpen}
              onClick={() => setVideosOpen((open) => !open)}
            >
              <List className="h-5 w-5" />
            </button>
          )}
          <div className="rail-sp" />
          <button
            className="rail-btn"
            title={themeToggleLabel}
            aria-label={themeToggleLabel}
            onClick={onToggleTheme}
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
        {view === "workbench" && videosOpen && (
          <>
            <div className="ca-rail-flyout-scrim" onClick={() => setVideosOpen(false)} />
            <div className="ca-rail-flyout" role="dialog" aria-label="课程视频列表">
              <div className="ca-rail-flyout-head">
                <span className="t">{courseName ?? "课程视频"}</span>
                <IconButton aria-label="关闭" onClick={() => setVideosOpen(false)}>
                  <X className="h-4 w-4" />
                </IconButton>
              </div>
              <div className="ca-rail-flyout-list">
                {videos.map((video) => (
                  <button
                    key={video.id}
                    type="button"
                    className={`ca-rail-flyout-item ${video.id === selectedVideoId ? "on" : ""}`}
                    aria-current={video.id === selectedVideoId ? "true" : undefined}
                    onClick={() => {
                      onOpenVideo?.(video.id);
                      setVideosOpen(false);
                    }}
                  >
                    <Play className="h-3.5 w-3.5 flex-none" />
                    <span className="nm">{displayTitle(video.title)}</span>
                  </button>
                ))}
                {videos.length === 0 && (
                  <div className="ca-rail-flyout-empty">该课程暂无视频</div>
                )}
              </div>
            </div>
          </>
        )}
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
