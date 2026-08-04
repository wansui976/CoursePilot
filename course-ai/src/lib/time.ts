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

/**
 * 距未来某时刻还有多久：N 分钟后 / N 小时后 / N 天后。
 * 已经过去（或不足一分钟）时返回「马上」，不显示负数。
 */
export function formatCountdown(ms: number, now = Date.now()): string {
  // 向上取整：还差 30 秒说「1 分钟后」，差 2 小时 59 分说「3 小时后」——倒计时说大不说小，
  // 也免得「3 小时后到期」因为几毫秒的流逝就退化成「2 小时后」。
  const diffMinutes = Math.ceil((ms - now) / 60_000);
  if (diffMinutes < 1) return "马上";
  if (diffMinutes < 60) return `${diffMinutes} 分钟后`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时后`;
  return `${Math.floor(diffHours / 24)} 天后`;
}

/**
 * 复习间隔的短表述，用在打分按钮上：1 分钟 / 3 天 / 1.5 个月 / 2 年。
 *
 * 与 formatCountdown 的区别是这里量的是「跨度」而不是「距某时刻」，且要短——四个档并排，
 * 每个只有一行的宽度。月和年保留一位小数（去掉多余的 .0），否则 40 天和 70 天都成了「1 个月」，
 * 分不出哪个档更划算。
 */
export function formatStudyInterval(ms: number): string {
  const oneDecimal = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = ms / 3_600_000;
  if (hours < 24) return `${Math.round(hours)} 小时`;
  const days = ms / 86_400_000;
  if (days < 30) return `${Math.round(days)} 天`;
  const months = days / 30;
  if (months < 12) return `${oneDecimal(months)} 个月`;
  return `${oneDecimal(days / 365)} 年`;
}

export function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
