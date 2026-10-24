/** 设置分类：路由参数 `/settings/$category` 的取值即这里的键。 */

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
  { i18nKey: string }
> = {
  appearance: { i18nKey: "settings.categories.appearance" },
  study: { i18nKey: "settings.categories.study" },
  shortcuts: { i18nKey: "settings.categories.shortcuts" },
  storage: { i18nKey: "settings.categories.storage" },
  asr: { i18nKey: "settings.categories.asr" },
  llm: { i18nKey: "settings.categories.llm" },
  courseware: { i18nKey: "settings.categories.courseware" },
  dev: { i18nKey: "settings.categories.dev" },
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
