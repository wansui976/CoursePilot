import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { Download, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { ipc, type PaddleOcrStatus } from "@/lib/ipc";
import { Row } from "@/features/settings/primitives";

const MB = 1024 * 1024;
const formatMb = (bytes: number) => `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;

/**
 * 选了 PaddleOCR 时 OCR 引擎下面的那一行：没下载就给「下载」（带进度），下载好了显示大小和「删除」。
 * 删掉后后端把引擎改回本地 OCR，这里通过 onRemoved 让表单同步。
 */
export function PaddleOcrModelRow({
  status,
  onChanged,
  onRemoved,
}: {
  status: PaddleOcrStatus;
  onChanged: () => void | Promise<void>;
  onRemoved: () => void;
}) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    const unlisten = listen<{ received: number; total: number; done: boolean }>(
      "ocr-model:download",
      (event) => {
        const { received, total, done } = event.payload;
        setProgress(done ? null : total > 0 ? received / total : 0);
      },
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  async function download() {
    setError(null);
    setProgress(0);
    try {
      await ipc.ocrModel.download();
    } catch (err) {
      setError(err);
    } finally {
      setProgress(null);
      await onChanged();
    }
  }

  async function remove() {
    const ok = await confirmDialog(t("settings.ocr.paddleDeleteConfirm"), {
      title: t("settings.ocr.paddleDeleteTitle"),
      kind: "warning",
      okLabel: t("settings.ocr.paddleDelete"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    setError(null);
    setRemoving(true);
    try {
      await ipc.ocrModel.remove();
      onRemoved();
    } catch (err) {
      setError(err);
    } finally {
      setRemoving(false);
      await onChanged();
    }
  }

  const downloading = progress != null;
  return (
    <>
      <Row
        label={t("settings.ocr.paddleModel")}
        hint={t("settings.ocr.paddleModelHint")}
        tag={
          status.installed
            ? { text: t("settings.ocr.paddleInstalled", { size: formatMb(status.sizeOnDisk) }), tone: "ok" }
            : { text: t("settings.ocr.paddleNotInstalled", { size: formatMb(status.downloadSize) }) }
        }
      >
        {status.installed ? (
          <Button
            size="sm"
            variant="outline"
            disabled={removing}
            className="text-[var(--status-err)]"
            onClick={() => void remove()}
          >
            {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            {t("settings.ocr.paddleDelete")}
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={downloading} onClick={() => void download()}>
            {downloading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {downloading
              ? t("settings.ocr.paddleDownloading", { percent: Math.floor((progress ?? 0) * 100) })
              : t("settings.ocr.paddleDownload")}
          </Button>
        )}
      </Row>
      {error != null && <ErrorNote className="mx-4 mb-3" error={error} onRetry={() => void download()} />}
    </>
  );
}
