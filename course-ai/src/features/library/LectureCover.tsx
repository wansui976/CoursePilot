import { guessCoverKind } from "@/lib/coverKind";
import { lectureNumberOf } from "@/lib/lectureOrder";
import type { Course } from "@/lib/types";
import { useVideoCoverUrl } from "@/lib/useVideoCoverUrl";
import { cn } from "@/lib/utils";
import { BoardCover } from "@/ui/BoardCover";

/**
 * 一讲的封面。传了 videoId 就用视频自己的首帧（单个视频认得出是哪一段）；
 * 首帧还没取到、取不到或没传 videoId 时，退回黑板 + 讲次号。课程、牌堆这类「一叠视频」才固定用黑板。
 *
 * 黑板版：讲次从标题里读（「第 3 讲」「03 …」），读不到用它在列表里的位置。
 * 学科图按课程名猜，同一门课的每一讲用同一种图，颜色跟课程走。
 */
export function LectureCover({
  videoId,
  title,
  course,
  index,
  showCaption = true,
  className,
  children,
}: {
  /** 这一讲的视频 id：有首帧就显示首帧。 */
  videoId?: string;
  title: string;
  course?: Pick<Course, "name" | "color"> | null;
  /** 在课程里的位置（从 0 开始），标题里没有讲次时用。 */
  index?: number;
  /** 课程页里每一讲都是同一门课，封面上就不再写课程名。 */
  showCaption?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const thumb = useVideoCoverUrl(videoId ?? "", Boolean(videoId));
  if (thumb) {
    return (
      <span className={cn("ca-video-cover", className)}>
        <img src={thumb} alt="" draggable={false} />
        {children}
      </span>
    );
  }
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
