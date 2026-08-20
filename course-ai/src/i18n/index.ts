import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";

const STORAGE_KEY = "course-ai-lang";

type SupportedLanguage = "zh-CN" | "en";

function normalizeLanguage(language: string | undefined): SupportedLanguage {
  return language?.toLowerCase().startsWith("en") ? "en" : "zh-CN";
}

/** Keep browser/embedded-document metadata in step with the active translation. */
function syncDocumentMetadata(language: string) {
  if (typeof document === "undefined") return;
  const normalized = normalizeLanguage(language);
  document.documentElement.lang = normalized;
  document.title = i18n.t("app.title", { lng: normalized });
}

function savedLanguage(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || "zh-CN";
  } catch {
    return "zh-CN";
  }
}

const initialization = i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    en: { translation: en },
  },
  lng: savedLanguage(),
  fallbackLng: "zh-CN",
  interpolation: { escapeValue: false },
});

i18n.on("languageChanged", syncDocumentMetadata);
void initialization.then(() => syncDocumentMetadata(i18n.language));

export async function changeLanguage(lng: string): Promise<void> {
  await i18n.changeLanguage(normalizeLanguage(lng));
  try {
    localStorage.setItem(STORAGE_KEY, normalizeLanguage(lng));
  } catch {
    // storage unavailable
  }
}

export default i18n;
