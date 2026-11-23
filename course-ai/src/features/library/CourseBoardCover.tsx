import type { ComponentProps } from "react";
import type { Course } from "@/lib/types";
import { useCoverFor } from "@/lib/useCourseCover";
import { BoardCover } from "@/ui/BoardCover";

/**
 * 一门课的黑板封面：学科、AI 画的图和关键术语来自存下来的封面（AI 判断或手动选），
 * 没有时按课程名和 hints（视频标题）里的关键词猜。
 */
export function CourseBoardCover({
  course,
  hints = [],
  ...props
}: Omit<ComponentProps<typeof BoardCover>, "kind" | "art" | "terms" | "color" | "seed"> & {
  course: Pick<Course, "name" | "color"> & { id?: string };
  hints?: (string | null | undefined)[];
}) {
  const cover = useCoverFor(course.id, course.name, ...hints);
  return (
    <BoardCover
      {...props}
      kind={cover.kind}
      art={cover.art}
      terms={cover.terms}
      seed={course.name}
      color={course.color ?? null}
    />
  );
}
