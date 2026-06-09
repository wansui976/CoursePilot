import { ClipboardList, Library, Settings } from "lucide-react";

export type CompactTab = "courses" | "queue" | "settings";

const TABS: { key: CompactTab; label: string; Icon: typeof Library }[] = [
  { key: "courses", label: "课程", Icon: Library },
  { key: "queue", label: "队列", Icon: ClipboardList },
  { key: "settings", label: "设置", Icon: Settings },
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
  return (
    <nav className="ca-bottom-tab" aria-label="主导航">
      {TABS.map(({ key, label, Icon }) => (
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
      ))}
    </nav>
  );
}
