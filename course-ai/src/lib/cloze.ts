// 文稿挖空成填空卡：把所选词在其所在句里替换成空格，句子作正面、所选词作背面（答案）。

export const CLOZE_BLANK = "＿＿＿＿";

/** 由「所在句 + 所选词」生成填空卡；只替换首次出现。调用前应确保 segmentText 含 answer。 */
export function buildCloze(
  segmentText: string,
  answer: string,
): { front: string; back: string } {
  return { front: segmentText.replace(answer, CLOZE_BLANK), back: answer };
}
