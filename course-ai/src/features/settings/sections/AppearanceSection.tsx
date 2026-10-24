import { useState } from "react";
import { useTranslation } from "react-i18next";
import { changeLanguage } from "@/i18n";
import { ACCENTS, useTheme, type ThemePref } from "@/stores/theme";
import {
  isReadingFontAvailable,
  READING_FONTS,
  READING_SIZES,
  readingFontStack,
  useReadingFont,
} from "@/stores/readingFont";
import { Select, Group, Row, StackRow } from "@/features/settings/primitives";
import { isIOS } from "@/lib/platform";

/** 桌面版 macOS（iPadOS 桌面模式会伪装成 Mac，由 isIOS 排除）。 */
function isMacDesktop() {
  return typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent) && !isIOS();
}

/** 外观：主题、强调色、阅读字体与界面语言。 */
const THEME_OPTIONS: { key: ThemePref; i18nKey: string }[] = [
  { key: "light", i18nKey: "settings.theme.light" },
  { key: "dark", i18nKey: "settings.theme.dark" },
  { key: "auto", i18nKey: "settings.theme.auto" },
];

/** 外观主题的小缩略图（仿一个迷你窗口）。auto 用左浅右深的斜分。 */
function ThemeMock({ pref }: { pref: ThemePref }) {
  const light = { bg: "#e9eaf0", bar: "#f7f8fa", win: "#ffffff", line: "#d7dae2" };
  const dark = { bg: "#1b1e25", bar: "#23262e", win: "#2c2f38", line: "#3a3e48" };
  if (pref === "auto") {
    return (
      <span className="relative block h-full w-full overflow-hidden">
        <span className="absolute inset-0" style={{ background: light.bg }} />
        <span
          className="absolute inset-0"
          style={{ clipPath: "polygon(100% 0, 0 100%, 100% 100%)", background: dark.bg }}
        />
        <span
          className="absolute left-1.5 top-1.5 h-1.5 w-7 rounded-full"
          style={{ background: "var(--accent, #2f6cea)" }}
        />
      </span>
    );
  }
  const c = pref === "dark" ? dark : light;
  return (
    <span className="relative block h-full w-full" style={{ background: c.bg }}>
      <span className="absolute left-1.5 top-1.5 h-1.5 w-7 rounded-full" style={{ background: "var(--accent, #2f6cea)" }} />
      <span
        className="absolute bottom-1.5 left-1.5 right-1.5 top-4 rounded-[3px]"
        style={{ background: c.win, boxShadow: `inset 0 0 0 1px ${c.line}` }}
      />
    </span>
  );
}


