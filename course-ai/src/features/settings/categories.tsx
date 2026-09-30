/** 设置分类：路由参数 `/settings/$category` 的取值即这里的键。 */
import { type ReactNode } from "react";
import { AudioLines, Bell, FolderCog, Keyboard, Palette, ScanText, Sparkles, Terminal } from "lucide-react";

export type SettingsCategory =
  | "appearance"
  | "study"
  | "shortcuts"
  | "storage"
  | "asr"
  | "llm"
  | "courseware"
  | "dev";

export const CATEGORY_META: Record<
  SettingsCategory,
  { i18nKey: string; icon: ReactNode; tint: string }
> = {
  appearance: { i18nKey: "settings.categories.appearance", icon: <Palette className="h-3.5 w-3.5" />, tint: "#e0568f" },
  study: { i18nKey: "settings.categories.study", icon: <Bell className="h-3.5 w-3.5" />, tint: "#0ea5e9" },
  shortcuts: { i18nKey: "settings.categories.shortcuts", icon: <Keyboard className="h-3.5 w-3.5" />, tint: "#10b981" },
  storage: { i18nKey: "settings.categories.storage", icon: <FolderCog className="h-3.5 w-3.5" />, tint: "#8e8e93" },
  asr: { i18nKey: "settings.categories.asr", icon: <AudioLines className="h-3.5 w-3.5" />, tint: "#2f6cea" },
  llm: { i18nKey: "settings.categories.llm", icon: <Sparkles className="h-3.5 w-3.5" />, tint: "#a855f7" },
  courseware: { i18nKey: "settings.categories.courseware", icon: <ScanText className="h-3.5 w-3.5" />, tint: "#f59e0b" },
  dev: { i18nKey: "settings.categories.dev", icon: <Terminal className="h-3.5 w-3.5" />, tint: "#64748b" },
};

/** 分类的展示顺序。开发者分类只在宿主提供控制台入口时出现。 */
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  "appearance",
  "study",
  "shortcuts",
  "storage",
  "asr",
  "llm",
  "courseware",
  "dev",
];

export function isSettingsCategory(value: unknown): value is SettingsCategory {
  return typeof value === "string" && (SETTINGS_CATEGORIES as string[]).includes(value);
}
