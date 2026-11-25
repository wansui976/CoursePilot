import { qk } from "@/lib/queryKeys";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Copy, Info, RefreshCw } from "lucide-react";
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
import { Skeleton } from "@/ui/skeleton";
import { cn } from "@/lib/utils";

const MB = 1024 * 1024;
// 按「人看的顺序」排：第 2 讲在第 10 讲前面。导入也按这个顺序，课程里的集数才对。
const byLectureOrder = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
// 勾选框用墨色：选中是中性状态，绿色只留给「导入」这一个主操作。
const CHECKBOX = "h-[18px] w-[18px] flex-none cursor-pointer accent-[var(--text-strong)] disabled:cursor-not-allowed";
// 文字按钮（刷新、全选）：中性色，不和主操作抢绿色。
const TEXT_ACTION =
  "ca-touch-44 inline-flex items-center gap-1 rounded-md px-1.5 text-[13px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-strong)] disabled:opacity-50";
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
  const [progress, setProgress] = useState<{ done: number; total: number; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // 看到过的文件：重新列的时候，用户取消勾选的不再被勾回来，只有新拷进来的才默认勾上。
  const seenRef = useRef<Set<string>>(new Set());
  const importingRef = useRef(false);
  const files: CableFile[] | null = scan
    ? [...scan.files].sort((a, b) => byLectureOrder.compare(a.name, b.name))
    : null;

  const refresh = useCallback(async () => {
    // 导入进行中不重新列：文件正被一个个挪走，列表跟着跳会让进度和勾选对不上。
    // App 切到后台时也不列（回到前台由 focus 立刻补一次）：别在后台每 3 秒读一遍文件夹。
    if (importingRef.current || (typeof document !== "undefined" && document.hidden)) return;
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
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
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
      try {
        for (const path of paths) {
          const name = files?.find((file) => file.path === path)?.name ?? path;
          setProgress({ done, total: paths.length, name });
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

  const chosen = ready.filter((file) => selected.has(file.path));
  const ordered = chosen.map((file) => file.path);
  const chosenBytes = chosen.reduce((sum, file) => sum + file.size, 0);
  const folder = scan?.folder ?? null;

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      locked={importSelected.isPending}
      title={t("cableImport.title")}
      description={t(android ? "cableImport.introAndroid" : "cableImport.intro")}
      size="lg"
      className="flex max-h-[85vh] flex-col"
      overlayTestId="cable-import-overlay"
      returnFocusTo={() => returnFocusRef?.current ?? restoreFocusRef.current}
    >
      <div className="mt-4 flex min-h-0 flex-1 flex-col gap-3">
        {android && folder && (
          <div className="flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] py-1.5 pl-3 pr-1.5">
            <code className="min-w-0 flex-1 break-words font-mono text-xs text-[var(--text-strong)]">
              {t("cableImport.androidFolder", { path: folder.split("/").join(" › ") })}
            </code>
            <button type="button" onClick={() => void copyFolderPath(folder)} className={TEXT_ACTION}>
              <Copy aria-hidden="true" className="h-3.5 w-3.5" />
              {copied ? t("cableImport.pathCopied") : t("cableImport.copyPath")}
            </button>
          </div>
        )}

        <div className="ca-callout info">
          <Info className="ca-callout-icon" aria-hidden="true" />
          <div className="min-w-0 space-y-1">
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
            <p className="text-[var(--text-muted)]">{t("cableImport.cleanupHint")}</p>
          </div>
        </div>

        {loadError != null && (
          <div className="space-y-1">
            <ErrorNote error={loadError} onRetry={() => void refresh()} />
            <p className="ca-t-xs px-1 leading-relaxed text-[var(--text-muted)]">{t("cableImport.loadFailed")}</p>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)]">
          <div className="flex h-10 flex-none items-center gap-1 border-b border-[var(--border-faint)] px-2">
            {ready.length > 0 && (
              <button type="button" onClick={toggleAll} disabled={importSelected.isPending} className={TEXT_ACTION}>
                {allSelected ? t("cableImport.deselectAll") : t("cableImport.selectAll")}
              </button>
            )}
            <span className="ca-t-xs min-w-0 flex-1 truncate px-1 text-[var(--text-faint)]">
              {ready.length > 0 && t("cableImport.selected", { selected: ordered.length, total: ready.length })}
            </span>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={importSelected.isPending}
              className={TEXT_ACTION}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              {t("cableImport.refresh")}
            </button>
          </div>

          <div className="min-h-[9rem] flex-1 overflow-y-auto">
            {files == null && loadError == null && (
              <div role="status" aria-label={t("common.loading")} className="space-y-1 px-3 py-2">
                {[64, 48, 72].map((width) => (
                  <div key={width} className="flex h-11 items-center gap-3">
                    <Skeleton className="h-4 w-4 flex-none rounded-[var(--r-xs)]" />
                    <div className="min-w-0" style={{ width: `${width}%` }}>
                      <Skeleton className="h-3 w-full rounded-[var(--r-xs)]" />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {files != null && files.length === 0 && (
              <p className="flex h-full min-h-[9rem] items-center justify-center px-6 text-center text-[13px] leading-relaxed text-[var(--text-muted)]">
                {scan && scan.scanned > 0
                  ? t("cableImport.emptyUnsupported", {
                      count: scan.scanned,
                      formats: t(android ? "cableImport.formatsAndroid" : "cableImport.formatsIos"),
                    })
                  : t(android ? "cableImport.emptyNoneAndroid" : "cableImport.emptyNone")}
              </p>
            )}

            {files != null && files.length > 0 && (
              <ul className="p-1">
                {files.map((file) => {
                  const checked = !file.settling && selected.has(file.path);
                  return (
                    <li key={file.path}>
                      <label
                        className={cn(
                          "flex min-h-11 items-center gap-3 rounded-md px-2 py-1.5 transition-colors",
                          file.settling
                            ? "cursor-default"
                            : checked
                              ? "cursor-pointer bg-[var(--surface-card-active)]"
                              : "cursor-pointer hover:bg-[var(--surface-card-hover)]",
                        )}
                      >
                        <input
                          type="checkbox"
                          aria-label={t("cableImport.selectItem", { name: file.name })}
                          checked={checked}
                          disabled={file.settling || importSelected.isPending}
                          onChange={() => toggle(file.path)}
                          className={CHECKBOX}
                        />
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-sm",
                            file.settling ? "text-[var(--text-muted)]" : "text-[var(--text-strong)]",
                          )}
                        >
                          {file.name}
                        </span>
                        {file.settling ? (
                          <span className="flex-none rounded-[var(--r-xs)] border border-[var(--border-faint)] px-1.5 py-px text-[12px] leading-[18px] text-[var(--text-muted)]">
                            {t("cableImport.settling")}
                          </span>
                        ) : (
                          <span className="flex-none font-mono text-[12px] text-[var(--text-faint)]">
                            {formatSize(file.size)}
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {failures.length > 0 && (
          <div role="alert" className="ca-callout err">
            <AlertCircle className="ca-callout-icon" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-medium text-[var(--text-strong)]">
                {t("cableImport.failed", { count: failures.length })}
              </p>
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
          </div>
        )}

        <div className="flex items-center gap-2 border-t border-[var(--border-faint)] pt-3">
          <p className="ca-t-xs min-w-0 flex-1 truncate text-[var(--text-muted)]" aria-live="polite">
            {progress
              ? t("cableImport.progressItem", { done: progress.done + 1, total: progress.total, name: progress.name })
              : ordered.length > 0
                ? t("cableImport.summary", { count: ordered.length, size: formatSize(chosenBytes) })
                : null}
          </p>
          <Button variant="ghost" disabled={importSelected.isPending} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={ordered.length === 0 || importSelected.isPending}
            onClick={() => importSelected.mutate(ordered)}
          >
            {importSelected.isPending
              ? t("cableImport.importing")
              : t("cableImport.importCount", { count: ordered.length })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
