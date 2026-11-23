import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { renderInlineMarkdown } from "@/lib/renderMarkdown";
import { Button } from "@/ui/button";

/** 连对几次赢回来（与后端 MISTAKE_STREAK_TO_CLEAR 一致）。 */
const STREAK_TO_CLEAR = 3;

/**
 * 错题本：答错过的卡单独叠成一小摞，左边一道红边。连对三次红边褪掉、回到普通复习牌堆。
 * 没有错题时什么都不显示。courseId 为空时是全部课程。
 */
export function MistakeDeck({
  courseId = null,
  onReview,
  className,
}: {
  courseId?: string | null;
  onReview: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const { data: mistakes = [] } = useQuery({
    queryKey: qk.srs.mistakes(courseId),
    queryFn: () => ipc.srs.mistakes(courseId),
    retry: false,
  });
  if (mistakes.length === 0) return null;
  const top = mistakes[0];

  return (
    <section className={`ca-mistakes ${className ?? ""}`} aria-labelledby="mistake-deck-title">
      <div className="ca-mistakes-head">
        <h3 id="mistake-deck-title">{t("mistakes.title")}</h3>
        <span className="ca-mistakes-count">{t("mistakes.count", { count: mistakes.length })}</span>
      </div>
      <div className="ca-mistakes-pile">
        <div className="mc">
          <span className="lbl">{t("mistakes.missed", { count: top.lapses })}</span>
          <p className="q">{renderInlineMarkdown(top.front)}</p>
          <div
            className="streak"
            role="img"
            aria-label={t("mistakes.streak", { count: top.streak, total: STREAK_TO_CLEAR })}
          >
            {t("mistakes.streakLabel")}
            {Array.from({ length: STREAK_TO_CLEAR }, (_, i) => (
              <i key={i} className={i < top.streak ? "on" : undefined} />
            ))}
            <span>
              {top.streak} / {STREAK_TO_CLEAR}
            </span>
          </div>
        </div>
        {mistakes.length > 1 && <div className="mc" aria-hidden="true" />}
        {mistakes.length > 2 && <div className="mc" aria-hidden="true" />}
      </div>
      <Button variant="default" size="sm" className="self-start" onClick={onReview}>
        {t("mistakes.review")}
      </Button>
    </section>
  );
}
