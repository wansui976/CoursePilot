import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";

const STORAGE_KEY = "course-ai-lang";

function savedLanguage(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || "zh-CN";
  } catch {
    return "zh-CN";
  }
}

void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    en: { translation: en },
  },
  lng: savedLanguage(),
  fallbackLng: "zh-CN",
  interpolation: { escapeValue: false },
});

export function changeLanguage(lng: string) {
  void i18n.changeLanguage(lng);
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    // storage unavailable
  }
}

export default i18n;
