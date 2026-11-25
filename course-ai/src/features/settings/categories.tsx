/** 设置分类：路由参数 `/settings/$category` 的取值即这里的键。 */

export type SettingsCategory =
  | "appearance"
  | "study"
  | "shortcuts"
  | "storage"
  | "sync"
  | "asr"
  | "llm"
  | "semantic"
  | "courseware"
  | "about";

export const CATEGORY_META: Record<
  SettingsCategory,
  { i18nKey: string }
> = {
  appearance: { i18nKey: "settings.categories.appearance" },
  study: { i18nKey: "settings.categories.study" },
  shortcuts: { i18nKey: "settings.categories.shortcuts" },
  storage: { i18nKey: "settings.categories.storage" },
  sync: { i18nKey: "settings.categories.sync" },
  asr: { i18nKey: "settings.categories.asr" },
  llm: { i18nKey: "settings.categories.llm" },
  semantic: { i18nKey: "settings.categories.semantic" },
  courseware: { i18nKey: "settings.categories.courseware" },
  about: { i18nKey: "settings.categories.about" },
};

/** 分类的展示顺序。 */
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  "appearance",
  "study",
  "shortcuts",
  "storage",
  "sync",
  "asr",
  "llm",
  "semantic",
  "courseware",
  "about",
];

export function isSettingsCategory(value: unknown): value is SettingsCategory {
  return typeof value === "string" && (SETTINGS_CATEGORIES as string[]).includes(value);
}
