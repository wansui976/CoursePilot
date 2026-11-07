import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { COURSE_COLORS, type CourseColor } from "@/lib/types";

/**
 * 菜单里的一行颜色格：第一格「不标颜色」，其余是预设色板。课程和文件夹共用。
 * 每格是 menuitemradio，方向键可达（菜单按 `[role^="menuitem"]` 收集条目）。
 */
export function ColorSwatches({
  value,
  onChange,
}: {
  value: CourseColor | null;
  onChange: (color: CourseColor | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t("courseList.color")} className="ca-course-colors">
      <button
        type="button"
        role="menuitemradio"
        tabIndex={-1}
        aria-checked={!value}
        aria-label={t("courseList.colorNone")}
        title={t("courseList.colorNone")}
        data-none
        className="ca-color-swatch"
        onClick={() => onChange(null)}
      />
      {COURSE_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="menuitemradio"
          tabIndex={-1}
          aria-checked={value === color}
          aria-label={t(`courseList.colors.${color}`)}
          title={t(`courseList.colors.${color}`)}
          className="ca-color-swatch"
          style={{ "--swatch": `var(--course-${color})` } as CSSProperties}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  );
}
