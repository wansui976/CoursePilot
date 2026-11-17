import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "@/ui/switch";
import { ipc } from "@/lib/ipc";
import { Group, Row } from "@/features/settings/primitives";

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
      {STAGES.map((stage) => (
        <Row key={stage} label={t(`aiUsage.labels.${stage}`)} htmlFor={`auto-ai-${stage}`}>
          <Switch
            id={`auto-ai-${stage}`}
            checked={flags[stage]}
            onCheckedChange={(on) => void toggle(stage, on)}
          />
        </Row>
      ))}
    </Group>
  );
}
