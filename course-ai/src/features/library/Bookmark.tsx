import { useTranslation } from "react-i18next";
import type { CourseBookmark } from "@/lib/bookmark";
import { courseTone } from "@/lib/coverKind";
import type { Course } from "@/lib/types";

/**
 * 夹在课程牌上的丝带书签：从上沿垂下来，尾巴剪成燕尾，写着停在第几讲。
 * 很久没打开的课，书签褪色，封面上落一层粉笔灰。放在黑板封面里（父元素已定位）。
 */
export function Bookmark({ bookmark, course }: { bookmark: CourseBookmark; course: Pick<Course, "name" | "color"> }) {
  const { t } = useTranslation();
  const label = bookmark.dusty
    ? t("library.bookmarkDusty", { lecture: bookmark.lecture, days: bookmark.idleDays })
    : t("library.bookmark", { lecture: bookmark.lecture });
  return (
    <>
      {bookmark.dusty && <span className="ca-dust" aria-hidden="true" />}
      <span
        className="ca-bookmark"
        data-dusty={bookmark.dusty ? "" : undefined}
        style={{ "--ribbon": `var(--tag-${courseTone(course.color, course.name)})` } as React.CSSProperties}
        role="img"
        aria-label={label}
        title={label}
      >
        <span className="n">{bookmark.lecture}</span>
      </span>
    </>
  );
}
