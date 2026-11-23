/** 一天里的四段：课桌窗外的天色按它变。 */
export type Daypart = "dawn" | "day" | "dusk" | "night";

const MIN = 60_000;

/**
 * 现在是一天里的哪一段。有当地今天的日出、日落时刻就按它们算
 * （日出前 40 分钟到日出后 50 分钟是清晨，日落前 50 分钟到日落后 40 分钟是黄昏），
 * 没有就按固定钟点。
 */
export function daypartOf(date: Date, sun?: { sunrise: number | null; sunset: number | null } | null): Daypart {
  if (sun?.sunrise != null && sun.sunset != null && sun.sunset > sun.sunrise) {
    const t = date.getTime();
    if (t >= sun.sunrise - 40 * MIN && t < sun.sunrise + 50 * MIN) return "dawn";
    if (t >= sun.sunrise + 50 * MIN && t < sun.sunset - 50 * MIN) return "day";
    if (t >= sun.sunset - 50 * MIN && t < sun.sunset + 40 * MIN) return "dusk";
    return "night";
  }
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 5 && h < 7.5) return "dawn";
  if (h >= 7.5 && h < 17) return "day";
  if (h >= 17 && h < 19) return "dusk";
  return "night";
}

export type Season = "spring" | "summer" | "autumn" | "winter";

/** 季节：按月份，南半球（纬度为负）反过来。 */
export function seasonOf(date: Date, latitude?: number | null): Season {
  const month = date.getMonth();
  const north: Season =
    month >= 2 && month <= 4 ? "spring" : month >= 5 && month <= 7 ? "summer" : month >= 8 && month <= 10 ? "autumn" : "winter";
  if (latitude == null || latitude >= 0) return north;
  return ({ spring: "autumn", summer: "winter", autumn: "spring", winter: "summer" } as const)[north];
}
