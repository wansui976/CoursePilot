/**
 * 按标题里的讲次给视频排序：「P03」「第十二讲」「Lecture 3」「03 绪论」。
 *
 * 一批视频常同时带好几种编号（B 站分 P 的「P5 第二讲（上）」），混着用会打架，
 * 所以先挑一种写法：能认出最多标题的那种，一样多时按下面 SCHEMES 的顺序。
 * 认不出编号的视频排在最后，保持它们原来的相对顺序。
 */

const CHINESE_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 「12」「十二」「一百零五」→ 数字；认不出返回 null。 */
export function parseLectureNumber(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  let total = 0;
  let current = 0;
  let any = false;
  for (const ch of text) {
    if (ch in CHINESE_DIGITS) {
      current = CHINESE_DIGITS[ch];
    } else if (ch === "十" || ch === "百") {
      total += (current || 1) * (ch === "十" ? 10 : 100);
      current = 0;
    } else {
      return null;
    }
    any = true;
  }
  return any ? total + current : null;
}

type Scheme = (title: string) => number | null;

const SCHEMES: Scheme[] = [
  // B 站分 P：前面不能紧挨着字母数字（mp4、app3 不算）。
  (title) => {
    const match = title.match(/(?:^|[^a-z0-9])p(\d{1,4})(?![a-z0-9])/i);
    return match ? Number(match[1]) : null;
  },
  // 第 N 讲 / 课 / 节 / 章 / 集 …
  (title) => {
    const match = title.match(
      /第\s*(\d+|[零〇一二两三四五六七八九十百]+)\s*(?:讲|講|课|課|节|節|章|集|期|回|部分|单元|篇|周|天)/,
    );
    return match ? parseLectureNumber(match[1]) : null;
  },
  // Lecture 3 / Lec03 / Ch.2 / Part 1 / Episode 4 …
  (title) => {
    const match = title.match(
      /\b(?:lecture|lec|lesson|chapter|ch|part|pt|episode|ep|week|day|unit|session|module)[\s._-]*(\d{1,4})(?!\d)/i,
    );
    return match ? Number(match[1]) : null;
  },
  // 序号开头：「03 绪论」「1. 引言」「(2) 回归」。最多三位，免得把「2024 年真题」当成第 2024 讲。
  (title) => {
    const match = title.match(/^\s*[[(【]?\s*(\d{1,3})(?=[\s.、_\-)\]】:：]|$)/);
    return match ? Number(match[1]) : null;
  },
];

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

/**
 * 按讲次排好的 id 顺序。能认出讲次的不到两个时返回 null（排不出什么来，界面上不给这个动作）。
 */
export function lectureOrder(videos: readonly { id: string; title: string }[]): string[] | null {
  // 全角数字、全角括号先规整成半角。
  const titles = videos.map((video) => video.title.normalize("NFKC"));
  let best: (number | null)[] = [];
  let bestCount = 0;
  for (const scheme of SCHEMES) {
    const numbers = titles.map(scheme);
    const count = numbers.filter((n) => n !== null).length;
    if (count > bestCount) {
      best = numbers;
      bestCount = count;
    }
  }
  if (bestCount < 2) return null;
  return videos
    .map((video, index) => ({ id: video.id, title: titles[index], number: best[index], index }))
    .sort((a, b) => {
      if (a.number === null || b.number === null) {
        if (a.number !== b.number) return a.number === null ? 1 : -1;
        return a.index - b.index;
      }
      // 同一讲分上下集：按标题再比一次（数字按大小比）；还一样就保持原顺序。
      return a.number - b.number || collator.compare(a.title, b.title) || a.index - b.index;
    })
    .map((item) => item.id);
}
