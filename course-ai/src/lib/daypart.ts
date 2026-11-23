/** 一天里的四段：课桌窗外的天色按它变。 */
export type Daypart = "dawn" | "day" | "dusk" | "night";

export function daypartOf(date: Date): Daypart {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 5 && h < 7.5) return "dawn";
  if (h >= 7.5 && h < 17) return "day";
  if (h >= 17 && h < 19) return "dusk";
  return "night";
}
