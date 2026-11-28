import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { COURSE_COLORS, type Course } from "@/lib/types";
import { stableIndex } from "@/lib/coverKind";
import { spineWidth } from "@/lib/shelf";

/**
 * 课程库的「书架」摆法（设置 → 外观 → 课程库样式）：每门课是一本竖着插在架上的书。
 *
 * 只表达真实信息：讲数越多书脊越厚。不画磨痕、不夹书签
 * （和封面上的丝带、粉笔灰一样，用户不要装饰）。书脊上课程名逐字直立堆叠，底下写讲数。
 * 书一多就自动换到下一层，每层下面一块搁板。
 */

/** 书脊高度：同一门课每次一样，各本之间差一点，摆在一起才像书。 */
function spineHeight(course: Course): number {
  return 190 + stableIndex(`h:${course.id}`, 4) * 10;
}

function spineColor(course: Course) {
  return course.color ?? COURSE_COLORS[stableIndex(course.name, COURSE_COLORS.length)];
}

/** 书脊上除了书名，上下布带、讲数和留白一共占多高（px），和 .ca-shelf-book 的样式一起改。 */
const SPINE_CHROME = 92;
/** 书名一个字占多高（14px 字 × 1.15 行高）。 */
const SPINE_CHAR = 16.1;

/** 这本书的书脊写得下几个字：太长的课程名截断，末尾用竖排省略号「︙」，不会截在半个字上。 */
function spineChars(height: number): number {
  return Math.max(2, Math.floor((height - SPINE_CHROME) / SPINE_CHAR));
}

export function CourseShelf({
  courses,
  onOpenCourse,
}: {
  courses: Course[];
  onOpenCourse: (courseId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <ul className="ca-shelf" aria-label={t("library.shelfLabel")}>
      {courses.map((course) => {
        const chars = Array.from(course.name.replace(/\s+/g, ""));
        const height = spineHeight(course);
        const fit = spineChars(height);
        const shown = chars.length > fit ? [...chars.slice(0, fit - 1), "︙"] : chars;
        const style = {
          "--spine-w": `${spineWidth(course.video_count)}px`,
          "--spine-h": `${height}px`,
          "--spine": `var(--tag-${spineColor(course)})`,
          "--spine-bg": `var(--tag-${spineColor(course)}-bg)`,
          "--spine-text": `var(--tag-${spineColor(course)}-text)`,
        } as CSSProperties;
        return (
          <li key={course.id} className="ca-shelf-slot">
            <button
              type="button"
              className="ca-shelf-book"
              style={style}
              aria-label={t("library.shelfBook", { name: course.name, count: course.video_count })}
              title={course.name}
              onClick={() => onOpenCourse(course.id)}
            >
              <span className="ca-shelf-book-band" aria-hidden="true" />
              <span className="ca-shelf-book-title" aria-hidden="true">
                {shown.map((char, index) => (
                  <span key={index}>{char}</span>
                ))}
              </span>
              <span className="ca-shelf-book-count" aria-hidden="true">
                {course.video_count}
                <small>{t("library.lectureUnit")}</small>
              </span>
              <span className="ca-shelf-book-band" aria-hidden="true" />
            </button>
          </li>
        );
      })}
      <li className="ca-shelf-end" aria-hidden="true" />
    </ul>
  );
}
