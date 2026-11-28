import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { Check } from "lucide-react";
import { Modal } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { ipc, type LectureEstimate, type WhisperModel } from "@/lib/ipc";
import { humanizeError } from "@/lib/errors";
import { formatCost, formatTokens } from "@/lib/aiUsageFormat";
import { formatFileSize } from "@/lib/fileSize";
import { presetFor } from "@/lib/llmPresets";
import { isMobile } from "@/lib/platform";
import type { LlmProfile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { markSetupWizardSeen } from "@/lib/setupWizard";

/**
 * 首次使用向导：第一次打开、还没配过大模型时出现一次，把最容易卡住的两样配好——
 * 语音识别（能跑本机识别就推荐下载 SenseVoice，免费不联网）和大模型（给几个省钱的选项，
 * 标上一小时课大概花多少，填 Key、检查一下就存）。都能跳过，以后在设置里改。
 */

/** 本机识别推荐的模型：中文课准、快、体积最小。 */
const LOCAL_MODEL = "sensevoice";

/** 所有任务都路由到同一个配置（和设置里「当前默认模型」一致）。 */
const ROUTING_TASKS = [
  "notes",
  "chapters",
  "summary",
  "quiz",
  "mindmap",
  "rag",
  "correction",
  "digest",
  "assistant",
] as const;

type Candidate = {
  key: "deepseek" | "qwen" | "ollama";
  model: string;
  /** 去哪里拿 Key；Ollama 不需要。 */
  keyUrl?: string;
};

const KEY_URLS: Record<string, string> = {
  deepseek: "https://platform.deepseek.com/api_keys",
  qwen: "https://bailian.console.aliyun.com/?apiKey=1",
};

function newProfileId() {
  return Math.random().toString(36).slice(2, 10);
}

function profileFor(candidate: Candidate): LlmProfile {
  const preset = presetFor(candidate.key);
  return {
    id: newProfileId(),
    name: preset.name,
    kind: preset.kind,
    base_url: preset.base_url,
    model: candidate.model,
    key_required: candidate.key === "ollama" ? false : undefined,
  };
}

export function SetupWizard({
  open,
  onClose,
  onOpenSettings,
}: {
  open: boolean;
  /** 关掉向导（不论配没配）。 */
  onClose: () => void;
  /** 「去设置…」：关掉向导，打开设置的某个分类（asr / llm）。 */
  onOpenSettings: (category: "asr" | "llm") => void;
}) {
  const { t, i18n } = useTranslation();

  // 打开时焦点落在内容开头（不画焦点框）：落在第一个选项上会套一圈蓝框，
  // 落在 Key 输入框上手机会直接弹键盘。
  const startRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    markSetupWizardSeen();
    onClose();
  }, [onClose]);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      size="lg"
      title={t("setupWizard.title")}
      description={t("setupWizard.description")}
      initialFocusRef={startRef}
    >
      <div ref={startRef} tabIndex={-1} className="ca-focus-start space-y-6 pt-2">
        <AsrStep
          onOpenSettings={() => {
            markSetupWizardSeen();
            onOpenSettings("asr");
          }}
        />
        <LlmStep
          language={i18n.language}
          onOpenSettings={() => {
            markSetupWizardSeen();
            onOpenSettings("llm");
          }}
        />
        <div className="flex justify-end gap-2 border-t border-[var(--border-faint)] pt-4">
          <Button variant="default" onClick={close}>
            {t("setupWizard.done")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function StepHeading({ index, title, done }: { index: number; title: string; done: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="mb-2 flex items-center gap-3">
      <h3 className="font-[family-name:var(--font-display)] text-[15px] font-medium text-[var(--text-strong)]">
        <span className="mr-1.5 font-[family-name:var(--font-mono)] text-[13px] text-[var(--text-faint)]">
          {index}
        </span>
        {title}
      </h3>
      <span aria-hidden="true" className="h-px flex-1 bg-[var(--border-faint)]" />
      {done && (
        <span className="inline-flex items-center gap-1 text-xs text-[var(--status-ok)]">
          <Check aria-hidden="true" className="h-3.5 w-3.5" />
          {t("setupWizard.stepDone")}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 语音识别

type DownloadProgress = { received: number; total: number; done: boolean };

function AsrStep({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation();
  const [ready, setReady] = useState<boolean | null>(null);
  const [model, setModel] = useState<{ info: WhisperModel; installed: boolean } | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [applied, setApplied] = useState(false);

  const refresh = useCallback(async () => {
    const [isReady, models] = await Promise.all([
      ipc.pipeline.asrReady().catch(() => false),
      ipc.whisper.list().catch(() => [] as [WhisperModel, boolean][]),
    ]);
    setReady(isReady);
    const found = models.find(([info]) => info.id === LOCAL_MODEL);
    setModel(found ? { info: found[0], installed: found[1] } : null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unlisten = listen<{ id: string } & DownloadProgress>("whisper:download", (event) => {
      if (event.payload.id !== LOCAL_MODEL) return;
      setProgress(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  async function applyLocal() {
    if (!model) return;
    setError(null);
    setBusy(true);
    try {
      if (!model.installed) {
        if (isMobile()) {
          const metered = await ipc.app
            .networkInfo()
            .then((info) => info.metered)
            .catch(() => false);
          if (
            metered &&
            !(await confirmDialog(
              t("setupWizard.asr.meteredConfirm", { size: formatFileSize(model.info.size_bytes) }),
              { kind: "warning" },
            ))
          ) {
            return;
          }
        }
        await ipc.whisper.download(LOCAL_MODEL);
      }
      await ipc.settings.set("asr_backend", "whisper");
      await ipc.settings.set("whisper_model", LOCAL_MODEL);
      setApplied(true);
      await refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const canRunLocal = model != null && model.info.fits_memory !== false;
  const done = applied || ready === true;
  const percent =
    progress && progress.total > 0 ? Math.min(100, Math.floor((progress.received / progress.total) * 100)) : null;

  return (
    <section aria-label={t("setupWizard.asr.title")}>
      <StepHeading index={1} title={t("setupWizard.asr.title")} done={done} />
      {ready === null ? (
        <p className="text-sm text-[var(--text-muted)]">{t("setupWizard.checking")}</p>
      ) : applied ? (
        <p className="text-sm text-[var(--text-normal)]">{t("setupWizard.asr.applied")}</p>
      ) : canRunLocal ? (
        <div className="space-y-3">
          <p className="text-sm text-[var(--text-normal)]">
            {model.installed
              ? t("setupWizard.asr.installedOffer")
              : ready
                ? t("setupWizard.asr.readyLocalOffer", { size: formatFileSize(model.info.size_bytes) })
                : t("setupWizard.asr.localOffer", { size: formatFileSize(model.info.size_bytes) })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="default" disabled={busy} onClick={() => void applyLocal()}>
              {busy
                ? percent != null
                  ? t("setupWizard.asr.downloading", { percent })
                  : t("setupWizard.asr.preparing")
                : model.installed
                  ? t("setupWizard.asr.useInstalled")
                  : t("setupWizard.asr.download", { size: formatFileSize(model.info.size_bytes) })}
            </Button>
            <Button size="sm" variant="link" onClick={onOpenSettings}>
              {t("setupWizard.asr.cloud")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-[var(--text-normal)]">
            {ready ? t("setupWizard.asr.ready") : t("setupWizard.asr.noLocal")}
          </p>
          {!ready && (
            <Button size="sm" variant="default" onClick={onOpenSettings}>
              {t("setupWizard.asr.openSettings")}
            </Button>
          )}
        </div>
      )}
      {error != null && (
        <p role="alert" className="mt-2 text-sm text-[var(--status-err)]">
          {humanizeError(error)}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- 大模型

function LlmStep({ language, onOpenSettings }: { language: string; onOpenSettings: () => void }) {
  const { t } = useTranslation();
  const keyId = useId();
  const [ollamaModels, setOllamaModels] = useState<string[] | null>(null);
  const [estimate, setEstimate] = useState<LectureEstimate | null>(null);
  const [selected, setSelected] = useState<Candidate["key"]>("deepseek");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [savedModel, setSavedModel] = useState<string | null>(null);

  useEffect(() => {
    if (isMobile()) return;
    let alive = true;
    ipc.ai
      .detectOllama()
      .then((models) => alive && setOllamaModels(models && models.length > 0 ? models : null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const candidates = useMemo<Candidate[]>(() => {
    const list: Candidate[] = [
      { key: "deepseek", model: presetFor("deepseek").model, keyUrl: KEY_URLS.deepseek },
      { key: "qwen", model: presetFor("qwen").model, keyUrl: KEY_URLS.qwen },
    ];
    if (ollamaModels) list.push({ key: "ollama", model: ollamaModels[0] });
    return list;
  }, [ollamaModels]);

  useEffect(() => {
    let alive = true;
    ipc.ai
      .lectureEstimate(
        candidates.map((candidate) => {
          const preset = presetFor(candidate.key);
          return { kind: preset.kind, baseUrl: preset.base_url, model: candidate.model };
        }),
      )
      .then((result) => alive && setEstimate(result))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [candidates]);

  const candidate = candidates.find((one) => one.key === selected) ?? candidates[0];
  const needsKey = candidate.key !== "ollama";

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const profile = profileFor(candidate);
      const key = apiKey.trim();
      // 先拿 Key 拉一次模型列表：Key 不对、地址不通在这里就报，不等到第一节课处理失败。
      await ipc.ai.listModels(profile, needsKey ? key : null, true);
      const routing = Object.fromEntries(ROUTING_TASKS.map((task) => [task, profile.id]));
      await ipc.ai.saveProfiles(
        JSON.stringify([profile]),
        JSON.stringify(routing),
        needsKey ? { [profile.id]: key } : {},
      );
      setSavedModel(profile.model);
      setApiKey("");
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  }

  function costLabel(index: number, key: Candidate["key"]) {
    if (key === "ollama") return t("setupWizard.llm.free");
    const usd = estimate?.costPerHourUsd[index];
    if (usd == null) return estimate ? t("setupWizard.llm.noPrice") : "";
    return t("setupWizard.llm.perHour", { cost: formatCost(usd, language) });
  }

  if (savedModel) {
    return (
      <section aria-label={t("setupWizard.llm.title")}>
        <StepHeading index={2} title={t("setupWizard.llm.title")} done />
        <p className="text-sm text-[var(--text-normal)]">
          {t("setupWizard.llm.saved", { model: savedModel })}
        </p>
      </section>
    );
  }

  const tokens = estimate?.tokens;
  return (
    <section aria-label={t("setupWizard.llm.title")}>
      <StepHeading index={2} title={t("setupWizard.llm.title")} done={false} />
      <p className="mb-3 text-sm text-[var(--text-normal)]">{t("setupWizard.llm.intro")}</p>
      <div role="radiogroup" aria-label={t("setupWizard.llm.title")} className="grid gap-2">
        {candidates.map((one, index) => {
          const active = one.key === candidate.key;
          return (
            <button
              key={one.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => {
                setSelected(one.key);
                setError(null);
              }}
              className={cn(
                "ca-touch-44 flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                // 选中用中性底：绿色只留给「检查并保存」。
                active
                  ? "border-[var(--border-strong)] bg-[var(--surface-card-active)]"
                  : "border-[var(--border-subtle)] hover:bg-[var(--surface-card-hover)]",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-[var(--text-strong)]">
                  {presetFor(one.key).name}
                  {index === 0 && (
                    <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
                      {t("setupWizard.llm.recommended")}
                    </span>
                  )}
                </span>
                <span className="block truncate font-[family-name:var(--font-mono)] text-xs text-[var(--text-muted)]">
                  {one.model}
                </span>
              </span>
              <span className="flex-none font-[family-name:var(--font-mono)] text-xs text-[var(--text-normal)]">
                {costLabel(index, one.key)}
              </span>
            </button>
          );
        })}
      </div>
      {tokens && (
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          {tokens.fromHistory
            ? t("setupWizard.llm.basisHistory", { count: tokens.videos })
            : t("setupWizard.llm.basisRough", {
                input: formatTokens(tokens.promptTokens, language),
                output: formatTokens(tokens.completionTokens, language),
              })}
        </p>
      )}

      <div className="mt-4 space-y-2">
        {needsKey && (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor={keyId} className="text-sm text-[var(--text-strong)]">
                {t("setupWizard.llm.keyLabel", { name: presetFor(candidate.key).name })}
              </label>
              {candidate.keyUrl && (
                <Button
                  size="sm"
                  variant="link"
                  onClick={() => void openUrl(candidate.keyUrl ?? "").catch(() => undefined)}
                >
                  {t("setupWizard.llm.getKey")}
                </Button>
              )}
            </div>
            <input
              id={keyId}
              type="password"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-…"
              className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 font-[family-name:var(--font-mono)] text-sm text-[var(--text-strong)] outline-none transition-colors placeholder:text-[var(--text-faint)] hover:border-[var(--border-strong)] focus-visible:border-[var(--focus-ring)] focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--focus-ring)_22%,transparent)]"
            />
          </>
        )}
        {error != null && (
          <p role="alert" className="text-sm text-[var(--status-err)]">
            {humanizeError(error)}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={saving || (needsKey && apiKey.trim() === "")}
            onClick={() => void save()}
          >
            {saving ? t("setupWizard.llm.checking") : t("setupWizard.llm.save")}
          </Button>
          <Button size="sm" variant="link" onClick={onOpenSettings}>
            {t("setupWizard.llm.other")}
          </Button>
        </div>
      </div>
    </section>
  );
}
