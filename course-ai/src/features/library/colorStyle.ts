import type { CSSProperties } from "react";
import type { CourseColor } from "@/lib/types";

/** 课程 / 文件夹图标的着色：没标颜色时不给 style，沿用 CSS 里的默认色。 */
export function colorStyle(color: CourseColor | null | undefined): CSSProperties | undefined {
  return color ? { color: `var(--course-${color})` } : undefined;
}
