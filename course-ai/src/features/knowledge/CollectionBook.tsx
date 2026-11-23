import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ipc, type CourseKnowledgeGroup } from "@/lib/ipc";
import { cardState } from "@/lib/collection";
import { qk } from "@/lib/queryKeys";
import { MistakeDeck } from "@/features/study/MistakeDeck";

/**
 * 知识点收集册：一门课是一本册子，每个知识点是一张小黑板卡。
 * 点亮（记得牢，粉笔字亮度跟着记忆走）· 褪色（快忘了，贴一张「该复习了」）·
 * 待点亮（有卡还没复习过）· 剪影（还没出过题）。没有积分和等级，奖励就是册子慢慢填满。
 */
export function CollectionBook({
  courseId,
  groups,
  onOpenConcept,
  onReviewMistakes,
}: {
  courseId: string;
  groups: CourseKnowledgeGroup[];
  onOpenConcept: (conceptId: string) => void;
  onReviewMistakes: () => void;
}) {
  const { t } = useTranslation();
  const { data: mastery = [] } = useQuery({
    queryKey: qk.srs.conceptMastery(courseId),
    queryFn: () => ipc.srs.conceptMastery(courseId),
    retry: false,
  });
  const byId = new Map(mastery.map((item) => [item.concept_id, item]));
  const all = groups.flatMap((group) => group.concepts);
  const states = all.map((concept) => cardState(byId.get(concept.id)));
  const lit = states.filter((s) => s === "lit").length;
  const fading = states.filter((s) => s === "fading").length;
  const locked = states.filter((s) => s === "locked").length;

  return (
    <div className="ca-book">
      <div className="ca-stats">
        <div className="ca-stat">
          <span className="v">
            {lit}
            <small>/ {all.length}</small>
          </span>
          <span className="k">{t("collection.lit")}</span>
        </div>
        <div className="ca-stat">
          <span className="v">{fading}</span>
          <span className="k">{t("collection.fading")}</span>
        </div>
        <div className="ca-stat">
          <span className="v">{locked}</span>
          <span className="k">{t("collection.locked")}</span>
        </div>
      </div>

      {groups.map((group) => (
        <section key={group.title} className="ca-book-group">
          <div className="ca-section-head">
            <h3>{group.title}</h3>
          </div>
          <div className="ca-book-grid">
            {group.concepts.map((concept) => {
              const info = byId.get(concept.id);
              const state = cardState(info);
              const retention = info?.retention ?? 0;
              return (
                <button
                  key={concept.id}
                  type="button"
                  className={`ca-kcard ${state}`}
                  style={{ "--r": state === "lit" || state === "fading" ? retention : 0.3 } as React.CSSProperties}
                  onClick={() => onOpenConcept(concept.id)}
                  aria-label={`${concept.name}，${t(`collection.state.${state}`)}`}
                >
                  <span className="k">{concept.name}</span>
                  {state === "fading" && <span className="tab">{t("collection.dueTab")}</span>}
                  <span className="m">
                    {state === "locked" ? (
                      t("collection.noCards")
                    ) : state === "pending" ? (
                      t("collection.notReviewed", { count: info?.cards ?? 0 })
                    ) : (
                      <>
                        <i>
                          <b />
                        </i>
                        {Math.round(retention * 100)}%
                      </>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      <MistakeDeck courseId={courseId} onReview={onReviewMistakes} className="ca-book-mistakes" />
    </div>
  );
}
