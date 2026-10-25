import type { MouseEvent } from "react";
import { setThemeToggleOrigin } from "@/stores/theme";

/**
 * 全局导航动作：课程库、学习面板、处理队列、助手、主题、回收站、设置。
 * 侧栏展开时由 AppSidebar 以「图标 + 文字」列出，收起时由 AppRail 以纯图标列出——
 * 同一组入口只在一处出现，不再「细 rail + 宽侧栏」两列并排。
 */
export type ShellNav = {
  view: "library" | "workbench";
  /** 课程库首页（没选课程、没开别的页）：课程库入口显示为当前页。 */
  libraryHomeActive: boolean;
  queueOpen: boolean;
  queueCount: number;
  onToggleQueue: () => void;
  dashboardOpen: boolean;
  onOpenDashboard: () => void;
  assistantActive: boolean;
  onToggleAssistant: () => void;
  theme: "dark" | "light";
  themeToggleLabel: string;
  onToggleTheme: () => void;
  recycleOpen: boolean;
  onOpenRecycleBin: () => void;
  settingsOpen: boolean;
  onOpenSettings: () => void;
  onBackToLibrary: () => void;
  onGoLibraryHome: () => void;
};

/** 主题切换：记下按钮中心，圆形揭开动画从这里展开。 */
export function toggleThemeFrom(event: MouseEvent<HTMLElement>, onToggleTheme: () => void) {
  const rect = event.currentTarget.getBoundingClientRect();
  setThemeToggleOrigin(rect.left + rect.width / 2, rect.top + rect.height / 2);
  onToggleTheme();
}
