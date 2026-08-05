import { Library, Loader2, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Button } from "@/components/ui/button";
import { CourseList, useCreateCourse } from "@/components/CourseList";
import { cn } from "@/lib/utils";

/** 窄屏「课程」Tab 的整屏课程列表:品牌行 + 右上回收站 + 添加课程文件夹 + CourseList。 */
export function CourseSidebar({
  selectedCourseId,
  onSelect,
  onClearSelection,
  onOpenRecycleBin,
  className,
}: {
  selectedCourseId: string | null;
  onSelect: (id: string) => void;
  onClearSelection?: () => void;
  onOpenRecycleBin?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const { createCourse, creatingCourse, createError } = useCreateCourse();

  return (
    <aside aria-label={t("nav.courseSidebar")} className={cn("ca-course-screen", className)}>
      <div className="flex-none">
        <div className="ca-brand">
          <div className="logo">
            <Library className="h-4 w-4" />
          </div>
          <div className="label">
            <h1>{t("nav.courseLibrary")}</h1>
          </div>
          {onOpenRecycleBin && (
            <button
              type="button"
              aria-label={t("nav.recycleBin")}
              title={t("nav.recycleBin")}
              className="ca-icon-btn ml-auto"
              onClick={onOpenRecycleBin}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
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
      </div>
      <div className="ca-nav-label">{t("nav.myCourses")}</div>
      <div className="ca-nav">
        <CourseList
          selectedCourseId={selectedCourseId}
          onSelect={onSelect}
          onClearSelection={onClearSelection}
        />
      </div>
    </aside>
  );
}
