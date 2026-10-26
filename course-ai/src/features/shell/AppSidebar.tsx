import {
  ArrowLeft,
  ChevronLeft,
  ClipboardList,
  LayoutDashboard,
  Library,
  Loader2,
  MessageSquareText,
  Moon,
  Plus,
  Settings,
  Sun,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ErrorNote } from "@/ui/ErrorNote";
import { CourseList, useCreateCourse } from "@/features/library/CourseList";
import { displayTitle } from "@/lib/videoTitle";
import type { Video } from "@/lib/types";
import { useAssistantUi } from "@/stores/assistant";
import { toggleThemeFrom, type ShellNav } from "./shellNav";

/** 侧栏里的一行入口：图标 + 文字，当前页用中性的底色与字重标出（不铺强调色）。 */
function SideNavItem({
  icon: Icon,
  label,
  active = false,
  onClick,
  trailing,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`ca-side-item ${active ? "active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <Icon className="ic h-4 w-4" />
      <span className="nm">{label}</span>
      {trailing}
    </button>
  );
}

/**
 * 桌面侧栏（展开态）：一列装下全部导航——上面是课程库 / 学习面板 / 处理队列 / 助手，
 * 中间是课程列表，底部是设置、回收站与主题。收起后由 AppRail 以纯图标接替。
 */
export function AppSidebar({
  nav,
  onToggleCollapsed,
  selectedCourseId,
  selectedCourseWatchedRatio,
  onSelectCourse,
  onClearCourseSelection,
  videos = [],
  selectedVideoId = null,
  onOpenVideo,
}: {
  nav: ShellNav;
  /** 折叠侧栏：侧栏头部的收起按钮。 */
  onToggleCollapsed: () => void;
  selectedCourseId: string | null;
  /** 选中课程已看完比例（0-1）；null = 没有数据（侧栏不显示进度）。 */
  selectedCourseWatchedRatio?: number | null;
  onSelectCourse: (id: string) => void;
  onClearCourseSelection?: () => void;
  videos?: Video[];
  selectedVideoId?: string | null;
  onOpenVideo?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { createCourse, creatingCourse, createError } = useCreateCourse();
  const assistantUnread = useAssistantUi((state) => state.unread);
  const inWorkbench = nav.view === "workbench";

  return (
    <aside aria-label={t("nav.courseSidebar")} className="ca-side">
      <div className="ca-side-head">
        <span className="ca-side-app">CoursePilot</span>
        <button
          type="button"
          aria-label={t("nav.collapseSidebar")}
          title={t("nav.collapseSidebar")}
          className="ca-icon-btn ca-side-mini"
          onClick={onToggleCollapsed}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>

      <nav className="ca-side-group" aria-label={t("nav.toolbar")}>
        {inWorkbench ? (
          <SideNavItem
            icon={ArrowLeft}
            label={t("nav.backToLibrary")}
            onClick={nav.onBackToLibrary}
          />
        ) : (
          <SideNavItem
            icon={Library}
            label={t("nav.courseLibrary")}
            active={nav.libraryHomeActive}
            onClick={nav.onGoLibraryHome}
          />
        )}
        <SideNavItem
          icon={LayoutDashboard}
          label={t("nav.dashboard")}
          active={nav.dashboardOpen}
          onClick={nav.onOpenDashboard}
        />
        {!inWorkbench && (
          <SideNavItem
            icon={ClipboardList}
            label={t("nav.queue")}
            active={nav.queueOpen}
            onClick={nav.onToggleQueue}
            trailing={
              nav.queueCount > 0 ? (
                <span className="ca-side-count" aria-hidden="true">
                  {nav.queueCount}
                </span>
              ) : null
            }
          />
        )}
        <SideNavItem
          icon={MessageSquareText}
          label={t("assistant.title")}
          active={nav.assistantActive}
          onClick={nav.onToggleAssistant}
          trailing={
            assistantUnread && !nav.assistantActive ? (
              <span className="ca-side-dot" aria-label={t("assistant.unread")} />
            ) : null
          }
        />
      </nav>

      <div className="ca-nav-label">
        <span>{t("nav.myCourses")}</span>
        {!inWorkbench && (
          <button
            type="button"
            aria-label={t("nav.addCourseFolder")}
            title={t("nav.addCourseFolder")}
            className="ca-icon-btn ca-side-mini"
            disabled={creatingCourse}
            onClick={() => void createCourse()}
          >
            {creatingCourse ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
      {createError && <ErrorNote className="mx-1 mb-2" error={createError} />}
      <div className="ca-nav">
        <CourseList
          selectedCourseId={selectedCourseId}
          selectedCourseWatchedRatio={selectedCourseWatchedRatio}
          onSelect={onSelectCourse}
          onClearSelection={onClearCourseSelection}
          queueOpen={nav.queueOpen}
          selectedCourseExtra={
            inWorkbench ? (
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

      <div className="ca-side-foot">
        <SideNavItem
          icon={Settings}
          label={t("nav.settings")}
          active={nav.settingsOpen}
          onClick={nav.onOpenSettings}
        />
        <button
          type="button"
          aria-label={t("nav.recycleBin")}
          title={t("nav.recycleBin")}
          aria-current={nav.recycleOpen ? "page" : undefined}
          className={`ca-icon-btn ca-side-mini ${nav.recycleOpen ? "active" : ""}`}
          onClick={nav.onOpenRecycleBin}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={nav.themeToggleLabel}
          title={nav.themeToggleLabel}
          className="ca-icon-btn ca-side-mini"
          onClick={(event) => toggleThemeFrom(event, nav.onToggleTheme)}
        >
          {nav.theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </button>
      </div>
    </aside>
  );
}
