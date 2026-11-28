import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { renderInlineMarkdown } from "@/lib/renderMarkdown";
import { prefersReducedMotion } from "@/lib/viewTransition";
import { Button } from "@/ui/button";

/** 连对几次赢回来（与后端 MISTAKE_STREAK_TO_CLEAR 一致）。 */
const STREAK_TO_CLEAR = 3;
/** 翻一张：最上面那张绕活页环转开的时长（与 design.css 的 ca-ring-flip 一致）。 */
const FLIP_MS = 340;
/** 环上最多看得见几张（最上面一张 + 后面两张露出的边）。 */
const VISIBLE = 3;

/**
 * 错题本：答错过的卡打了孔、串在一只活页环上，像考前那串抽认卡。最上面一张写题面、
 * 答错次数和「连对 ●○○」；后面的卡绕着环微微张开，露得越多还剩越多。点一下（或按 →）
 * 最上面那张绕环转开、翻到最后。连对三次的那张从环上取下（数据刷新后它就不在了）。
 * 这次打开时还有错题、后来都赢回来了：只剩一只空环和一句话；一开始就没有错题：什么都不显示。
 * courseId 为空时是全部课程。
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
  const [offset, setOffset] = useState(0);
  const [flipping, setFlipping] = useState(false);
  const hadMistakes = useRef(false);
  if (mistakes.length > 0) hadMistakes.current = true;

  useEffect(() => {
    if (offset >= mistakes.length) setOffset(0);
  }, [mistakes.length, offset]);

  if (mistakes.length === 0) {
    if (!hadMistakes.current) return null;
    return (
      <section className={`ca-mistakes ${className ?? ""}`} aria-labelledby="mistake-deck-title">
        <div className="ca-mistakes-head">
          <h3 id="mistake-deck-title">{t("mistakes.title")}</h3>
        </div>
        <div className="ca-ring-deck" data-empty="">
          <span className="ca-ring" aria-hidden="true" />
          <p className="ca-ring-empty">{t("mistakes.allWon")}</p>
        </div>
      </section>
    );
  }

  const count = mistakes.length;
  const start = offset % count;
  const order = Array.from({ length: Math.min(VISIBLE, count) }, (_, i) => mistakes[(start + i) % count]);
  const top = order[0];

  function flip() {
    if (count < 2 || flipping) return;
    if (prefersReducedMotion()) {
      setOffset((value) => value + 1);
      return;
    }
    setFlipping(true);
    window.setTimeout(() => {
      setFlipping(false);
      setOffset((value) => value + 1);
    }, FLIP_MS);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      flip();
    }
  }

  return (
    <section className={`ca-mistakes ${className ?? ""}`} aria-labelledby="mistake-deck-title">
      <div className="ca-mistakes-head">
        <h3 id="mistake-deck-title">{t("mistakes.title")}</h3>
        <span className="ca-mistakes-count">{t("mistakes.count", { count })}</span>
      </div>
      <div className="ca-ring-deck">
        {/* 后面的卡先画，绕着环一张比一张张得开一点。 */}
        {order
          .slice(1)
          .reverse()
          .map((card, index, rest) => (
            <div
              key={`${card.card_id}-under`}
              className="ca-ring-card"
              data-depth={rest.length - index}
              aria-hidden="true"
            >
              <span className="ca-ring-hole" />
            </div>
          ))}
        <button
          key={top.card_id}
          type="button"
          className="ca-ring-card ca-ring-card--top"
          data-flipping={flipping ? "" : undefined}
          disabled={count < 2}
          aria-label={count > 1 ? t("mistakes.flip", { index: start + 1, total: count }) : undefined}
          onClick={flip}
          onKeyDown={onKeyDown}
        >
          <span className="ca-ring-hole" aria-hidden="true" />
          <span className="lbl">{t("mistakes.missed", { count: top.lapses })}</span>
          <span className="q">{renderInlineMarkdown(top.front)}</span>
          <span
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
          </span>
        </button>
        <span className="ca-ring" aria-hidden="true" />
      </div>
      <Button variant="default" size="sm" className="self-start" onClick={onReview}>
        {t("mistakes.review")}
      </Button>
    </section>
  );
}
