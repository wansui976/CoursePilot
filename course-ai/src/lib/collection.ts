import type { ConceptMastery } from "@/lib/ipc";

/** 记忆不低于这个就算「点亮」；低于就开始褪色、该复习了（与排期的目标保持率同档）。 */
export const LIT_THRESHOLD = 0.85;

export type CardState = "lit" | "fading" | "pending" | "locked";

/** 一个知识点的卡面状态。 */
export function cardState(mastery: ConceptMastery | undefined): CardState {
  if (!mastery || mastery.cards === 0) return "locked";
  if (mastery.retention == null) return "pending";
  return mastery.retention >= LIT_THRESHOLD ? "lit" : "fading";
}
