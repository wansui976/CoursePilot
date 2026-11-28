import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOptionalShell } from "@/app/shell";
import { keyBelongsToTarget } from "@/features/player/playerPrefs";
import { keyLabel, SHORTCUT_ACTIONS, useShortcuts } from "@/stores/shortcuts";
import { Button } from "@/ui/button";
import { Modal } from "@/ui/dialog";

/** 打开速查表的全局事件：命令面板里的「键盘快捷键」也走这里。 */
export const SHORTCUT_HELP_EVENT = "course-ai:shortcut-help";

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex flex-none items-center gap-1">
      {keys.map((key) => (
        <kbd key={key} className="ca-kbd">
          {key}
        </kbd>
      ))}
    </span>
  );
}

function Section({ title, rows }: { title: string; rows: { label: string; keys: string[] }[] }) {
  return (
    <section className="min-w-0">
      <h3 className="mb-1 flex items-center gap-3 font-[var(--font-display)] text-[15px] font-medium text-[var(--text-strong)] after:h-px after:flex-1 after:bg-[var(--border-faint)]">
        {title}
      </h3>
      <ul>
        {rows.map((row) => (
          <li key={row.label} className="flex min-h-8 items-center justify-between gap-3 text-[13px] text-[var(--text-normal)]">
            <span className="min-w-0">{row.label}</span>
            <Keys keys={row.keys} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 键盘快捷键速查：不在输入框里时按 ?（Shift + /）打开。播放快捷键读设置里改过的键位，
 * 底下给一个「去设置里改」。手机上没有键盘，不挂。
 */
export function ShortcutHelp() {
  const { t } = useTranslation();
  const shell = useOptionalShell();
  const bindings = useShortcuts((s) => s.bindings);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "?" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (keyBelongsToTarget(event)) return;
      // 有别的对话框开着时不叠一层。
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]')) return;
      event.preventDefault();
      setOpen(true);
    };
    const onRequest = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(SHORTCUT_HELP_EVENT, onRequest);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SHORTCUT_HELP_EVENT, onRequest);
    };
  }, []);

  const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent) ? "⌘" : "Ctrl";
  const playback = SHORTCUT_ACTIONS.filter(({ action }) => bindings[action]).map(({ action, i18nKey }) => ({
    label: t(i18nKey),
    keys: [keyLabel(bindings[action], t)],
  }));
  const global = [
    { label: t("shortcutHelp.palette"), keys: [mod, "K"] },
    { label: t("shortcutHelp.assistant"), keys: [mod, "J"] },
    { label: t("shortcutHelp.help"), keys: ["?"] },
  ];
  const review = [
    { label: t("shortcutHelp.reveal"), keys: [t("settings.shortcuts.space")] },
    { label: t("shortcutHelp.grade"), keys: ["1", "2", "3", "4"] },
    { label: t("shortcutHelp.choose"), keys: ["A", "B", "C", "D"] },
  ];

  return (
    <Modal open={open} onOpenChange={setOpen} size="xl" title={t("shortcutHelp.title")}>
      <div className="mt-4 grid gap-x-8 gap-y-5 sm:grid-cols-2">
        <Section title={t("shortcutHelp.playback")} rows={playback} />
        <div className="flex flex-col gap-5">
          <Section title={t("shortcutHelp.global")} rows={global} />
          <Section title={t("shortcutHelp.review")} rows={review} />
        </div>
      </div>
      {shell && (
        <div className="mt-5 flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setOpen(false);
              shell.openSettingsCategory("shortcuts");
            }}
          >
            {t("shortcutHelp.customize")}
          </Button>
        </div>
      )}
    </Modal>
  );
}
