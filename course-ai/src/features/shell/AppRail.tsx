import {
  ArrowLeft,
  ChevronRight,
  ClipboardList,
  LayoutDashboard,
  Library,
  MessageSquareText,
  Moon,
  Settings,
  Sun,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAssistantUi } from "@/stores/assistant";
import { toggleThemeFrom, type ShellNav } from "./shellNav";

/**
 * 侧栏收起时的细 rail：只有图标，入口与展开的侧栏一一对应（见 ShellNav）。
 * 侧栏展开时不渲染——同一组入口不在两列里重复出现。
 */
export function AppRail({ nav, onExpandSidebar }: { nav: ShellNav; onExpandSidebar: () => void }) {
  const assistantUnread = useAssistantUi((state) => state.unread);
  const { t } = useTranslation();
  const inWorkbench = nav.view === "workbench";

  return (
    <nav className="ca-rail" aria-label={t("nav.toolbar")}>
      <button
        className="rail-btn"
        data-tip={t("nav.expandSidebar")}
        aria-label={t("nav.expandSidebar")}
        onClick={onExpandSidebar}
      >
        <ChevronRight className="h-[18px] w-[18px]" />
      </button>
      <div className="rail-divider" aria-hidden="true" />
      <button
        className={`rail-btn ${nav.libraryHomeActive ? "active" : ""}`}
        data-tip={inWorkbench ? t("nav.backToLibrary") : t("nav.libraryHome")}
        aria-label={inWorkbench ? t("nav.backToLibrary") : t("nav.libraryHome")}
        onClick={inWorkbench ? nav.onBackToLibrary : nav.onGoLibraryHome}
      >
        {inWorkbench ? (
          <ArrowLeft className="h-[18px] w-[18px]" />
        ) : (
          <Library className="h-[18px] w-[18px]" />
        )}
      </button>
      <button
        className={`rail-btn ${nav.dashboardOpen ? "active" : ""}`}
        data-tip={t("nav.dashboard")}
        aria-label={t("nav.dashboard")}
        onClick={nav.onOpenDashboard}
      >
        <LayoutDashboard className="h-[18px] w-[18px]" />
      </button>
      {nav.view === "library" && (
        <button
          className={`rail-btn ${nav.queueOpen ? "active" : ""}`}
          data-tip={t("nav.queue")}
          aria-label={t("nav.queue")}
          onClick={nav.onToggleQueue}
        >
          <ClipboardList className="h-[18px] w-[18px]" />
          {nav.queueCount > 0 && <span className="rail-badge">{nav.queueCount}</span>}
        </button>
      )}
      <button
        className={`rail-btn ${nav.assistantActive ? "active" : ""}`}
        data-tip={t("assistant.toggleAssistant")}
        data-tour="assistant"
        aria-label={t("assistant.toggleAssistant")}
        onClick={nav.onToggleAssistant}
      >
        <MessageSquareText className="h-[18px] w-[18px]" />
        {assistantUnread && !nav.assistantActive && (
          <span className="rail-dot" aria-hidden="true" />
        )}
      </button>
      <div className="rail-sp" />
      <button
        className="rail-btn"
        data-tip={nav.themeToggleLabel}
        aria-label={nav.themeToggleLabel}
        onClick={(event) => toggleThemeFrom(event, nav.onToggleTheme)}
      >
        {nav.theme === "light" ? (
          <Moon className="h-[18px] w-[18px]" />
        ) : (
          <Sun className="h-[18px] w-[18px]" />
        )}
      </button>
      <button
        className={`rail-btn ${nav.recycleOpen ? "active" : ""}`}
        data-tip={t("nav.recycleBin")}
        aria-label={t("nav.recycleBin")}
        onClick={nav.onOpenRecycleBin}
      >
        <Trash2 className="h-[18px] w-[18px]" />
      </button>
      <button
        className={`rail-btn ${nav.settingsOpen ? "active" : ""}`}
        data-tip={t("nav.settings")}
        data-tour="settings"
        aria-label={t("nav.settings")}
        onClick={nav.onOpenSettings}
      >
        <Settings className="h-[18px] w-[18px]" />
      </button>
    </nav>
  );
}
