import { beforeEach, describe, expect, it } from "vitest";
import {
  readLastRemindedDay,
  readReminderEnabled,
  shouldRemind,
  writeLastRemindedDay,
  writeReminderEnabled,
} from "./studyReminder";

describe("reminder preference storage", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to disabled and round-trips enable + last-day", () => {
    expect(readReminderEnabled()).toBe(false);
    writeReminderEnabled(true);
    expect(readReminderEnabled()).toBe(true);
    writeReminderEnabled(false);
    expect(readReminderEnabled()).toBe(false);

    expect(readLastRemindedDay()).toBeNull();
    writeLastRemindedDay("2026-07-22");
    expect(readLastRemindedDay()).toBe("2026-07-22");
  });
});

describe("shouldRemind", () => {
  const today = "2026-07-22";
  it("only fires when enabled, due, and not already reminded today", () => {
    expect(shouldRemind({ enabled: true, dueCount: 3, lastDay: null, today })).toBe(true);
    expect(shouldRemind({ enabled: false, dueCount: 3, lastDay: null, today })).toBe(false);
    expect(shouldRemind({ enabled: true, dueCount: 0, lastDay: null, today })).toBe(false);
    // 今天已提醒过 → 不再发。
    expect(shouldRemind({ enabled: true, dueCount: 3, lastDay: today, today })).toBe(false);
    // 昨天提醒过、今天又有到期 → 发。
    expect(shouldRemind({ enabled: true, dueCount: 3, lastDay: "2026-07-21", today })).toBe(true);
  });
});
