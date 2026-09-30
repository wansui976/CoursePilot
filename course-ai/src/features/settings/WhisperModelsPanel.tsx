import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { ipc, type WhisperModel } from "@/lib/ipc";
import { isMobile } from "@/lib/platform";

type Row = [WhisperModel, boolean];

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${bytes} B`;
}

export function WhisperModelsPanel() {
  if (isMobile()) return null;
  return <WhisperModelsPanelDesktop />;
}

function WhisperModelsPanelDesktop() {
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

  async function downloadModel(id: string) {
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
              </span>
              {!installed && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={downloading}
                  onClick={() => void downloadModel(model.id)}
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
                onRetry={() => void downloadModel(model.id)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
