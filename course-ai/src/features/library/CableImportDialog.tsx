import { qk } from "@/lib/queryKeys";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Cable, RefreshCw } from "lucide-react";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { humanizeError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import { listCableFiles, takeCableFile, type CableFile, type CableScan } from "@/lib/mobileFiles";
import { Modal } from "@/ui/dialog";

const MB = 1024 * 1024;
const formatSize = (bytes: number) =>
  bytes >= 1024 * MB
    ? `${(bytes / 1024 / MB).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / MB))} MB`;

interface ImportFailure {
  name: string;
  error: string;
}

/**
 * 数据线导入（iOS）：Finder / Apple 设备把视频放进 App「文稿」后，
 * 这里自动列出来，勾选后移进资料库（同一份文件只占一份空间）。
 */
export function CableImportDialog({
  courseId,
  onClose,
  returnFocusRef,
}: {
  courseId: string;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const [scan, setScan] = useState<CableScan | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<ImportFailure[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const files: CableFile[] | null = scan?.files ?? null;

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const next = await listCableFiles();
      setScan(next);
      setSelected(new Set(next.files.map((file) => file.path)));
    } catch (error) {
      setLoadError(error);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 数据线拷文件时 App 可能在后台：回到前台后重新列一次，不用用户手点刷新。
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const allSelected = files != null && files.length > 0 && selected.size === files.length;

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleAll() {
    if (!files) return;
    setSelected(allSelected ? new Set() : new Set(files.map((file) => file.path)));
  }

  const importSelected = useMutation({
    mutationFn: async (paths: string[]) => {
      const failed: ImportFailure[] = [];
      let done = 0;
      setFailures([]);
      setProgress({ done, total: paths.length });
      for (const path of paths) {
        const name = files?.find((file) => file.path === path)?.name ?? path;
        try {
          const taken = await takeCableFile(path, "videos");
          if (!taken) throw new Error("cable import is only available on iOS");
          await ipc.videos.addLocal(courseId, taken.path, taken.durationMs);
        } catch (error) {
          failed.push({ name, error: humanizeError(error, i18n.language) });
        }
        done += 1;
        setProgress({ done, total: paths.length });
      }
      return failed;
    },
    onSuccess: async (failed) => {
      setProgress(null);
      queryClient.invalidateQueries({ queryKey: qk.videos.list(courseId) });
      if (failed.length === 0) {
        onClose();
        return;
      }
      setFailures(failed);
      await refresh();
    },
  });

  const ordered = (files ?? [])
    .filter((file) => selected.has(file.path))
    .map((file) => file.path);

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      locked={importSelected.isPending}
      title={t("cableImport.title")}
      icon={<Cable className="h-4 w-4" />}
      titleClassName="mb-1"
      description={t("cableImport.intro")}
      descriptionClassName="mt-0 mb-3 leading-normal"
      size="lg"
      className="flex flex-col"
      overlayTestId="cable-import-overlay"
      returnFocusTo={() => returnFocusRef?.current ?? restoreFocusRef.current}
    >
      <div className="mb-3 space-y-1 rounded-lg bg-[var(--surface-card-hover)] px-3 py-2 text-xs leading-relaxed text-[var(--text-muted)]">
        <p>{t("cableImport.stepMac")}</p>
        <p>{t("cableImport.stepWindows")}</p>
        <p>{t("cableImport.cleanupHint")}</p>
      </div>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={importSelected.isPending}
            className="ca-touch-44 inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t("cableImport.refresh")}
          </button>
          {files != null && files.length > 0 && (
            <button
              type="button"
              onClick={toggleAll}
              className="ca-touch-44 text-xs text-primary hover:underline"
            >
              {allSelected ? t("cableImport.deselectAll") : t("cableImport.selectAll")}
            </button>
          )}
        </div>
        {files != null && files.length > 0 && (
          <span className="text-xs text-[var(--text-muted)]">
            {t("cableImport.selected", { selected: selected.size, total: files.length })}
          </span>
        )}
      </div>

      {loadError != null && (
        <>
          <ErrorNote error={loadError} />
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
            {t("cableImport.outdated")}
          </p>
        </>
      )}

      {files == null && loadError == null && (
        <p className="py-6 text-center text-sm text-[var(--text-muted)]">{t("common.loading")}</p>
      )}

      {files != null && files.length === 0 && (
        <p className="py-6 text-center text-sm text-[var(--text-muted)]">
          {scan && scan.scanned > 0
            ? t("cableImport.emptyUnsupported", { count: scan.scanned })
            : t("cableImport.emptyNone")}
        </p>
      )}

      {files != null && files.length > 0 && (
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {files.map((file) => (
            <li key={file.path}>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--surface-card-hover)]">
                <input
                  type="checkbox"
                  aria-label={t("cableImport.selectItem", { name: file.name })}
                  checked={selected.has(file.path)}
                  onChange={() => toggle(file.path)}
                  className="ca-touch-44 h-4 w-4 flex-none accent-[var(--accent,#888)]"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-normal)]">
                  {file.name}
                </span>
                <span className="flex-none tabular-nums text-xs text-[var(--text-muted)]">
                  {formatSize(file.size)}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {failures.length > 0 && (
        <div
          role="alert"
          className="mt-2 rounded-lg bg-[var(--status-err-bg)] px-3 py-2 text-xs leading-relaxed text-[var(--status-err)]"
        >
          <p className="font-medium">{t("cableImport.failed", { count: failures.length })}</p>
          <ul className="mt-1 space-y-0.5">
            {failures.map((failure) => (
              <li key={failure.name} className="break-words">
                {t("cableImport.failedItem", {
                  name: failure.name,
                  reason: failure.error,
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {progress && (
          <span className="mr-auto text-xs text-[var(--text-muted)]">
            {t("cableImport.progress", progress)}
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={importSelected.isPending}
          onClick={onClose}
        >
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={selected.size === 0 || importSelected.isPending}
          onClick={() => importSelected.mutate(ordered)}
        >
          {importSelected.isPending
            ? t("cableImport.importing")
            : t("cableImport.importCount", { count: selected.size })}
        </Button>
      </div>
    </Modal>
  );
}
