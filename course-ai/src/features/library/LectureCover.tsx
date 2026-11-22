import { guessCoverKind } from "@/lib/coverKind";
import { lectureNumberOf } from "@/lib/lectureOrder";
import type { Course } from "@/lib/types";
import { BoardCover } from "@/ui/BoardCover";

/**
 * 一讲的封面：黑板 + 讲次号。讲次从标题里读（「第 3 讲」「03 …」），读不到用它在列表里的位置。
 * 学科图按课程名猜，同一门课的每一讲用同一种图，颜色跟课程走。
 */
export function LectureCover({
  title,
  course,
  index,
  showCaption = true,
  className,
  children,
}: {
  title: string;
  course?: Pick<Course, "name" | "color"> | null;
  /** 在课程里的位置（从 0 开始），标题里没有讲次时用。 */
  index?: number;
  /** 课程页里每一讲都是同一门课，封面上就不再写课程名。 */
  showCaption?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const fromTitle = lectureNumberOf(title);
  const number = fromTitle ?? (index != null ? index + 1 : null);
  return (
    <BoardCover
      kind={guessCoverKind(course?.name, title)}
      number={number}
      caption={showCaption ? (course?.name ?? title) : undefined}
      color={course?.color ?? null}
      className={className}
    >
      {children}
    </BoardCover>
  );
}
