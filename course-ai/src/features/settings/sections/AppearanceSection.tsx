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
import { DENSITIES, useDensity } from "@/stores/density";
import { useHomeLayout, type HomeLayout } from "@/stores/homeLayout";
import { NOTE_PAPERS, useNotePaper, type NoteTabStyle } from "@/stores/notePaper";
import { WeatherPlaceRow } from "./WeatherPlaceRow";
import { PaperSwatch } from "./PaperSwatch";
import { useFeedbackPrefs, type SoundLevel } from "@/lib/feedback";
import { Switch } from "@/ui/switch";
import { Select, Group, Row, StackRow } from "@/features/settings/primitives";
import { isIOS } from "@/lib/platform";

/** 桌面版 macOS（iPadOS 桌面模式会伪装成 Mac，由 isIOS 排除）。 */
function isMacDesktop() {
  return typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent) && !isIOS();
}

/** 几档互斥选项的分段按钮（阅读字号、界面密度）。 */
function Segmented<K extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-[var(--border-subtle)] p-0.5">
      {options.map((option) => {
        const selected = value === option.key;
        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.key)}
            className={`ca-touch-44 rounded-[5px] px-3 py-1 text-xs transition-colors ${
              selected
                ? "bg-[var(--surface-card-hover)] font-medium text-[var(--text-strong)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-strong)]"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** 外观：主题、强调色、阅读字体、界面密度与界面语言。 */
const THEME_OPTIONS: { key: ThemePref; i18nKey: string }[] = [
  { key: "light", i18nKey: "settings.theme.light" },
  { key: "dark", i18nKey: "settings.theme.dark" },
  { key: "auto", i18nKey: "settings.theme.auto" },
];

/** 外观主题的小缩略图（仿一个迷你窗口）。auto 用左浅右深的斜分。 */
function ThemeMock({ pref }: { pref: ThemePref }) {
  const light = { bg: "#f6f7f5", bar: "#fbfbfa", win: "#ffffff", line: "#e4e6e2" };
  const dark = { bg: "#191f1c", bar: "#151a18", win: "#1d2420", line: "#2f3833" };
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
          style={{ background: "var(--accent, #1d6b52)" }}
        />
      </span>
    );
  }
  const c = pref === "dark" ? dark : light;
  return (
    <span className="relative block h-full w-full" style={{ background: c.bg }}>
      <span className="absolute left-1.5 top-1.5 h-1.5 w-7 rounded-full" style={{ background: "var(--accent, #1d6b52)" }} />
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
  const density = useDensity((s) => s.density);
  const setDensity = useDensity((s) => s.setDensity);
  const homeLayout = useHomeLayout((s) => s.layout);
  const setHomeLayout = useHomeLayout((s) => s.setLayout);
  const deskWindow = useHomeLayout((s) => s.deskWindow);
  const notePaper = useNotePaper((s) => s.paper);
  const setNotePaper = useNotePaper((s) => s.setPaper);
  const noteTabStyle = useNotePaper((s) => s.tabStyle);
  const setNoteTabStyle = useNotePaper((s) => s.setTabStyle);
  const setDeskWindow = useHomeLayout((s) => s.setDeskWindow);
  const sound = useFeedbackPrefs((s) => s.sound);
  const setSound = useFeedbackPrefs((s) => s.setSound);
  const haptics = useFeedbackPrefs((s) => s.haptics);
  const setHaptics = useFeedbackPrefs((s) => s.setHaptics);
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
                        ? "ring-[var(--text-strong)]"
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
          <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
            {ACCENTS.map((option) => {
              const selected = accent === option.key;
              // 选中环只在选中时画：深色主题的卡片底是半透明的，ring-offset 拿它当色，
              // 没选中的色块也会套上一圈暗晕。
              const swatchRing = `grid h-7 w-7 place-items-center rounded-full transition ${
                selected
                  ? "ring-2 ring-[var(--text-muted)] ring-offset-2 ring-offset-[var(--surface-panel)]"
                  : ""
              }`;
              const caption = (
                <span
                  className={`ca-t-2xs ${
                    selected ? "font-medium text-[var(--text-strong)]" : "text-[var(--text-muted)]"
                  }`}
                >
                  {t(option.i18nKey)}
                </span>
              );
              if (option.key === "custom") {
                return (
                  <label
                    key={option.key}
                    title={t(option.i18nKey)}
                    className="ca-touch-44 relative flex cursor-pointer flex-col items-center gap-1.5"
                  >
                    <span className={swatchRing}>
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
                    </span>
                    {caption}
                  </label>
                );
              }
              return (
                <button
                  key={option.key}
                  onClick={() => setAccent(option.key)}
                  aria-pressed={selected}
                  className="ca-touch-44 flex flex-col items-center gap-1.5"
                >
                  <span className={swatchRing}>
                    <span
                      className="h-5 w-5 rounded-full"
                      style={{ background: option.accent }}
                    />
                  </span>
                  {caption}
                </button>
              );
            })}
          </div>
        </StackRow>
      </Group>

      <Group
        header={t("settings.appearance.readingFont")}
        hint={
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
                      ? "border-[var(--text-strong)] ring-1 ring-[var(--text-strong)]"
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
        <Row label={t("settings.appearance.readingSize")} layout="inline">
          <Segmented
            label={t("settings.appearance.readingSize")}
            options={READING_SIZES.map((option) => ({ key: option.key, label: t(option.i18nKey) }))}
            value={readingSize}
            onChange={setReadingSize}
          />
        </Row>
        <Row label={t("settings.appearance.noteTabs")} hint={t("settings.appearance.noteTabsHint")} layout="inline">
          <Segmented
            label={t("settings.appearance.noteTabs")}
            options={[
              { key: "plain" as NoteTabStyle, label: t("settings.appearance.noteTabsPlain") },
              { key: "color" as NoteTabStyle, label: t("settings.appearance.noteTabsColor") },
            ]}
            value={noteTabStyle}
            onChange={setNoteTabStyle}
          />
        </Row>
        <StackRow label={t("settings.appearance.notePaper")} hint={t("settings.appearance.notePaperHint")}>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5" role="group" aria-label={t("settings.appearance.notePaper")}>
            {NOTE_PAPERS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={notePaper === option}
                onClick={() => setNotePaper(option)}
                className={`flex flex-col gap-1.5 rounded-lg border p-1.5 text-left text-xs transition-colors ${
                  notePaper === option
                    ? "border-[var(--text-strong)] font-medium text-[var(--text-strong)] ring-1 ring-[var(--text-strong)]"
                    : "border-[var(--border-subtle)] text-[var(--text-muted)] hover:border-[var(--border-strong)]"
                }`}
              >
                <PaperSwatch paper={option} />
                <span className="px-1">{t(`settings.appearance.notePapers.${option}`)}</span>
              </button>
            ))}
          </div>
        </StackRow>
      </Group>

      {/* 密度和语言各只有一项：此前各占一个分组，分组标题和行标签写着同一个词。合成一组。 */}
      <Group header={t("settings.appearance.interface")}>
        <Row label={t("settings.appearance.homeLayout")} hint={t("settings.appearance.homeLayoutHint")} layout="inline">
          <Segmented
            label={t("settings.appearance.homeLayout")}
            options={[
              { key: "dashboard" as HomeLayout, label: t("settings.appearance.homeLayoutDashboard") },
              { key: "desk" as HomeLayout, label: t("settings.appearance.homeLayoutDesk") },
            ]}
            value={homeLayout}
            onChange={setHomeLayout}
          />
        </Row>
        {homeLayout === "desk" && (
          <Row label={t("settings.appearance.deskWindow")} hint={t("settings.appearance.deskWindowHint")} layout="inline">
            <Switch
              aria-label={t("settings.appearance.deskWindow")}
              checked={deskWindow}
              onCheckedChange={setDeskWindow}
            />
          </Row>
        )}
        {homeLayout === "desk" && deskWindow && <WeatherPlaceRow />}
        <Row label={t("settings.appearance.uiSound")} hint={t("settings.appearance.uiSoundHint")} layout="inline">
          <Segmented
            label={t("settings.appearance.uiSound")}
            options={[
              { key: "off" as SoundLevel, label: t("settings.appearance.uiSoundOff") },
              { key: "quiet" as SoundLevel, label: t("settings.appearance.uiSoundQuiet") },
              { key: "normal" as SoundLevel, label: t("settings.appearance.uiSoundNormal") },
            ]}
            value={sound}
            onChange={setSound}
          />
        </Row>
        <Row label={t("settings.appearance.haptics")} hint={t("settings.appearance.hapticsHint")} layout="inline">
          <Switch
            checked={haptics}
            onCheckedChange={setHaptics}
            aria-label={t("settings.appearance.haptics")}
          />
        </Row>
        <Row label={t("settings.appearance.density")} hint={t("settings.appearance.densityFootnote")} layout="inline">
          <Segmented
            label={t("settings.appearance.density")}
            options={DENSITIES.map((option) => ({ key: option.key, label: t(option.i18nKey) }))}
            value={density}
            onChange={setDensity}
          />
        </Row>
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
