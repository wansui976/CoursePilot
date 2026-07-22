// 学习提醒的偏好与去重状态（localStorage）+ 纯决策函数。默认关闭（opt-in）。

const ENABLED_KEY = "course-ai-reminder-enabled";
const LAST_DAY_KEY = "course-ai-reminder-last-day";

export function readReminderEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeReminderEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  } catch {
    // ignore storage failures.
  }
}

export function readLastRemindedDay(): string | null {
  try {
    return localStorage.getItem(LAST_DAY_KEY);
  } catch {
    return null;
  }
}

export function writeLastRemindedDay(day: string): void {
  try {
    localStorage.setItem(LAST_DAY_KEY, day);
  } catch {
    // ignore storage failures.
  }
}

/** 是否该发提醒：已开启、有到期卡、今天还没提醒过（每天至多一次）。 */
export function shouldRemind(args: {
  enabled: boolean;
  dueCount: number;
  lastDay: string | null;
  today: string;
}): boolean {
  return args.enabled && args.dueCount > 0 && args.lastDay !== args.today;
}
