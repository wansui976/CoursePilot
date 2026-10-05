import { Clock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { panelActionButtonClass } from "./PanelActions";
import { useTimestampPrefs } from "@/stores/timestampPrefs";

/** 切换「笔记 / 提问」里可点击时间戳（▶ mm:ss）的显示。复用面板右下角图标样式。 */
export function TimestampToggle() {
  const { t } = useTranslation();
  const showTimestamps = useTimestampPrefs((s) => s.showTimestamps);
  const toggle = useTimestampPrefs((s) => s.toggle);
  const label = showTimestamps ? t("timestamp.hide") : t("timestamp.show");
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      aria-pressed={!showTimestamps}
      className={panelActionButtonClass}
    >
      <Clock className={`h-4 w-4 ${showTimestamps ? "" : "opacity-40"}`} />
    </button>
  );
}
