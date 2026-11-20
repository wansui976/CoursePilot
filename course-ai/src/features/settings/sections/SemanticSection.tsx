import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { Download, Loader2, RefreshCw, Trash2, Zap } from "lucide-react";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { TextSkeleton } from "@/ui/skeleton";
import {
  ipc,
  type SemanticBackend,
  type SemanticIndexProgress,
  type SemanticStatus,
  type SemanticTest,
} from "@/lib/ipc";
import type { LlmProfile } from "@/lib/types";
import { FIELD, Group, Row, SavedBadge, Select, StackRow } from "@/features/settings/primitives";

const MB = 1024 * 1024;
const formatMb = (bytes: number) => `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;

/** 云端嵌入模型名的常见取值（输入框的候选，照样可以手填别的）。 */
const CLOUD_MODEL_SUGGESTIONS = [
  { value: "text-embedding-v4", provider: "通义千问 / 阿里云百炼" },
  { value: "text-embedding-3-small", provider: "OpenAI" },
  { value: "BAAI/bge-m3", provider: "硅基流动" },
  { value: "embedding-3", provider: "智谱" },
];

/** 只有这两种协议有 `/embeddings` 接口。 */
const EMBEDDING_KINDS = new Set(["openai", "azure_openai"]);

/**
 * 设置 → 语义检索：按意思找。
 *
 * 选向量来源（关闭 / 本机模型 / 云端接口），本机模型在这里下载和删除；下面一组看索引建到哪了。
 * 关键词检索一直都在，这里只是加强——所以「关闭」是完全正常的状态，不是报错。
 */
export function SemanticSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SemanticStatus | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [cloudProfile, setCloudProfile] = useState("");
  const [cloudModel, setCloudModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SemanticTest | null>(null);
  const [testError, setTestError] = useState<unknown>(null);
  const [download, setDownload] = useState<{ id: string; progress: number } | null>(null);
  const [modelError, setModelError] = useState<unknown>(null);
  const [removing, setRemoving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await ipc.semantic.status();
      setStatus(next);
      setLoadError(null);
      return next;
    } catch (error) {
      setLoadError(error);
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh().then((next) => {
      if (!next) return;
      setCloudProfile(next.cloudProfile ?? "");
      setCloudModel(next.cloudModel ?? "");
    });
    void ipc.ai
      .getProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, [refresh]);

  // 后台建索引的进度：进度条直接用事件里的数，「已建 N / M」隔一会儿再查一次库。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unlisten = listen<SemanticIndexProgress>("semantic-index:progress", (event) => {
      setStatus((current) => (current ? { ...current, progress: event.payload } : current));
      if (timer == null) {
        timer = setTimeout(() => {
          timer = null;
          void refresh();
        }, 800);
      }
    });
    return () => {
      if (timer != null) clearTimeout(timer);
      void unlisten.then((fn) => fn());
    };
  }, [refresh]);

  useEffect(() => {
    const unlisten = listen<{ id: string; received: number; total: number; done: boolean }>(
      "semantic-model:download",
      (event) => {
        const { id, received, total, done } = event.payload;
        setDownload(done ? null : { id, progress: total > 0 ? received / total : 0 });
      },
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const embeddingProfiles = useMemo(
    () => profiles.filter((profile) => EMBEDDING_KINDS.has(profile.kind)),
    [profiles],
  );

  async function save(next: {
    backend: SemanticBackend;
    localModel?: string | null;
    cloudProfile?: string | null;
    cloudModel?: string | null;
  }) {
    if (!status) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    setTestResult(null);
    setTestError(null);
    try {
      await ipc.semantic.save({
        backend: next.backend,
        localModel: next.localModel !== undefined ? next.localModel : status.localModel,
        cloudProfile: next.cloudProfile !== undefined ? next.cloudProfile : status.cloudProfile,
        cloudModel: next.cloudModel !== undefined ? next.cloudModel : status.cloudModel,
      });
      setSaved(true);
      await refresh();
    } catch (error) {
      setSaveError(error);
    } finally {
      setSaving(false);
    }
  }

  async function changeBackend(backend: SemanticBackend) {
    // 第一次选本机模型时默认用第一个（小的那个）；选云端时默认第一个能用的接口。
    const localModel = backend === "local" ? (status?.localModel || status?.models[0]?.id || null) : undefined;
    let profile: string | undefined;
    if (backend === "cloud" && !cloudProfile && embeddingProfiles[0]) {
      profile = embeddingProfiles[0].id;
      setCloudProfile(profile);
    }
    await save({ backend, localModel, cloudProfile: profile });
  }

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      setTestResult(await ipc.semantic.test());
    } catch (error) {
      setTestError(error);
    } finally {
      setTesting(false);
    }
  }

  async function downloadModel(id: string) {
    setModelError(null);
    setDownload({ id, progress: 0 });
    try {
      await ipc.semantic.downloadModel(id);
    } catch (error) {
      setModelError(error);
    } finally {
      setDownload(null);
      await refresh();
    }
  }

  async function removeModel(id: string, name: string) {
    const ok = await confirmDialog(t("settings.semantic.deleteConfirm", { name }), {
      title: t("settings.semantic.deleteTitle"),
      kind: "warning",
      okLabel: t("settings.semantic.delete"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    setModelError(null);
    setRemoving(true);
    try {
      await ipc.semantic.deleteModel(id);
    } catch (error) {
      setModelError(error);
    } finally {
      setRemoving(false);
      await refresh();
    }
  }

  async function rebuild() {
    const ok = await confirmDialog(t("settings.semantic.rebuildConfirm"), {
      title: t("settings.semantic.rebuild"),
      kind: "warning",
      okLabel: t("settings.semantic.rebuild"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    setRebuilding(true);
    try {
      await ipc.semantic.rebuild();
      await refresh();
    } catch (error) {
      setSaveError(error);
    } finally {
      setRebuilding(false);
    }
  }

  if (!status) {
    // 状态可能要查本机模型目录，慢的时候别让整页空着（只剩外面的分类标题）。
    return loadError ? (
      <ErrorNote error={loadError} onRetry={() => void refresh()} />
    ) : (
      <Group header={t("settings.semantic.sourceGroup")}>
        <StackRow>
          <TextSkeleton lines={2} className="p-0" label={t("common.loading")} />
        </StackRow>
      </Group>
    );
  }

  const backend = status.backend;
  const selectedModel = status.models.find((model) => model.id === status.localModel) ?? null;
  const cloudDirty =
    cloudProfile !== (status.cloudProfile ?? "") || cloudModel.trim() !== (status.cloudModel ?? "");
  const progress = status.progress;
  const indexPercent = status.total > 0 ? Math.round((status.indexed / status.total) * 100) : 0;

  return (
    <>
      <Group header={t("settings.semantic.sourceGroup")} hint={t("settings.semantic.sourceHint")}>
        <Row label={t("settings.semantic.source")} htmlFor="semantic-backend" status={saving ? t("settings.semantic.saving") : undefined}>
          <div className="w-full sm:w-56">
            <Select
              id="semantic-backend"
              value={backend}
              disabled={saving}
              onChange={(event) => void changeBackend(event.target.value as SemanticBackend)}
            >
              <option value="off">{t("settings.semantic.off")}</option>
              {(status.localSupported || backend === "local") && (
                <option value="local">{t("settings.semantic.local")}</option>
              )}
              <option value="cloud">{t("settings.semantic.cloud")}</option>
            </Select>
          </div>
        </Row>

        {backend === "local" && !status.localSupported && (
          <StackRow>
            <p className="ca-t-xs text-[var(--text-muted)]">{t("settings.semantic.localUnsupported")}</p>
          </StackRow>
        )}

        {backend === "local" && status.localSupported && (
          <>
            <Row label={t("settings.semantic.localModel")} htmlFor="semantic-local-model">
              <div className="w-full sm:w-56">
                <Select
                  id="semantic-local-model"
                  value={status.localModel ?? ""}
                  disabled={saving || download != null}
                  onChange={(event) => void save({ backend: "local", localModel: event.target.value })}
                >
                  {status.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </Select>
              </div>
            </Row>
            {selectedModel && (
              <Row
                label={t("settings.semantic.modelFile")}
                layout="inline"
                status={selectedModel.description}
                tag={
                  selectedModel.installed
                    ? { text: t("settings.semantic.installed", { size: formatMb(selectedModel.sizeOnDisk) }), tone: "ok" }
                    : { text: t("settings.semantic.notInstalled", { size: formatMb(selectedModel.size) }) }
                }
              >
                {selectedModel.installed ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={removing}
                    className="text-[var(--status-err)]"
                    onClick={() => void removeModel(selectedModel.id, selectedModel.name)}
                  >
                    {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    {t("settings.semantic.delete")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={download != null}
                    onClick={() => void downloadModel(selectedModel.id)}
                  >
                    {download?.id === selectedModel.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {download?.id === selectedModel.id
                      ? t("settings.semantic.downloading", { percent: Math.floor(download.progress * 100) })
                      : t("settings.semantic.download")}
                  </Button>
                )}
              </Row>
            )}
            {modelError != null && (
              <ErrorNote
                className="mx-4 mb-3"
                error={modelError}
                onRetry={selectedModel ? () => void downloadModel(selectedModel.id) : undefined}
              />
            )}
          </>
        )}

        {backend === "cloud" && (
          <>
            {embeddingProfiles.length === 0 ? (
              <StackRow>
                <p className="ca-t-xs leading-relaxed text-[var(--text-muted)]">
                  {t("settings.semantic.noProfiles")}
                </p>
              </StackRow>
            ) : (
              <Row label={t("settings.semantic.cloudProfile")} hint={t("settings.semantic.cloudProfileHint")} htmlFor="semantic-cloud-profile">
                <div className="w-full sm:w-56">
                  <Select
                    id="semantic-cloud-profile"
                    value={cloudProfile}
                    onChange={(event) => setCloudProfile(event.target.value)}
                  >
                    {!cloudProfile && <option value="">{t("settings.semantic.chooseProfile")}</option>}
                    {embeddingProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </Row>
            )}
            <StackRow
              label={t("settings.semantic.cloudModel")}
              hint={t("settings.semantic.cloudModelHint")}
              htmlFor="semantic-cloud-model"
            >
              <input
                id="semantic-cloud-model"
                className={FIELD}
                list="semantic-cloud-model-suggestions"
                value={cloudModel}
                placeholder="text-embedding-v4"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => setCloudModel(event.target.value)}
              />
              <datalist id="semantic-cloud-model-suggestions">
                {CLOUD_MODEL_SUGGESTIONS.map((one) => (
                  <option key={one.value} value={one.value}>
                    {one.provider}
                  </option>
                ))}
              </datalist>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={saving || !cloudDirty || !cloudProfile || !cloudModel.trim()}
                  onClick={() => void save({ backend: "cloud", cloudProfile, cloudModel: cloudModel.trim() })}
                >
                  {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t("settings.semantic.save")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={testing || cloudDirty || !status.active}
                  onClick={() => void runTest()}
                >
                  {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                  {t("settings.semantic.test")}
                </Button>
                {saved && !cloudDirty && <SavedBadge text={t("settings.semantic.saved")} />}
                {testResult && (
                  <SavedBadge
                    text={t("settings.semantic.testOk", { dimensions: testResult.dimensions, millis: testResult.millis })}
                  />
                )}
              </div>
              {testError != null && <ErrorNote className="mt-3" error={testError} />}
            </StackRow>
          </>
        )}
        {saveError != null && <ErrorNote className="mx-4 mb-3" error={saveError} />}
      </Group>

      {backend !== "off" && (
        <Group header={t("settings.semantic.indexGroup")} hint={t("settings.semantic.indexHint")}>
          <Row
            label={t("settings.semantic.indexed")}
            // 进度文案（“正在建：某视频（还剩 N 个）”）比控件宽得多，窄屏留在标签下方占满整行，
            // 挤到右边会把状态压成三行小字。
            status={
              !status.active
                ? t("settings.semantic.inactive")
                : progress.running
                  ? t("settings.semantic.indexing", {
                      title: progress.currentTitle ?? "",
                      pending: progress.pending,
                    })
                  : undefined
            }
            tag={
              status.active && status.total > 0 && status.indexed >= status.total
                ? { text: t("settings.semantic.allIndexed"), tone: "ok" }
                : undefined
            }
          >
            <div className="flex items-center gap-3">
              <span className="ca-t-sm tabular-nums text-[var(--text-normal)]">
                {t("settings.semantic.indexedCount", { indexed: status.indexed, total: status.total })}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={!status.active || rebuilding}
                onClick={() => void rebuild()}
              >
                {rebuilding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {t("settings.semantic.rebuild")}
              </Button>
            </div>
          </Row>
          {status.active && status.total > 0 && (
            <div className="px-4 pb-3">
              <div
                role="progressbar"
                aria-label={t("settings.semantic.indexed")}
                aria-valuemin={0}
                aria-valuemax={status.total}
                aria-valuenow={status.indexed}
                className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-card-hover)]"
              >
                <div className="ca-fill-grad h-full rounded-full" style={{ width: `${indexPercent}%` }} />
              </div>
            </div>
          )}
          {progress.lastError && (
            <ErrorNote
              className="mx-4 mb-3"
              error={progress.lastError}
              onRetry={() => void ipc.semantic.resume().then(refresh)}
            />
          )}
        </Group>
      )}
    </>
  );
}
