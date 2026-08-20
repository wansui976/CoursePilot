import * as Dialog from "@radix-ui/react-dialog";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderInput } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { ipc, type FolderVideo } from "@/lib/ipc";

/** 文件夹批量导入：勾选清单（默认全选）→ 批量导入所选视频。 */
export function FolderImportDialog({
  courseId,
  videos,
  onClose,
  onImported,
}: {
  courseId: string;
  videos: FolderVideo[];
  onClose: () => void;
  onImported?: () => void;
}) {
  const { t } = useTranslation();
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(videos.map((v) => v.path)),
  );
  const allSelected = selected.size === videos.length;

  const importBatch = useMutation({
    mutationFn: (paths: string[]) => ipc.videos.addLocalBatch(courseId, paths),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["videos", courseId] });
      onImported?.();
      onClose();
    },
  });

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(videos.map((v) => v.path)));
  }

  const orderedPaths = useMemo(
    () => videos.filter((v) => selected.has(v.path)).map((v) => v.path),
    [videos, selected],
  );

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !importBatch.isPending) onClose();
      }}
    >
      <Dialog.Overlay
        data-testid="folder-import-overlay"
        className="ca-dialog-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      >
        <Dialog.Content
          aria-modal="true"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocusRef.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (importBatch.isPending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (importBatch.isPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (importBatch.isPending) event.preventDefault();
          }}
          className="flex max-h-[calc(100dvh-2rem)] w-full max-w-[460px] flex-col overflow-y-auto rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-4 shadow-[var(--shadow-pop)] sm:p-5"
        >
        <Dialog.Title
          className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text-strong)]"
        >
          <FolderInput className="h-4 w-4" />
          {t("folderImport.title")}
        </Dialog.Title>
        <Dialog.Description
          className="mb-3 text-xs text-[var(--text-muted)]"
        >
          {t("folderImport.found", { count: videos.length })}
        </Dialog.Description>

        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={toggleAll}
            className="ca-touch-44 text-xs text-primary hover:underline"
          >
            {allSelected ? t("folderImport.deselectAll") : t("folderImport.selectAll")}
          </button>
          <span className="text-xs text-[var(--text-muted)]">
            {t("folderImport.selected", { selected: selected.size, total: videos.length })}
          </span>
        </div>

        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {videos.map((v) => (
            <li key={v.path}>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--surface-card-hover)]">
                <input
                  type="checkbox"
                  aria-label={t("folderImport.selectItem", { name: v.name })}
                  checked={selected.has(v.path)}
                  onChange={() => toggle(v.path)}
                  className="ca-touch-44 h-4 w-4 flex-none accent-[var(--accent,#888)]"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-normal)]">
                  {v.name}
                </span>
              </label>
            </li>
          ))}
        </ul>

        {importBatch.isError && (
          <ErrorNote className="mt-2" error={importBatch.error} />
        )}

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={importBatch.isPending}
            onClick={onClose}
          >
            {t("folderImport.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={selected.size === 0 || importBatch.isPending}
            onClick={() => importBatch.mutate(orderedPaths)}
          >
            {importBatch.isPending ? t("folderImport.importing") : t("folderImport.importCount", { count: selected.size })}
          </Button>
        </div>
        </Dialog.Content>
      </Dialog.Overlay>
    </Dialog.Root>
  );
}
