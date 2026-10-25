import { vi } from "vitest";
import type { ShellNav } from "./shellNav";

/** 测试用的全局导航：所有回调都是 vi.fn()，按需覆盖。 */
export function makeNav(overrides: Partial<ShellNav> = {}): ShellNav {
  return {
    view: "library",
    libraryHomeActive: false,
    queueOpen: false,
    queueCount: 0,
    onToggleQueue: vi.fn(),
    dashboardOpen: false,
    onOpenDashboard: vi.fn(),
    assistantActive: false,
    onToggleAssistant: vi.fn(),
    theme: "light",
    themeToggleLabel: "切换到夜晚模式",
    onToggleTheme: vi.fn(),
    recycleOpen: false,
    onOpenRecycleBin: vi.fn(),
    settingsOpen: false,
    onOpenSettings: vi.fn(),
    onBackToLibrary: vi.fn(),
    onGoLibraryHome: vi.fn(),
    ...overrides,
  };
}
