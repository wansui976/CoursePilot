import { Loader2, PanelLeftClose, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { CourseList, useCreateCourse } from "@/features/library/CourseList";
import { displayTitle } from "@/lib/videoTitle";
import type { Video } from "@/lib/types";

/** 全局课程侧栏（展开态）。只放课程相关的纯内容：标题、新建课、课程列表与
    workbench 视频子列表。所有导航/全局动作（队列/Dashboard/助手/主题/回收站/设置）
    统一在常驻 AppRail，这里不再重复入口。 */
export function AppSidebar({
  view,
  onToggleCollapsed,
  selectedCourseId,
  selectedCourseWatchedRatio,
  onSelectCourse,
  onClearCourseSelection,
  videos = [],
  selectedVideoId = null,
  onOpenVideo,
  queueOpen,
}: {
  view: "library" | "workbench";
  /** 折叠侧栏：展开态侧栏头部的收起按钮。 */
  onToggleCollapsed: () => void;
  selectedCourseId: string | null;
  /** 选中课程已看完比例（0-1）；null = 没有数据（侧栏仅显示集数）。 */
  selectedCourseWatchedRatio?: number | null;
  onSelectCourse: (id: string) => void;
  onClearCourseSelection?: () => void;
  videos?: Video[];
  selectedVideoId?: string | null;
  onOpenVideo?: (id: string) => void;
  /** 处理队列打开时取消课程选中高亮；入口在 AppRail，这里只消费状态。 */
  queueOpen: boolean;
}) {
  const { t } = useTranslation();
  const { createCourse, creatingCourse, createError } = useCreateCourse();

  return (
    <aside aria-label={t("nav.courseSidebar")} className="ca-side">
      <div className="flex-none">
        <div className="ca-brand">
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
    </aside>
  );
}