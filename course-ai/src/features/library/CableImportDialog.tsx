import { qk } from "@/lib/queryKeys";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Cable, Copy, RefreshCw } from "lucide-react";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { humanizeError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import {
  isAndroid,
  listCableFiles,
  returnCableFile,
  takeCableFile,
  type CableFile,
  type CableScan,
} from "@/lib/mobileFiles";
import { Modal } from "@/ui/dialog";

const MB = 1024 * 1024;
const formatSize = (bytes: number) =>
  bytes >= 1024 * MB
    ? `${(bytes / 1024 / MB).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / MB))} MB`;

/** 对话框开着时多久重新看一次文件夹。Android 用 USB 传文件时 App 一直在前台，
 *  不会有「回到前台」这个时机，只能自己定时看；iOS 也顺带受益（拷完不用手点刷新）。 */
export const CABLE_POLL_MS = 3000;

interface ImportFailure {
  name: string;
  error: string;
  /** 已经挪进资料库、加进课程失败后，又放回了原来的文件夹。 */
  returned: boolean;
}

/**
 * 数据线导入：
 * - iOS：Finder / Apple 设备把视频放进 App「文稿」；
 * - Android：USB「文件传输」模式下，电脑把视频拷进 App 媒体目录里的「导入」文件夹。
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
  const android = isAndroid();
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
  const [copied, setCopied] = useState(false);
  // 看到过的文件：重新列的时候，用户取消勾选的不再被勾回来，只有新拷进来的才默认勾上。
  const seenRef = useRef<Set<string>>(new Set());
  const importingRef = useRef(false);
  const files: CableFile[] | null = scan?.files ?? null;

  const refresh = useCallback(async () => {
    // 导入进行中不重新列：文件正被一个个挪走，列表跟着跳会让进度和勾选对不上。
    if (importingRef.current) return;
    try {
      const next = await listCableFiles();
      setLoadError(null);
      setScan(next);
      const ready = next.files.filter((file) => !file.settling).map((file) => file.path);
      const present = new Set(next.files.map((file) => file.path));
      // 先算出这一轮新出现的（更新函数要到渲染时才跑，那时 seenRef 已经记上了）。
      // 还在拷的不算「看到过」：拷完那一刻才默认勾上。
      const fresh = ready.filter((path) => !seenRef.current.has(path));
      for (const path of fresh) seenRef.current.add(path);
      setSelected((prev) => {
        const merged = new Set<string>();
        for (const path of prev) if (present.has(path)) merged.add(path);
        for (const path of fresh) merged.add(path);
        return merged;
      });
    } catch (error) {
      setLoadError(error);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), CABLE_POLL_MS);
    // iOS 用 Finder 拷文件时 App 可能在后台：回到前台立刻看一次，不等下一轮。
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const ready = (files ?? []).filter((file) => !file.settling);
  const allSelected = ready.length > 0 && ready.every((file) => selected.has(file.path));

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(ready.map((file) => file.path)));
  }

  async function copyFolderPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（权限、旧 WebView）时什么也不做：路径就写在上面，照着找也行。
    }
  }

  const importSelected = useMutation({
    mutationFn: async (paths: string[]) => {
      importingRef.current = true;
      const failed: ImportFailure[] = [];
      let done = 0;
      setFailures([]);
      setProgress({ done, total: paths.length });
      try {
        for (const path of paths) {
          const name = files?.find((file) => file.path === path)?.name ?? path;
          let taken: Awaited<ReturnType<typeof takeCableFile>> = null;
          try {
            taken = await takeCableFile(path, "videos");
            if (!taken) throw new Error("cable import is only available on iOS and Android");
            await ipc.videos.addLocal(courseId, taken.path, taken.durationMs);
          } catch (error) {
            // 文件已经挪进资料库、却没加进课程：放回原文件夹，不让它消失在 App 的私有目录里。
            let returned = false;
            if (taken) {
              returned = await returnCableFile(taken.path).then(
                (back) => back != null,
                () => false,
              );
            }
            failed.push({ name, error: humanizeError(error, i18n.language), returned });
          }
          done += 1;
          setProgress({ done, total: paths.length });
        }
      } finally {
        importingRef.current = false;
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

  const ordered = ready.filter((file) => selected.has(file.path)).map((file) => file.path);
  const folder = scan?.folder ?? null;

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
      description={t(android ? "cableImport.introAndroid" : "cableImport.intro")}
      descriptionClassName="mt-0 mb-3 leading-normal"
      size="lg"
      className="flex flex-col"
      overlayTestId="cable-import-overlay"
      returnFocusTo={() => returnFocusRef?.current ?? restoreFocusRef.current}
    >
      {android && folder && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-3 py-2">
          <code className="min-w-0 flex-1 break-words font-mono text-xs text-[var(--text-strong)]">
            {t("cableImport.androidFolder", { path: folder.split("/").join(" › ") })}
          </code>
          <button
            type="button"
            onClick={() => void copyFolderPath(folder)}
            className="ca-touch-44 inline-flex flex-none items-center gap-1 rounded-md px-2 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
          >
            <Copy aria-hidden="true" className="h-3.5 w-3.5" />
            {copied ? t("cableImport.pathCopied") : t("cableImport.copyPath")}
          </button>
        </div>
      )}

      <div className="mb-3 space-y-1 rounded-lg bg-[var(--surface-card-hover)] px-3 py-2 text-xs leading-relaxed text-[var(--text-muted)]">
        {android ? (
          <>
            <p>{t("cableImport.stepAndroidWindows")}</p>
            <p>{t("cableImport.stepAndroidMac")}</p>
          </>
        ) : (
          <>
            <p>{t("cableImport.stepMac")}</p>
            <p>{t("cableImport.stepWindows")}</p>
          </>
        )}
        <p>{t("cableImport.cleanupHint")}</p>
      </div>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={importSelected.isPending}
            className="ca-touch-44 inline-flex items-center gap-1 text-xs text-[var(--accent-text)] hover:underline disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t("cableImport.refresh")}
          </button>
          {ready.length > 0 && (
            <button
              type="button"
              onClick={toggleAll}
              disabled={importSelected.isPending}
              className="ca-touch-44 text-xs text-[var(--accent-text)] hover:underline disabled:opacity-50"
            >
              {allSelected ? t("cableImport.deselectAll") : t("cableImport.selectAll")}
            </button>
          )}
        </div>
        {ready.length > 0 && (
          <span className="text-xs text-[var(--text-muted)]">
            {t("cableImport.selected", { selected: ordered.length, total: ready.length })}
          </span>
        )}
      </div>

      {loadError != null && (
        <>
          <ErrorNote error={loadError} />
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
            {t("cableImport.loadFailed")}
          </p>
        </>
      )}

      {files == null && loadError == null && (
        <p className="py-6 text-center text-sm text-[var(--text-muted)]">{t("common.loading")}</p>
      )}

      {files != null && files.length === 0 && (
        <p className="py-6 text-center text-sm leading-relaxed text-[var(--text-muted)]">
          {scan && scan.scanned > 0
            ? t("cableImport.emptyUnsupported", {
                count: scan.scanned,
                formats: t(android ? "cableImport.formatsAndroid" : "cableImport.formatsIos"),
              })
            : t(android ? "cableImport.emptyNoneAndroid" : "cableImport.emptyNone")}
        </p>
      )}

      {files != null && files.length > 0 && (
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {files.map((file) => (
            <li key={file.path}>
              <label
                className={`flex min-h-11 items-center gap-2.5 rounded-lg px-2 py-1.5 ${
                  file.settling ? "cursor-default opacity-60" : "cursor-pointer hover:bg-[var(--surface-card-hover)]"
                }`}
              >
                <input
                  type="checkbox"
                  aria-label={t("cableImport.selectItem", { name: file.name })}
                  checked={!file.settling && selected.has(file.path)}
                  disabled={file.settling || importSelected.isPending}
                  onChange={() => toggle(file.path)}
                  className="h-[18px] w-[18px] flex-none accent-[var(--accent)]"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-normal)]">
                  {file.name}
                </span>
                <span className="flex-none font-mono text-xs tabular-nums text-[var(--text-muted)]">
                  {file.settling ? t("cableImport.settling") : formatSize(file.size)}
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
                {failure.returned && t("cableImport.returned")}
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
          disabled={ordered.length === 0 || importSelected.isPending}
          onClick={() => importSelected.mutate(ordered)}
        >
          {importSelected.isPending
            ? t("cableImport.importing")
            : t("cableImport.importCount", { count: ordered.length })}
        </Button>
      </div>
    </Modal>
  );
}
