import { Library, Loader2, Plus, Trash2 } from "lucide-react";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Button } from "@/components/ui/button";
import { CourseList, useCreateCourse } from "@/components/CourseList";
import { cn } from "@/lib/utils";

/** 窄屏「课程」Tab 的整屏课程列表:品牌行 + 右上回收站 + 新建课程 + CourseList。 */
export function CourseSidebar({
  selectedCourseId,
  onSelect,
  onOpenRecycleBin,
  className,
}: {
  selectedCourseId: string | null;
  onSelect: (id: string) => void;
  onOpenRecycleBin?: () => void;
  className?: string;
}) {
  const { createCourse, creatingCourse, createError } = useCreateCourse();

  return (
    <aside aria-label="课程侧栏" className={cn("ca-course-screen", className)}>
      <div className="flex-none">
        <div className="ca-brand">
          <div className="logo">
            <Library className="h-4 w-4" />
          </div>
          <div className="label">
            <h1>课程库</h1>
          </div>
          {onOpenRecycleBin && (
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
      </div>
      <div className="ca-nav-label">我的课程</div>
      <div className="ca-nav">
        <CourseList selectedCourseId={selectedCourseId} onSelect={onSelect} />
      </div>
    </aside>
  );
}
