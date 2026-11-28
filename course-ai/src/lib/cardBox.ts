/** 五格的上界（毫秒，与后端 CARD_BOX_BOUNDS_MS 一致）：今天、明天、一周内、一个月内，其余算更久。 */
const DAY = 86_400_000;
export const CARD_BOX_BOUNDS = [DAY, 2 * DAY, 7 * DAY, 30 * DAY];

/** 评完分这张卡要落进哪一格：按这一档推到多久之后（打分按钮上显示的那个间隔）。 */
export function cardBoxSlot(intervalMs: number): number {
  const slot = CARD_BOX_BOUNDS.findIndex((bound) => intervalMs <= bound);
  return slot === -1 ? CARD_BOX_BOUNDS.length : slot;
}

/** 一摞卡在格子里占多宽（%）：按最满的那格比，有卡就至少看得见一薄片。 */
export function packWidth(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.round(10 + (90 * count) / max);
}
