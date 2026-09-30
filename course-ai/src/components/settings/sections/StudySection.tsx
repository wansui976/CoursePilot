import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import { ipc } from "@/lib/ipc";
import { readReminderEnabled, writeReminderEnabled } from "@/lib/studyReminder";
import { Group, Row } from "../primitives";

/** 学习提醒。 */
export function StudySection() {
  const { t } = useTranslation();
  const [remindOn, setRemindOn] = useState(() => readReminderEnabled());
  async function toggleReminder(on: boolean) {
    writeReminderEnabled(on);
    setRemindOn(on);
    if (!on) return;
    try {
      await ipc.notify(t("settings.studyReminder.enabled"), t("settings.studyReminder.enabledBody"));
    } catch {
      // 权限被拒 / 发送失败时静默：开关状态仍已保存。
    }
  }

  return (
    <Group
      header={t("settings.studyReminder.title")}
      footnote={t("settings.studyReminder.footnote")}
    >
      <Row
        label={t("settings.studyReminder.label")}
        hint={t("settings.studyReminder.hint")}
        htmlFor="study-reminder"
      >
        <Switch
          id="study-reminder"
          aria-label={t("settings.studyReminder.label")}
          checked={remindOn}
          onCheckedChange={(next) => void toggleReminder(next)}
        />
      </Row>
    </Group>
  );
}
