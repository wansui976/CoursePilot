import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/ui/button";
import { SHORTCUT_ACTIONS, keyLabel, useShortcuts, type ShortcutAction } from "@/stores/shortcuts";
import { Group, Row, StackRow } from "@/features/settings/primitives";

/** 快捷键：点按后录入下一次按键，Esc 取消。 */
export function ShortcutsSection() {
  const { t } = useTranslation();
  const bindings = useShortcuts((s) => s.bindings);
  const setBinding = useShortcuts((s) => s.setBinding);
  const resetBindings = useShortcuts((s) => s.resetBindings);
  // 正在为哪个动作录入新按键（null = 不在录入）。录入时下一次按键即写入；Esc 取消。
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(null);
        return;
      }
      // 单按修饰键不作为快捷键。
      if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
      setBinding(capturing, event.key);
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, setBinding]);

  return (
    <Group
      header={t("settings.shortcuts.title")}
    >
      {SHORTCUT_ACTIONS.map(({ action, i18nKey, i18nHint }) => (
        <Row key={action} label={t(i18nKey)} hint={i18nHint ? t(i18nHint) : undefined}>
          <button
            type="button"
            onClick={() => setCapturing(action)}
            aria-label={t("settings.shortcuts.setKey", { label: t(i18nKey) })}
            className={`min-h-11 min-w-[88px] rounded-lg border px-3 py-1.5 text-center text-sm font-medium transition ${
              capturing === action
                ? "border-[var(--accent-text)] bg-[var(--accent-weak)] text-[var(--accent-text)]"
                : "border-[var(--border-subtle)] bg-[var(--surface-input)] text-[var(--text-strong)] hover:border-[var(--text-faint)]"
            }`}
          >
            {capturing === action ? t("settings.shortcuts.pressKey") : keyLabel(bindings[action], t)}
          </button>
        </Row>
      ))}
      <StackRow>
        <Button variant="outline" size="sm" onClick={resetBindings}>
          {t("settings.shortcuts.restoreDefaults")}
        </Button>
      </StackRow>
    </Group>
  );
}
