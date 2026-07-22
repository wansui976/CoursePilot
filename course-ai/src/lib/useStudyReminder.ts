import { useEffect } from "react";
import { ipc } from "./ipc";
import { localDay } from "./studyStats";
import {
  readLastRemindedDay,
  readReminderEnabled,
  shouldRemind,
  writeLastRemindedDay,
} from "./studyReminder";

/**
 * 应用打开时的学习提醒：开启、今天有到期卡、且今天还没提醒过 → 发一条桌面通知
 * （每天至多一次）。默认关闭，故未开启时直接返回、不触任何后端调用。
 */
export function useStudyReminder() {
  useEffect(() => {
    if (!readReminderEnabled()) return;
    const today = localDay(new Date());
    if (readLastRemindedDay() === today) return;
    void (async () => {
      try {
        const due = await ipc.srs.countDue();
        if (shouldRemind({ enabled: true, dueCount: due, lastDay: readLastRemindedDay(), today })) {
          await ipc.notify("该复习啦", `今天有 ${due} 张卡待复习，回来过一遍吧。`);
          writeLastRemindedDay(today);
        }
      } catch {
        // 无通知权限/发送失败时静默，不影响使用。
      }
    })();
  }, []);
}
