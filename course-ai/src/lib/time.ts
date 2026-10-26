import i18n from "@/i18n";

type SupportedLanguage = "zh-CN" | "en";
type RelativeUnit = "minute" | "hour" | "day";
type StudyUnit = RelativeUnit | "month" | "year";

function currentLanguage(language?: string): SupportedLanguage {
  const candidate = language ?? i18n.resolvedLanguage ?? i18n.language;
  return candidate?.toLowerCase().startsWith("en") ? "en" : "zh-CN";
}

function translated(
  key: string,
  language: SupportedLanguage,
  values?: Record<string, number | string>,
): string {
  return i18n.t(key, { lng: language, ...values });
}

function relative(value: number, unit: RelativeUnit, language: SupportedLanguage): string {
  if (language === "zh-CN") {
    const count = Math.abs(value);
    return `${studyUnit(count, unit, language)}${value < 0 ? "前" : "后"}`;
  }
  return new Intl.RelativeTimeFormat(language, { numeric: "always" }).format(value, unit);
}

function studyUnit(value: number, unit: StudyUnit, language: SupportedLanguage): string {
  return translated(`time.${unit}`, language, { count: value });
}

/**
 * 时间戳（epoch 毫秒）的相对表述：刚刚 / N 分钟前 / N 小时前 / N 天前，超过一周落到日期。
 * 未来时间（时钟回拨等）当作「刚刚」，不显示负数。
 */
export function formatRelativeTime(
  ms: number,
  now = Date.now(),
  language?: string,
): string {
  const locale = currentLanguage(language);
  const diffMinutes = Math.floor((now - ms) / 60_000);
  if (diffMinutes < 1) return translated("time.justNow", locale);
  if (diffMinutes < 60) return relative(-diffMinutes, "minute", locale);
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return relative(-diffHours, "hour", locale);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return relative(-diffDays, "day", locale);
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  if (locale === "zh-CN") {
    const values = {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
    };
    return translated(sameYear ? "time.dateSameYear" : "time.dateWithYear", locale, values);
  }
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (!sameYear) options.year = "numeric";
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/**
 * 距未来某时刻还有多久：N 分钟后 / N 小时后 / N 天后。
 * 已经过去（或不足一分钟）时返回「马上」，不显示负数。
 */
export function formatCountdown(ms: number, now = Date.now(), language?: string): string {
  const locale = currentLanguage(language);
  // 分钟向上取整：还差 30 秒说「1 分钟后」，免得「1 分钟后」因为几毫秒的流逝就变成「马上」。
  // 小时、天四舍五入：和打分按钮上的间隔（formatStudyInterval）同一种取法——刚按了「良好 4 天」，
  // 学习面板不该说「下一批 3 天后到期」（实际差 3.99 天，向下取整就成了 3）。
  const diffMinutes = Math.ceil((ms - now) / 60_000);
  if (diffMinutes < 1) return translated("time.soon", locale);
  if (diffMinutes < 60) return relative(diffMinutes, "minute", locale);
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return relative(diffHours, "hour", locale);
  return relative(Math.max(1, Math.round(diffMinutes / 1440)), "day", locale);
}

/**
 * 复习间隔的短表述，用在打分按钮上：1 分钟 / 3 天 / 1.5 个月 / 2 年。
 *
 * 与 formatCountdown 的区别是这里量的是「跨度」而不是「距某时刻」，且要短——四个档并排，
 * 每个只有一行的宽度。月和年保留一位小数（去掉多余的 .0），否则 40 天和 70 天都成了「1 个月」，
 * 分不出哪个档更划算。
 */
export function formatStudyInterval(ms: number, language?: string): string {
  const locale = currentLanguage(language);
  const oneDecimal = (value: number) => Math.round(value * 10) / 10;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return studyUnit(minutes, "minute", locale);
  const hours = ms / 3_600_000;
  if (hours < 24) return studyUnit(Math.round(hours), "hour", locale);
  const days = ms / 86_400_000;
  if (days < 30) return studyUnit(Math.round(days), "day", locale);
  const months = days / 30;
  if (months < 12) return studyUnit(oneDecimal(months), "month", locale);
  return studyUnit(oneDecimal(days / 365), "year", locale);
}

export function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
