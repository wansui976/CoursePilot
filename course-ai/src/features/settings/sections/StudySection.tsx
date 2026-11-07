import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "@/ui/switch";
import { ipc } from "@/lib/ipc";
import { readReminderEnabled, writeReminderEnabled } from "@/lib/studyReminder";
import { FIELD, Group, Row, SavedBadge, Select, StackRow } from "@/features/settings/primitives";
import { QUIZ_STYLES } from "@/lib/quizStyles";
import type { QuizStyle } from "@/lib/types";

const DEFAULT_STYLE_KEY = "quiz_default_style";
const PROMPT_KEY = "quiz_custom_prompt";

const SEARCH_TRANSCRIPTS_KEY = "search_transcripts";

/** 学习提醒、课程页搜索范围，以及出题的默认风格和全局出题要求。 */
export function StudySection() {
  const { t } = useTranslation();
  // 课程页搜索默认只搜标题和笔记；打开后也搜文稿。课程页回来时会重新读取，不用另行通知。
  const [searchTranscripts, setSearchTranscripts] = useState(false);
  async function toggleSearchTranscripts(on: boolean) {
    setSearchTranscripts(on);
    try {
      await ipc.settings.set(SEARCH_TRANSCRIPTS_KEY, on ? "true" : "false");
    } catch (error) {
      setSearchTranscripts(!on);
      setStatus({ text: String(error), error: true });
    }
  }
  const [remindOn, setRemindOn] = useState(() => readReminderEnabled());
  const [style, setStyle] = useState<QuizStyle>("recall");
  const [prompt, setPrompt] = useState("");
  const [savedPrompt, setSavedPrompt] = useState("");
  const [status, setStatus] = useState<{ text: string; error: boolean }>({ text: "", error: false });

  useEffect(() => {
    let alive = true;
    void Promise.all([
      ipc.settings.get(DEFAULT_STYLE_KEY),
      ipc.settings.get(PROMPT_KEY),
      ipc.settings.get(SEARCH_TRANSCRIPTS_KEY),
    ])
      .then(([savedStyle, saved, transcripts]) => {
        if (!alive) return;
        setSearchTranscripts(transcripts === "true");
        const known = QUIZ_STYLES.find((one) => one === savedStyle);
        if (known) setStyle(known);
        setPrompt(saved ?? "");
        setSavedPrompt(saved ?? "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function toggleReminder(on: boolean) {
    writeReminderEnabled(on);
    setRemindOn(on);
    if (!on) return;
    try {
      await ipc.notify(t("settings.studyReminder.enabled"), t("settings.studyReminder.enabledBody"));
    } catch {
      // 权限被拒 / 发送失败时静默：开关状态仍已保存。
    }
  }

  async function save(key: string, value: string) {
    try {
      await ipc.settings.set(key, value);
      setStatus({ text: t("settings.quiz.saved"), error: false });
    } catch (error) {
      setStatus({ text: String(error), error: true });
    }
  }

  return (
    <>
      <Group header={t("settings.studyReminder.title")} footnote={t("settings.studyReminder.footnote")}>
        <Row label={t("settings.studyReminder.label")} hint={t("settings.studyReminder.hint")} htmlFor="study-reminder">
          <Switch
            id="study-reminder"
            aria-label={t("settings.studyReminder.label")}
            checked={remindOn}
            onCheckedChange={(next) => void toggleReminder(next)}
          />
        </Row>
      </Group>
      <Group header={t("settings.search.title")} footnote={t("settings.search.footnote")}>
        <Row
          label={t("settings.search.transcripts")}
          hint={t("settings.search.transcriptsHint")}
          htmlFor="search-transcripts"
        >
          <Switch
            id="search-transcripts"
            aria-label={t("settings.search.transcripts")}
            checked={searchTranscripts}
            onCheckedChange={(next) => void toggleSearchTranscripts(next)}
          />
        </Row>
      </Group>
      <Group header={t("settings.quiz.title")} footnote={<SavedBadge text={status.text} isError={status.error} />}>
        <Row label={t("settings.quiz.defaultStyle")} hint={t("settings.quiz.defaultStyleHint")} htmlFor="quiz-default-style">
          <Select
            id="quiz-default-style"
            value={style}
            onChange={(event) => {
              const next = event.target.value as QuizStyle;
              setStyle(next);
              void save(DEFAULT_STYLE_KEY, next);
            }}
          >
            {QUIZ_STYLES.map((value) => (
              <option key={value} value={value}>
                {t(`quiz.styles.${value}`)}
              </option>
            ))}
          </Select>
        </Row>
        <StackRow label={t("settings.quiz.prompt")} hint={t("settings.quiz.promptHint")} htmlFor="quiz-custom-prompt">
          <textarea
            id="quiz-custom-prompt"
            className={`${FIELD} min-h-[88px] resize-y`}
            value={prompt}
            placeholder={t("settings.quiz.promptPlaceholder")}
            onChange={(event) => setPrompt(event.target.value)}
            onBlur={() => {
              const next = prompt.trim();
              if (next === savedPrompt.trim()) return;
              setSavedPrompt(next);
              void save(PROMPT_KEY, next);
            }}
          />
        </StackRow>
      </Group>
    </>
  );
}
