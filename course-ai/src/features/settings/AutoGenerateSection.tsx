import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { Group, StackRow } from "@/features/settings/primitives";

const KEY = "auto_ai_tasks";
const STAGES = ["chapters", "summary", "notes", "quiz", "mindmap"] as const;
type Stage = (typeof STAGES)[number];
type Flags = Record<Stage, boolean>;

const ALL_ON: Flags = { chapters: true, summary: true, notes: true, quiz: true, mindmap: true };

/** 存的是 JSON，只认显式的 false；没写的、存坏了的都算开（和后端一致）。 */
function parseFlags(raw: string | null): Flags {
  if (!raw) return ALL_ON;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return ALL_ON;
    const record = parsed as Record<string, unknown>;
    return Object.fromEntries(STAGES.map((stage) => [stage, record[stage] !== false])) as Flags;
  } catch {
    return ALL_ON;
  }
}

/**
 * 设置 → 大模型 下面的「自动生成」：视频处理完后自动生成哪些产物。关掉的不发请求、不花钱，
 * 处理进度里显示为「已跳过」；需要时在各面板里手动生成照样可以。
 *
 * 做成一行可多选的标签，不是五个开关：五个默认全开的开关是一整列实色强调色，压过整页的主操作。
 */
export function AutoGenerateSection() {
  const { t } = useTranslation();
  const [flags, setFlags] = useState<Flags>(ALL_ON);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void ipc.settings
      .get(KEY)
      .then((raw) => {
        if (alive) setFlags(parseFlags(raw));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function toggle(stage: Stage, on: boolean) {
    const previous = flags;
    const next = { ...flags, [stage]: on };
    setFlags(next);
    try {
      await ipc.settings.set(KEY, JSON.stringify(next));
      setError("");
    } catch (err) {
      setFlags(previous);
      setError(String(err));
    }
  }

  return (
    <Group
      header={t("settings.llm.autoGenerate")}
      hint={t("settings.llm.autoGenerateHint")}
      footnote={error ? <span className="text-[var(--status-err)]">{error}</span> : undefined}
    >
      <StackRow>
        <div role="group" aria-label={t("settings.llm.autoGenerate")} className="flex flex-wrap gap-2">
          {STAGES.map((stage) => {
            const on = flags[stage];
            return (
              <button
                key={stage}
                type="button"
                aria-pressed={on}
                onClick={() => void toggle(stage, !on)}
                className={`ca-touch-44 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors ${
                  on
                    ? "border-[var(--border-strong)] bg-[var(--surface-card-hover)] font-medium text-[var(--text-strong)]"
                    : "border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-strong)]"
                }`}
              >
                {on && <Check aria-hidden="true" className="h-3.5 w-3.5" />}
                {t(`aiUsage.labels.${stage}`)}
              </button>
            );
          })}
        </div>
      </StackRow>
    </Group>
  );
}
