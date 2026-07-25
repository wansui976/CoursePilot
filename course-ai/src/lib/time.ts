/**
 * 时间戳（epoch 毫秒）的相对表述：刚刚 / N 分钟前 / N 小时前 / N 天前，超过一周落到日期。
 * 未来时间（时钟回拨等）当作「刚刚」，不显示负数。
 */
export function formatRelativeTime(ms: number, now = Date.now()): string {
  const diffMinutes = Math.floor((now - ms) / 60_000);
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays} 天前`;
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const day = `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  return sameYear ? day : `${date.getFullYear()} 年 ${day}`;
}

export function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
