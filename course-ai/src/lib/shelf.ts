/** 书脊厚度（px）：按讲数取平方根铺开，1 讲也看得清名字，40 讲也不会宽成一块砖。 */
export function spineWidth(lectures: number): number {
  return Math.round(Math.min(88, 24 + Math.sqrt(Math.max(0, lectures)) * 9.5));
}
