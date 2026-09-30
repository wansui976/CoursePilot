import {
  Book,
  ClipboardList,
  LayoutDashboard,
  Library,
  Moon,
  PanelLeftOpen,
  Settings,
  Sparkles,
  Sun,
  Trash2,
} from "lucide-react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { setThemeToggleOrigin } from "@/stores/theme";

/**
 * 全局唯一常驻细 rail（桌面端两态都渲染），接管所有全局动作：
 * 返回首页、展开侧栏、队列、Dashboard、助手开关、主题、回收站、设置。
 * 展开侧栏只保留课程相关的专属内容，不再重复这些全局按钮。
 */
export function AppRail({
  view,
  sidebarExpanded,
  onExpandSidebar,
  queueOpen,
  queueCount,
  onToggleQueue,
  onOpenDashboard,
  assistantActive,
  onToggleAssistant,
  theme,
  themeToggleLabel,
  onToggleTheme,
  onOpenRecycleBin,
  onOpenSettings,
  onBackToLibrary,
  onGoLibraryHome,
}: {
  view: "library" | "workbench";
  sidebarExpanded: boolean;
  onExpandSidebar: () => void;
  queueOpen: boolean;
  queueCount: number;
  onToggleQueue: () => void;
  onOpenDashboard: () => void;
  assistantActive: boolean;
  onToggleAssistant: () => void;
  theme: "dark" | "light";
  themeToggleLabel: string;
  onToggleTheme: () => void;
  onOpenRecycleBin: () => void;
  onOpenSettings: () => void;
  onBackToLibrary: () => void;
  onGoLibraryHome: () => void;
}) {
  const { t } = useTranslation();

  function toggleThemeFrom(event: MouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setThemeToggleOrigin(rect.left + rect.width / 2, rect.top + rect.height / 2);
    onToggleTheme();
  }

  const inWorkbench = view === "workbench";

  return (
    <nav className="ca-rail" aria-label={t("nav.toolbar")}>
      <button
        className="rail-logo"
        data-tip={inWorkbench ? t("nav.backToLibrary") : t("nav.libraryHome")}
        aria-label={inWorkbench ? t("nav.backToLibrary") : t("nav.libraryHome")}
        onClick={inWorkbench ? onBackToLibrary : onGoLibraryHome}
      >
        {inWorkbench ? <Book className="h-[18px] w-[18px]" /> : <Library className="h-[18px] w-[18px]" />}
      </button>
      {!sidebarExpanded && (
        <button
          className="rail-btn"
          data-tip={t("nav.expandSidebar")}
          aria-label={t("nav.expandSidebar")}
          onClick={onExpandSidebar}
        >
          <PanelLeftOpen className="h-5 w-5" />
        </button>
      )}
      {view === "library" && (
        <button
          className={`rail-btn ${queueOpen ? "active" : ""}`}
          data-tip={t("nav.queue")}
          aria-label={t("nav.queue")}
          onClick={onToggleQueue}
        >
          <ClipboardList className="h-5 w-5" />
          {queueCount > 0 && <span className="rail-badge">{queueCount}</span>}
        </button>
      )}
      <button
        className="rail-btn"
        data-tip={t("nav.dashboard")}
        aria-label={t("nav.dashboard")}
        onClick={onOpenDashboard}
      >
        <LayoutDashboard className="h-5 w-5" />
      </button>
      <button
        className={`rail-btn ${assistantActive ? "active" : ""}`}
        data-tip={t("assistant.toggleAssistant")}
        aria-label={t("assistant.toggleAssistant")}
        onClick={onToggleAssistant}
      >
        <Sparkles className="h-5 w-5" />
      </button>
      <div className="rail-sp" />
      <div className="rail-divider" aria-hidden="true" />
      <button
        className="rail-btn"
        data-tip={themeToggleLabel}
        aria-label={themeToggleLabel}
        onClick={toggleThemeFrom}
      >
        {theme === "light" ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
      </button>
      <button
        className="rail-btn"
        data-tip={t("nav.recycleBin")}
        aria-label={t("nav.recycleBin")}
        onClick={onOpenRecycleBin}
      >
        <Trash2 className="h-5 w-5" />
      </button>
      <button
        className="rail-btn"
        data-tip={t("nav.settings")}
        aria-label={t("nav.settings")}
        onClick={onOpenSettings}
      >
        <Settings className="h-5 w-5" />
      </button>
    </nav>
  );
}