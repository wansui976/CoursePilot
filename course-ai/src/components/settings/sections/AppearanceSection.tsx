import { useTranslation } from "react-i18next";
import { changeLanguage } from "@/i18n";
import { ACCENTS, useTheme, type ThemePref } from "@/stores/theme";
import { Select, Group, Row, StackRow } from "../primitives";

/** 外观：主题、强调色与界面语言。 */
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

  return (
    <>
      <Group header={t("settings.appearance.title")}>
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
                    <span
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
