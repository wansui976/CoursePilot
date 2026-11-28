/**
 * 命令面板（⌘K / Ctrl+K）的纯逻辑：匹配打分、时间输入解析。
 * 面板本身在 features/shell/CommandPalette。
 */

export type PaletteGroup = "time" | "page" | "course" | "video" | "setting";

export interface PaletteEntry {
  id: string;
  group: PaletteGroup;
  label: string;
  /** 第二行的淡字（视频所属课程等），也参与匹配，但分数低一档。 */
  detail?: string;
  /** 额外的同义词（英文名、拼音首字母之类），只参与匹配不显示。 */
  keywords?: string[];
}

const GROUP_ORDER: Record<PaletteGroup, number> = {
  time: 0,
  page: 1,
  course: 2,
  video: 3,
  setting: 4,
};

function normalize(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 一段文字对查询的匹配分（0 = 不匹配）：开头命中 > 词首命中 > 中间连续命中 > 按顺序零散命中。
 * 中文没有词边界，零散命中（「梯下」→「梯度下降」）也算，只是分低。
 */
export function matchScore(query: string, text: string): number {
  const q = normalize(query);
  if (!q) return 1;
  const s = normalize(text);
  if (!s) return 0;
  if (s === q) return 100;
  if (s.startsWith(q)) return 80;
  const index = s.indexOf(q);
  if (index > 0) {
    const before = s[index - 1];
    return /[\s\-_/·.，、（(【[]/.test(before) ? 65 : 55;
  }
  // 按顺序零散命中：每个字都在、顺序对。字越挤在一起分越高。
  let from = 0;
  let first = -1;
  let last = -1;
  for (const char of q) {
    if (char === " ") continue;
    const at = s.indexOf(char, from);
    if (at < 0) return 0;
    if (first < 0) first = at;
    last = at;
    from = at + 1;
  }
  const spread = last - first + 1;
  const compact = q.replace(/\s/g, "").length / Math.max(1, spread);
  return Math.round(15 + 25 * compact);
}

/** 条目对查询的分：标题和同义词按原分，第二行的淡字打七折。 */
export function entryScore(query: string, entry: PaletteEntry): number {
  const scores = [
    matchScore(query, entry.label),
    ...(entry.keywords ?? []).map((keyword) => matchScore(query, keyword) * 0.9),
    entry.detail ? matchScore(query, entry.detail) * 0.7 : 0,
  ];
  return Math.max(...scores);
}

/**
 * 按查询过滤并排序。空查询时保持原顺序（各组自己排好的「最近」「常用」），
 * 每组最多 `perGroup` 条，免得一门课几百个视频把页面、设置挤出去。
 */
export function rankEntries<T extends PaletteEntry>(
  entries: readonly T[],
  query: string,
  perGroup = 6,
): T[] {
  const scored = entries
    .map((entry, index) => ({ entry, index, score: entryScore(query, entry) }))
    .filter((item) => item.score > 0);
  if (normalize(query)) {
    scored.sort(
      (a, b) =>
        GROUP_ORDER[a.entry.group] - GROUP_ORDER[b.entry.group] ||
        b.score - a.score ||
        a.index - b.index,
    );
  } else {
    scored.sort((a, b) => GROUP_ORDER[a.entry.group] - GROUP_ORDER[b.entry.group] || a.index - b.index);
  }
  const counts = new Map<PaletteGroup, number>();
  const out: T[] = [];
  for (const { entry } of scored) {
    const count = counts.get(entry.group) ?? 0;
    if (count >= perGroup) continue;
    counts.set(entry.group, count + 1);
    out.push(entry);
  }
  return out;
}

/**
 * 把「12:30」「1:02:03」「90s」「5m」「5分」「1 小时 2 分」这类输入解析成毫秒；不像时间就返回 null。
 * 纯数字不算（会和课程名里的「第 3 讲」撞上）。
 */
export function parseTimeQuery(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  const clock = /^(\d{1,3}):([0-5]?\d)(?::([0-5]?\d))?$/.exec(text);
  if (clock) {
    const [, a, b, c] = clock;
    const seconds = c != null ? Number(a) * 3600 + Number(b) * 60 + Number(c) : Number(a) * 60 + Number(b);
    return seconds * 1000;
  }
  const unitPattern = /(\d+(?:\.\d+)?)\s*(h|小时|时|m|min|分钟|分|s|sec|秒)/g;
  let total = 0;
  let consumed = "";
  let match: RegExpExecArray | null;
  while ((match = unitPattern.exec(text))) {
    const value = Number(match[1]);
    const unit = match[2];
    if (unit === "h" || unit === "小时" || unit === "时") total += value * 3600;
    else if (unit.startsWith("m") || unit.startsWith("分")) total += value * 60;
    else total += value;
    consumed += match[0];
  }
  if (!consumed) return null;
  // 除了数字和单位之外还有别的字，就不是在输时间。
  if (text.replace(/\s/g, "") !== consumed.replace(/\s/g, "")) return null;
  return Math.round(total * 1000);
}

/** ⌘K / Ctrl+K：在打字框里、或别的对话框开着时也照样能叫出来（和大多数桌面应用一样）。 */
export function isPaletteShortcut(event: KeyboardEvent) {
  return (
    event.key.toLowerCase() === "k" &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}
