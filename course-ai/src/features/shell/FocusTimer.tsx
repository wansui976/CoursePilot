import { Timer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatMs } from "@/lib/time";
import {
  BREAK_MINUTES,
  FOCUS_MINUTES,
  focusRemainingMs,
  useFocusTimer,
} from "@/stores/focusTimer";
import { Menu, MenuItem, MenuSeparator } from "@/ui/menu";

/** 计时中每秒重渲染一次，返回剩余毫秒。 */
function useRemaining() {
  const phase = useFocusTimer((s) => s.phase);
  const endsAt = useFocusTimer((s) => s.endsAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (phase === "idle") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);
  return focusRemainingMs({ phase, endsAt }, now);
}

/**
 * 侧栏 / rail 里的番茄钟入口：没在计时是一行「专注计时」，计时中尾巴上是剩余时间（等宽）。
 * 点开是一张小菜单：开始 / 停止、专注与休息时长、今天完成了几段。
 */
export function FocusTimerButton({ variant }: { variant: "sidebar" | "rail" }) {
  const { t } = useTranslation();
  const phase = useFocusTimer((s) => s.phase);
  const focusMinutes = useFocusTimer((s) => s.focusMinutes);
  const breakMinutes = useFocusTimer((s) => s.breakMinutes);
  const done = useFocusTimer((s) => s.doneToday);
  const remaining = useRemaining();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapperRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const running = phase !== "idle";
  const phaseLabel = phase === "break" ? t("focusTimer.breaking") : t("focusTimer.focusing");
  const label = running
    ? t("focusTimer.runningLabel", { phase: phaseLabel, time: formatMs(remaining) })
    : t("focusTimer.title");
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const act = (action: () => void) => {
    action();
    close();
  };
  const timer = useFocusTimer.getState;

  const trigger =
    variant === "rail" ? (
      <button
        ref={triggerRef}
        type="button"
        className={`rail-btn ${running ? "active" : ""}`}
        data-tip={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Timer className="h-[18px] w-[18px]" />
        {running && (
          <span className="rail-badge font-[var(--font-mono)]">{Math.ceil(remaining / 60_000)}</span>
        )}
      </button>
    ) : (
      <button
        ref={triggerRef}
        type="button"
        className={`ca-side-item w-full ${running ? "active" : ""}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Timer className="ic h-4 w-4" />
        <span className="nm">{running ? phaseLabel : t("focusTimer.title")}</span>
        {running ? (
          <span className="ca-side-count font-[var(--font-mono)]" aria-hidden="true">
            {formatMs(remaining)}
          </span>
        ) : done.count > 0 ? (
          <span className="ca-side-count" aria-hidden="true">
            {done.count}
          </span>
        ) : null}
      </button>
    );

  return (
    <div ref={wrapperRef} className="relative">
      {trigger}
      {open && (
        <Menu
          aria-label={t("focusTimer.title")}
          onClose={close}
          triggerRef={triggerRef}
          className={variant === "rail" ? "absolute left-full top-0 z-50 ml-2 w-64" : "mt-1 shadow-none"}
        >
          {running ? (
            <>
              {phase === "focus" && (
                <MenuItem onClick={() => act(() => timer().startBreak())}>
                  {t("focusTimer.breakNow", { minutes: breakMinutes })}
                </MenuItem>
              )}
              {phase === "break" && (
                <MenuItem onClick={() => act(() => timer().start())}>
                  {t("focusTimer.start", { minutes: focusMinutes })}
                </MenuItem>
              )}
              <MenuItem onClick={() => act(() => timer().stop())}>{t("focusTimer.stop")}</MenuItem>
            </>
          ) : (
            <>
              <MenuItem onClick={() => act(() => timer().start())}>
                {t("focusTimer.start", { minutes: focusMinutes })}
              </MenuItem>
              <MenuItem onClick={() => act(() => timer().startBreak())}>
                {t("focusTimer.breakOnly", { minutes: breakMinutes })}
              </MenuItem>
            </>
          )}
          <MenuSeparator />
          <MinutesRow
            label={t("focusTimer.focusLength")}
            options={FOCUS_MINUTES}
            value={focusMinutes}
            onChange={(minutes) => timer().setPrefs({ focusMinutes: minutes })}
          />
          <MinutesRow
            label={t("focusTimer.breakLength")}
            options={BREAK_MINUTES}
            value={breakMinutes}
            onChange={(minutes) => timer().setPrefs({ breakMinutes: minutes })}
          />
          <p className="px-2 pb-1 pt-2 text-[12px] text-[var(--text-muted)]">
            {done.count > 0
              ? t("focusTimer.today", { count: done.count, minutes: done.minutes })
              : t("focusTimer.todayNone")}
          </p>
        </Menu>
      )}
    </div>
  );
}

function MinutesRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly number[];
  value: number;
  onChange: (minutes: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={label} className="flex items-center gap-2 px-2 py-1">
      <span className="w-10 flex-none text-[12px] text-[var(--text-muted)]">{label}</span>
      <div className="flex flex-1 gap-1">
        {options.map((minutes) => (
          <button
            key={minutes}
            type="button"
            role="menuitemradio"
            aria-checked={value === minutes}
            tabIndex={-1}
            onClick={() => onChange(minutes)}
            className={`ca-hit-expand min-h-7 flex-1 rounded-[var(--r-xs)] font-[var(--font-mono)] text-[12px] transition-colors ${
              value === minutes
                ? "bg-[var(--surface-card-active)] text-[var(--text-strong)]"
                : "text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)]"
            }`}
          >
            {t("focusTimer.minutesShort", { count: minutes })}
          </button>
        ))}
      </div>
    </div>
  );
}