export function AppearanceSection() {
  const { t, i18n } = useTranslation();
  const themePref = useTheme((s) => s.pref);
  const setThemePref = useTheme((s) => s.setPref);
  const accent = useTheme((s) => s.accent);
  const customAccent = useTheme((s) => s.customAccent);
  const setAccent = useTheme((s) => s.setAccent);
  const setCustomAccent = useTheme((s) => s.setCustomAccent);
  const readingFont = useReadingFont((s) => s.font);
  const setReadingFont = useReadingFont((s) => s.setFont);
  const readingSize = useReadingFont((s) => s.size);
  const setReadingSize = useReadingFont((s) => s.setSize);
  // 量一次即可：本机字体在应用运行期间不会变。
  const [fontAvailable] = useState(() =>
    Object.fromEntries(READING_FONTS.map((option) => [option.key, isReadingFontAvailable(option.key)])),
  );

  return (
    <>
      <Group header={t("settings.appearance.themeGroup")}>
        <StackRow>
          <div className="flex gap-6">
            {THEME_OPTIONS.map((opt) => {
              const active = themePref === opt.key;
              return (
                <button
                  key={opt.key}
                  onClick={() => setThemePref(opt.key)}
                  className="flex flex-col items-center gap-2"
                  aria-pressed={active}
                >
                  <span
                    className={`block h-14 w-20 overflow-hidden rounded-lg ring-2 transition ${
                      active
                        ? "ring-[var(--accent)]"
                        : "ring-[var(--border-subtle)] hover:ring-[var(--text-faint)]"
                    }`}
                  >
                    <ThemeMock pref={opt.key} />
                  </span>
                  <span
                    className={`text-xs ${
                      active
                        ? "font-medium text-[var(--text-strong)]"
                        : "text-[var(--text-muted)]"
                    }`}
                  >
                    {t(opt.i18nKey)}
                  </span>
                </button>
              );
            })}
          </div>
        </StackRow>
      </Group>

      <Group
        header={t("settings.appearance.accentColor")}
      >
        <StackRow>
          <div className="flex flex-wrap items-center gap-3">
            {ACCENTS.map((option) => {
              const selected = accent === option.key;
              if (option.key === "custom") {
                return (
                  <label
                    key={option.key}
                    title={t(option.i18nKey)}
                    className={`ca-touch-44 relative grid h-7 w-7 cursor-pointer place-items-center rounded-full ring-2 ring-offset-2 ring-offset-[var(--surface-card)] transition ${
                      selected ? "ring-[var(--text-muted)]" : "ring-transparent"
                    }`}
                  >
                    <input
                      aria-label={t("settings.appearance.customAccent")}
                      type="color"
                      value={customAccent}
                      onChange={(event) => setCustomAccent(event.target.value)}
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    />
                    {/* 色轮表示「任选颜色」（同 macOS 取色器），是有含义的图形，审计放行。 */}
                    <span
                      data-allow-gradient
                      className="h-5 w-5 rounded-full"
                      style={{
                        background:
                          "conic-gradient(from 210deg, #f25555, #f2a13d, #f2d83d, #5cc46b, #3d8bf2, #a05cf2, #f25590, #f25555)",
                      }}
                    />
                  </label>
                );
              }
              return (
                <button
                  key={option.key}
                  onClick={() => setAccent(option.key)}
                  title={t(option.i18nKey)}
                  aria-label={t(option.i18nKey)}
                  aria-pressed={selected}
                  className={`ca-touch-44 grid h-7 w-7 place-items-center rounded-full ring-2 ring-offset-2 ring-offset-[var(--surface-card)] transition ${
                    selected ? "ring-[var(--text-muted)]" : "ring-transparent"
                  }`}
                >
                  <span
                    className="h-5 w-5 rounded-full"
                    style={{ background: option.accent }}
                  />
                </button>
              );
            })}
          </div>
        </StackRow>
      </Group>

      <Group
        header={t("settings.appearance.readingFont")}
        footnote={
          <>
            {t("settings.appearance.readingFontFootnote")}
            {/* macOS 的楷体、仿宋是「可选下载」的系统字体：告诉用户去哪儿拿。 */}
            {isMacDesktop() && Object.values(fontAvailable).some((ok) => !ok) && (
              <span className="mt-1 block">{t("settings.appearance.readingFontMacHint")}</span>
            )}
          </>
        }
      >
        <StackRow>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {READING_FONTS.map((option) => {
              const selected = readingFont === option.key;
              const available = fontAvailable[option.key];
              return (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={selected}
                  disabled={!available}
                  onClick={() => setReadingFont(option.key)}
                  title={available ? undefined : t("settings.appearance.readingFontMissing")}
                  className={`flex flex-col items-start gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                    selected
                      ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
                      : "border-[var(--border-subtle)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  {/* 示例直接用该字体排：选之前就看得出是什么样子。 */}
                  <span
                    aria-hidden="true"
                    className="text-base leading-snug text-[var(--text-strong)]"
                    style={{ fontFamily: readingFontStack(option.key) }}
                  >
                    {t("settings.appearance.readingFontSample")}
                  </span>
                  <span className={`text-xs ${selected ? "font-medium text-[var(--text-strong)]" : "text-[var(--text-muted)]"}`}>
                    {t(option.i18nKey)}
                    {!available && ` · ${t("settings.appearance.readingFontMissing")}`}
                  </span>
                </button>
              );
            })}
          </div>
        </StackRow>
        <Row label={t("settings.appearance.readingSize")}>
          <div
            role="group"
            aria-label={t("settings.appearance.readingSize")}
            className="inline-flex rounded-md border border-[var(--border-subtle)] p-0.5"
          >
            {READING_SIZES.map((option) => {
              const selected = readingSize === option.key;
              return (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setReadingSize(option.key)}
                  className={`ca-touch-44 rounded-[5px] px-3 py-1 text-xs transition-colors ${
                    selected
                      ? "bg-[var(--surface-card-hover)] font-medium text-[var(--text-strong)]"
                      : "text-[var(--text-muted)] hover:text-[var(--text-strong)]"
                  }`}
                >
                  {t(option.i18nKey)}
                </button>
              );
            })}
          </div>
        </Row>
      </Group>

      <Group header={t("settings.appearance.language")}>
        <Row label={t("settings.appearance.language")} htmlFor="app-language">
          <Select
            id="app-language"
            value={i18n.language}
            onChange={(e) => changeLanguage(e.target.value)}
          >
            <option value="zh-CN">{t("settings.appearance.languageZh")}</option>
            <option value="en">{t("settings.appearance.languageEn")}</option>
          </Select>
        </Row>
      </Group>
    </>
  );
}
