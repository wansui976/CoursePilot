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
import { useTranslation } from "react-i18next";
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
  selectedCourseWatchedRatio,
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
  /** 选中课程已看完比例（0-1）；null = 没有数据（侧栏仅显示集数）。 */
  selectedCourseWatchedRatio?: number | null;
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
  const { t } = useTranslation();
  const { createCourse, creatingCourse, createError } = useCreateCourse();

  function toggleThemeFrom(event: MouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setThemeToggleOrigin(rect.left + rect.width / 2, rect.top + rect.height / 2);
    onToggleTheme();
  }

  if (collapsed) {
    return (
      <>
        <nav className="ca-rail" aria-label={t("nav.toolbar")}>
          {view === "workbench" && (
            <button
              type="button"
              className="rail-logo"
              title={t("nav.backToLibrary")}
              aria-label={t("nav.backToLibrary")}
              onClick={onBackToLibrary}
            >
              <Book className="h-[18px] w-[18px]" />
            </button>
          )}
          <button
            className="rail-btn"
            title={t("nav.expandSidebar")}
            aria-label={t("nav.expandSidebar")}
            onClick={onToggleCollapsed}
          >
            <PanelLeftOpen className="h-5 w-5" />
          </button>
          {view === "library" && (
            <button
              className={`rail-btn ${queueOpen ? "active" : ""}`}
              title={t("nav.queue")}
              aria-label={t("nav.queue")}
              onClick={onToggleQueue}
            >
              <ClipboardList className="h-5 w-5" />
              {queueCount > 0 && <span className="rail-badge">{queueCount}</span>}
            </button>
          )}
          <button
            className="rail-btn"
            title={t("nav.dashboard")}
            aria-label={t("nav.dashboard")}
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
            title={t("nav.recycleBin")}
            aria-label={t("nav.recycleBin")}
            onClick={onOpenRecycleBin}
          >
            <Trash2 className="h-5 w-5" />
          </button>
          <button
            className="rail-btn"
            title={t("nav.settings")}
            aria-label={t("nav.settings")}
            onClick={onOpenSettings}
          >
            <Settings className="h-5 w-5" />
          </button>
        </nav>
      </>
    );
  }

  return (
    <aside aria-label={t("nav.courseSidebar")} className="ca-side">
      <div className="flex-none">
        <div className="ca-brand">
          <div className="logo">
            <Library className="h-4 w-4" />
          </div>
          <div className="label">
            <h1>{t("nav.courseLibrary")}</h1>
          </div>
          <button
            type="button"
            aria-label={t("nav.collapseSidebar")}
            title={t("nav.collapseSidebar")}
            className="ca-icon-btn ml-auto"
            onClick={onToggleCollapsed}
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>
        {view === "library" && (
          <>
            <Button
              aria-label={t("nav.addCourseFolder")}
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
              {creatingCourse ? t("nav.addingCourse") : t("nav.addCourseFolder")}
            </Button>
            {createError && <ErrorNote className="mt-2" error={createError} />}
            <Button
              aria-label={t("nav.queue")}
              className={`ca-nav-item mt-2 w-full justify-start ${queueOpen ? "active" : ""}`}
              size="sm"
              variant="ghost"
              onClick={onToggleQueue}
            >
              <ClipboardList className="h-4 w-4" />
              {t("nav.queue")}
              {queueCount > 0 && (
                <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--accent-weak-2)] px-1.5 text-[11px] leading-none text-[var(--accent-text)]">
                  {queueCount}
                </span>
              )}
            </Button>
          </>
        )}
      </div>
      <div className="ca-nav-label">{t("nav.myCourses")}</div>
      <div className="ca-nav">
        <CourseList
          selectedCourseId={selectedCourseId}
          selectedCourseWatchedRatio={selectedCourseWatchedRatio}
          onSelect={onSelectCourse}
          onClearSelection={onClearCourseSelection}
          queueOpen={queueOpen}
          selectedCourseExtra={
            view === "workbench" ? (
              <div className="ca-side-videos" aria-label={t("nav.courseVideoList")}>
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
                  <div className="ca-side-videos-empty">{t("nav.noCourseVideos")}</div>
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
          title={t("nav.dashboard")}
          aria-label={t("nav.dashboard")}
        >
          <LayoutDashboard className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={onOpenRecycleBin}
          title={t("nav.recycleBin")}
          aria-label={t("nav.recycleBin")}
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
          {t("nav.settings")}
        </Button>
      </div>
    </aside>
  );
}
