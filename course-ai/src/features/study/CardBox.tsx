import { forwardRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { packWidth } from "@/lib/cardBox";

const SLOT_KEYS = ["boxToday", "boxTomorrow", "boxWeek", "boxMonth", "boxLater"] as const;

/**
 * 复习的「卡片盒」样式（设置 → 外观 → 复习样式）：从上往下看的一只索引卡盒，按下次到期分五格，
 * 每格里竖插的一摞卡——摞得越厚这格卡越多，一眼看出记忆的分布。评完分卡片飞进对应的格子，
 * 落下的那格亮一下（landed）。
 */
export const CardBox = forwardRef<HTMLDivElement, { counts: number[]; landed: number | null }>(
  function CardBox({ counts, landed }, ref) {
    const { t } = useTranslation();
    const max = Math.max(0, ...counts);
    return (
      <div ref={ref} role="list" aria-label={t("review.boxLabel")} className="ca-cardbox">
        {SLOT_KEYS.map((key, slot) => {
          const count = counts[slot] ?? 0;
          const label = t(`review.${key}`);
          return (
            <div
              key={key}
              role="listitem"
              aria-label={t("review.boxSlot", { label, count })}
              className="ca-cardbox-slot"
              data-slot={slot}
              data-landed={landed === slot ? "" : undefined}
            >
              <span className="ca-cardbox-tab" aria-hidden="true">
                {label}
                <span className="ca-cardbox-count">{count}</span>
              </span>
              <span className="ca-cardbox-well" aria-hidden="true">
                <span
                  className="ca-cardbox-pack"
                  style={{ "--pack": packWidth(count, max) } as CSSProperties}
                />
              </span>
            </div>
          );
        })}
      </div>
    );
  },
);
