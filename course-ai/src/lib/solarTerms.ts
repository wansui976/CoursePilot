/**
 * 二十四节气：哪天是哪个节气，配一句「初候」物候（七十二候里每个节气的第一候）。
 *
 * 日期用 21 世纪的寿星通式算：日 = ⌊Y·D + C⌋ − L，Y 为年份后两位，D = 0.2422，
 * L = ⌊Y/4⌋（小寒、大寒、立春、雨水用 ⌊(Y−1)/4⌋）。个别年份会差一天，对「黑板角落写一行字」够用。
 */
export interface SolarTerm {
  name: string;
  /** 这个节气的第一候。 */
  phenology: string;
}

/** 按月份排：每月两个节气（[名称, 物候, C 值]）。 */
const TERMS: [number, string, string, number][] = [
  [1, "小寒", "雁北乡", 5.4055],
  [1, "大寒", "鸡始乳", 20.12],
  [2, "立春", "东风解冻", 3.87],
  [2, "雨水", "獭祭鱼", 18.73],
  [3, "惊蛰", "桃始华", 5.63],
  [3, "春分", "玄鸟至", 20.646],
  [4, "清明", "桐始华", 4.81],
  [4, "谷雨", "萍始生", 20.1],
  [5, "立夏", "蝼蝈鸣", 5.52],
  [5, "小满", "苦菜秀", 21.04],
  [6, "芒种", "螳螂生", 5.678],
  [6, "夏至", "鹿角解", 21.37],
  [7, "小暑", "温风至", 7.108],
  [7, "大暑", "腐草为萤", 22.83],
  [8, "立秋", "凉风至", 7.5],
  [8, "处暑", "鹰乃祭鸟", 23.13],
  [9, "白露", "鸿雁来", 7.646],
  [9, "秋分", "雷始收声", 23.042],
  [10, "寒露", "鸿雁来宾", 8.318],
  [10, "霜降", "豺乃祭兽", 23.438],
  [11, "立冬", "水始冰", 7.438],
  [11, "小雪", "虹藏不见", 22.36],
  [12, "大雪", "鹖鴠不鸣", 7.18],
  [12, "冬至", "蚯蚓结", 21.94],
];

const EARLY = new Set(["小寒", "大寒", "立春", "雨水"]);

/** 某年某个节气落在几号（只对 2000–2099 年有效）。 */
export function solarTermDay(year: number, name: string): number | null {
  const term = TERMS.find(([, termName]) => termName === name);
  if (!term || year < 2000 || year > 2099) return null;
  const y = year % 100;
  const leap = EARLY.has(name) ? Math.floor((y - 1) / 4) : Math.floor(y / 4);
  return Math.floor(y * 0.2422 + term[3]) - leap;
}

/** 这一天（本地日期）是节气就返回它，否则 null。 */
export function solarTermOn(date: Date): SolarTerm | null {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  for (const [termMonth, name, phenology] of TERMS) {
    if (termMonth !== month) continue;
    if (solarTermDay(year, name) === date.getDate()) return { name, phenology };
  }
  return null;
}
