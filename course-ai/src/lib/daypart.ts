/** 一天里的四段：窗外的天色和课桌上的台灯按它变。 */
export type Daypart = "dawn" | "day" | "dusk" | "night";

export function daypartOf(date: Date): Daypart {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 5 && h < 7.5) return "dawn";
  if (h >= 7.5 && h < 17) return "day";
  if (h >= 17 && h < 19) return "dusk";
  return "night";
}

/** 台灯什么时候开：黄昏以后到天亮前。 */
export function lampOn(date: Date): boolean {
  const part = daypartOf(date);
  return part === "night" || part === "dusk";
}
