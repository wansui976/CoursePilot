import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { playSound } from "@/lib/feedback";
import { ipc } from "@/lib/ipc";
import { useFocusTimer } from "@/stores/focusTimer";

/**
 * 外壳挂一次：每秒推一下番茄钟；一段结束时响一声、发一条系统通知
 * （应用在后台、窗口被盖住时也知道该休息了）。
 */
export function useFocusTicker() {
  const { t } = useTranslation();
  const phase = useFocusTimer((s) => s.phase);
  useEffect(() => {
    if (phase === "idle") return;
    // 先推一次：重新打开应用时上一段可能早就到点了。
    useFocusTimer.getState().tick();
    const timer = window.setInterval(() => useFocusTimer.getState().tick(), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);
  useEffect(
    () =>
      useFocusTimer.subscribe((state, previous) => {
        const transition = state.lastTransition;
        if (!transition || transition === previous.lastTransition) return;
        playSound("stamp");
        const title =
          transition.from === "focus" ? t("focusTimer.focusDoneTitle") : t("focusTimer.breakDoneTitle");
        const body =
          transition.from === "focus"
            ? transition.to === "break"
              ? t("focusTimer.focusDoneBody", { minutes: state.breakMinutes, count: state.doneToday.count })
              : t("focusTimer.focusDoneStopped", { count: state.doneToday.count })
            : t("focusTimer.breakDoneBody");
        void ipc.notify(title, body).catch(() => undefined);
      }),
    [t],
  );
}
