import { Loader2, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ErrorNote } from "@/ui/ErrorNote";
import { CourseList, useCreateCourse } from "./CourseList";
import { cn } from "@/lib/utils";

/** 窄屏「课程」Tab 的整屏课程列表：标题行（添加课程文件夹、回收站）+ CourseList。 */
export function CourseSidebar({
  selectedCourseId,
  onSelect,
  onClearSelection,
  onOpenRecycleBin,
  onTransientCloseChange,
  className,
}: {
  selectedCourseId: string | null;
  onSelect: (id: string) => void;
  onClearSelection?: () => void;
  onOpenRecycleBin?: () => void;
  onTransientCloseChange?: (close: (() => void) | null) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const { createCourse, creatingCourse, createError } = useCreateCourse();

  return (
    <aside aria-label={t("nav.courseSidebar")} className={cn("ca-course-screen", className)}>
      {/* 一行装下：左边大标题，右边「添加课程文件夹」与回收站。 */}
      <div className="ca-course-screen-head">
        <h1>{t("nav.courseLibrary")}</h1>
        <button
          type="button"
          aria-label={t("nav.addCourseFolder")}
          className="ca-course-screen-add"
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
      <div className="ca-nav-label">{t("nav.myCourses")}</div>
      <div className="ca-nav">
        <CourseList
          selectedCourseId={selectedCourseId}
          onSelect={onSelect}
          onClearSelection={onClearSelection}
          onTransientCloseChange={onTransientCloseChange}
        />
      </div>
    </aside>
  );
}
