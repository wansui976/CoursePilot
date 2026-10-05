import { useTranslation } from "react-i18next";
import { ClipboardList, LayoutDashboard, Library, Settings } from "lucide-react";

export type CompactTab = "courses" | "study" | "queue" | "settings";

const TABS: { key: CompactTab; i18nKey: string; Icon: typeof Library }[] = [
  { key: "courses", i18nKey: "bottomTab.courses", Icon: Library },
  { key: "study", i18nKey: "bottomTab.study", Icon: LayoutDashboard },
  { key: "queue", i18nKey: "bottomTab.queue", Icon: ClipboardList },
  { key: "settings", i18nKey: "bottomTab.settings", Icon: Settings },
];

/** 窄屏(compact/medium)常驻底部主导航。工作台全屏时由 Home 决定不渲染。 */
export function BottomTabBar({
  active,
  queueCount = 0,
  onSelect,
}: {
  active: CompactTab;
  queueCount?: number;
  onSelect: (tab: CompactTab) => void;
}) {
  const { t } = useTranslation();
  return (
    <nav className="ca-bottom-tab" aria-label={t("nav.mainNav")}>
      {TABS.map(({ key, i18nKey, Icon }) => {
        const label = t(i18nKey);
        return (
          <button
            key={key}
            type="button"
            aria-label={label}
            aria-current={key === active ? "page" : undefined}
            className={`ca-bottom-tab-btn ${key === active ? "on" : ""}`}
            onClick={() => onSelect(key)}
          >
            <span className="relative inline-flex">
              <Icon className="h-[22px] w-[22px]" />
              {key === "queue" && queueCount > 0 && (
                <span className="ca-bottom-tab-badge">{queueCount}</span>
              )}
            </span>
            <span className="ca-bottom-tab-label">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
