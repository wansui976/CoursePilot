import { Loader2, Plus, Trash2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { queries } from "@/lib/queries";
import { ErrorNote } from "@/ui/ErrorNote";
import { CourseList, useCreateCourse } from "./CourseList";
import { ResumeSection } from "./LibraryOverview";
import { cn } from "@/lib/utils";

/** 窄屏「课程」Tab 的整屏课程列表：标题行（添加课程文件夹、回收站）+ CourseList。 */
export function CourseSidebar({
  selectedCourseId,
  onSelect,
  onClearSelection,
  onOpenRecycleBin,
  onTransientCloseChange,
  onResume,
  className,
}: {
  selectedCourseId: string | null;
  /** 打开课程（folderId 缺省 = 根目录）；侧栏文件夹树里点文件夹会带上它。 */
  onSelect: (id: string, folderId?: string | null) => void;
  onClearSelection?: () => void;
  onOpenRecycleBin?: () => void;
  onTransientCloseChange?: (close: (() => void) | null) => void;
  /**
   * 给了就在课程列表上面加「继续学习」。这一屏就是手机 / 平板竖屏的首页，
   * 打开应用最常做的就是接着上次看，放在最上面一点就回去。
   */
  onResume?: (courseId: string, videoId: string, positionSec: number) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const { createCourse, creatingCourse, createError } = useCreateCourse();
  const { data: courses = [] } = useQuery({ ...queries.courses(), enabled: Boolean(onResume) });

  return (
    <aside aria-label={t("nav.courseSidebar")} className={cn("ca-course-screen", className)}>
      {/* 一行装下：左边大标题，右边「添加课程文件夹」与回收站。 */}
      <div className="ca-course-screen-head">
        <h1>{t("nav.courseLibrary")}</h1>
        <button
          type="button"
          aria-label={t("nav.addCourseFolder")}
          className="ca-course-screen-add"
          data-tour="add-course"
          disabled={creatingCourse}
          onClick={() => void createCourse()}
        >
          {creatingCourse ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {creatingCourse ? t("nav.addingCourse") : t("nav.addCourseFolder")}
        </button>
        {onOpenRecycleBin && (
          <button
            type="button"
            aria-label={t("nav.recycleBin")}
            title={t("nav.recycleBin")}
            className="ca-icon-btn flex-none"
            onClick={onOpenRecycleBin}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
      {createError && <ErrorNote className="mb-3" error={createError} />}
      {onResume && <ResumeSection courses={courses} onResume={onResume} />}
      <div className="ca-nav-label">{t("nav.myCourses")}</div>
      <div className="ca-nav">
        <CourseList
          selectedCourseId={selectedCourseId}
          onSelect={onSelect}
          onClearSelection={onClearSelection}
          onTransientCloseChange={onTransientCloseChange}
          boardThumbs
        />
      </div>
    </aside>
  );
}
