import { listen } from "@tauri-apps/api/event";
import { confirm as confirmDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { ipc, type ModelsDir, type WhisperModel } from "@/lib/ipc";
import { isMobile } from "@/lib/platform";

type Row = [WhisperModel, boolean];

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${bytes} B`;
}

/**
 * 模型存放位置。Windows 上默认在 C 盘的 AppData，模型一两个 G，可以换到别的盘；
 * 换的时候已下载的模型跟着搬过去（跨盘要复制一会儿，显示进度）。手机上没有可选的目录，不显示。
 */
function ModelsLocation({ onMoved }: { onMoved: () => void }) {
  const { t } = useTranslation();
  const [dir, setDir] = useState<ModelsDir | null>(null);
  const [moving, setMoving] = useState<{ copied: number; total: number } | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    void ipc.whisper
      .modelsDir()
      .then(setDir)
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    const unlisten = listen<{ copied: number; total: number }>("models:move", (event) => {
      setMoving(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  async function change(path: string | null) {
    setError(null);
    setMoving({ copied: 0, total: dir?.size_bytes ?? 0 });
    try {
      setDir(await ipc.whisper.setModelsDir(path));
      onMoved();
    } catch (e) {
      setError(e);
    } finally {
      setMoving(null);
    }
  }

  // 不再支持 Whisper、桌面上 Qwen3-ASR 换了引擎之后，旧模型文件还占着地方（可能好几个 G）。
  async function removeLegacy() {
    if (!dir) return;
    const ok = await confirmDialog(
      t("whisperModels.deleteLegacyConfirm", { size: formatBytes(dir.legacy_bytes) }),
      {
        title: t("whisperModels.deleteLegacy"),
        kind: "warning",
        okLabel: t("whisperModels.deleteLegacyOk"),
        cancelLabel: t("common.cancel"),
      },
    );
    if (!ok) return;
    setError(null);
    try {
      setDir(await ipc.whisper.deleteLegacyModels());
    } catch (e) {
      setError(e);
    }
  }

  async function pick() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string" && picked) await change(picked);
  }

  if (!dir) return null;
  const pct = moving && moving.total > 0 ? Math.floor((moving.copied / moving.total) * 100) : 0;
  return (
    <div className="mb-2 space-y-1 border-b border-[var(--border-subtle)] pb-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[var(--text-muted)]">{t("whisperModels.location")}</span>
        <span
          className="min-w-0 flex-1 truncate font-[family-name:var(--mono)] text-[var(--text-normal)]"
          title={dir.path}
        >
          {dir.path}
        </span>
        <span className="text-[var(--text-faint)]">
          {dir.is_default ? t("whisperModels.locationDefault") : null}
          {dir.size_bytes > 0 ? ` · ${formatBytes(dir.size_bytes)}` : ""}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={!!moving} onClick={() => void pick()}>
          {moving
            ? t("whisperModels.moving", { percent: pct })
            : t("whisperModels.changeLocation")}
        </Button>
        {!dir.is_default && (
          <Button size="sm" variant="ghost" disabled={!!moving} onClick={() => void change(null)}>
            {t("whisperModels.resetLocation")}
          </Button>
        )}
        <span className="text-xs text-[var(--text-faint)]">{t("whisperModels.locationHint")}</span>
      </div>
      {dir.legacy_bytes > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
          <span>{t("whisperModels.legacy", { size: formatBytes(dir.legacy_bytes) })}</span>
          <Button size="sm" variant="ghost" disabled={!!moving} onClick={() => void removeLegacy()}>
            {t("whisperModels.deleteLegacy")}
          </Button>
        </div>
      )}
      {error != null && <ErrorNote error={error} />}
    </div>
  );
}

/** 本地识别模型的下载清单。手机上后端只列 SenseVoice / Qwen3-ASR。 */
export function WhisperModelsPanel() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>([]);
  const [loadError, setLoadError] = useState("");
  const [progress, setProgress] = useState<
    Record<string, { received: number; total: number; done: boolean }>
  >({});
  const [startingDownloads, setStartingDownloads] = useState<Set<string>>(() => new Set());
  const [downloadErrors, setDownloadErrors] = useState<Record<string, unknown>>({});

  const refresh = useCallback(async () => {
    try {
      setRows(await ipc.whisper.list());
      setLoadError("");
    } catch (error) {
      setLoadError(t("whisperModels.loadError", { error: String(error) }));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unlisten = listen<{
      id: string;
      received: number;
      total: number;
      done: boolean;
    }>("whisper:download", (event) => {
      setProgress((current) => ({
        ...current,
        [event.payload.id]: event.payload,
      }));
      if (event.payload.done) void refresh();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refresh]);

  /** 手机上用流量下几百 MB 的模型前先问一句。查不出网络类型就不拦。 */
  async function confirmMeteredDownload(model: WhisperModel) {
    if (!isMobile()) return true;
    const metered = await ipc.app
      .networkInfo()
      .then((info) => info.metered)
      .catch(() => false);
    if (!metered) return true;
    return confirmDialog(
      t("whisperModels.meteredConfirm", {
        name: model.display_name,
        size: formatBytes(model.size_bytes),
      }),
      {
        title: t("whisperModels.meteredConfirmTitle"),
        kind: "warning",
        okLabel: t("whisperModels.meteredConfirmOk"),
        cancelLabel: t("whisperModels.meteredConfirmCancel"),
      },
    );
  }

  async function downloadModel(model: WhisperModel) {
    const id = model.id;
    if (!(await confirmMeteredDownload(model))) return;
    setDownloadErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setStartingDownloads((current) => new Set(current).add(id));
    try {
      await ipc.whisper.download(id);
      await refresh();
    } catch (error) {
      setDownloadErrors((current) => ({ ...current, [id]: error }));
    } finally {
      // invoke 的拒绝不会自带完成事件；删掉残留进度，确保失败后可以再次下载。
      setProgress((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setStartingDownloads((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  return (
    <div className="space-y-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] p-3">
      <h4 className="mb-1 text-xs font-medium text-[var(--text-muted)]">
        {t("whisperModels.title")}
      </h4>
      {!isMobile() && <ModelsLocation onMoved={() => void refresh()} />}
      {loadError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg bg-[var(--status-err-bg)] px-2 py-1.5 text-xs text-[var(--status-err)]"
        >
          <span>{loadError}</span>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            {t("whisperModels.retry")}
          </Button>
        </div>
      )}
      {rows.map(([model, installed]) => {
        const item = progress[model.id];
        const downloading = startingDownloads.has(model.id) || Boolean(item && !item.done);
        const pct = item && item.total ? Math.floor((item.received / item.total) * 100) : 0;
        return (
          <div
            key={model.id}
            className="py-1 text-sm text-[var(--text-normal)]"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                {model.display_name}
                {/* 体积帮助用户在下载前掂量（large 类模型 GB 级）。 */}
                <span className="text-xs text-[var(--text-faint)]">
                  {formatBytes(model.size_bytes)}
                </span>
                {installed && (
                  <span className="inline-flex items-center rounded-full bg-[var(--status-ok-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--status-ok)]">
                    {t("whisperModels.installed")}
                  </span>
                )}
                {model.fits_memory === false && (
                  <span
                    className="inline-flex items-center rounded-full bg-[var(--status-warn-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--status-warn)]"
                    title={t("whisperModels.lowMemoryHint")}
                  >
                    {t("whisperModels.lowMemory")}
                  </span>
                )}
              </span>
              {!installed && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={downloading}
                  onClick={() => void downloadModel(model)}
                >
                  {downloading
                    ? t("whisperModels.downloading", { percent: pct })
                    : t("whisperModels.download")}
                </Button>
              )}
            </div>
            {downloadErrors[model.id] != null && (
              <ErrorNote
                className="mt-2"
                error={downloadErrors[model.id]}
                onRetry={() => void downloadModel(model)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
