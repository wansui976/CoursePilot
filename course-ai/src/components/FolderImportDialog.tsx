import { useEffect, useMemo, useState } from "react";
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

  // Esc 关闭（导入中不关，避免打断批量写入）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !importBatch.isPending) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importBatch.isPending]);

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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => !importBatch.isPending && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-import-title"
        className="flex max-h-[80vh] w-[460px] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-5 shadow-[var(--shadow-pop)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="folder-import-title"
          className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text-strong)]"
        >
          <FolderInput className="h-4 w-4" />
          导入文件夹视频
        </h2>
        <p className="mb-3 text-xs text-[var(--text-muted)]">
          找到 {videos.length} 个视频，已导入过的会自动跳过。
        </p>

        <div className="mb-2 flex items-center justify-between">
          <button
            type="button"
            onClick={toggleAll}
            className="ca-touch-44 text-xs text-primary hover:underline"
          >
            {allSelected ? "全不选" : "全选"}
          </button>
          <span className="text-xs text-[var(--text-muted)]">
            已选 {selected.size} / {videos.length}
          </span>
        </div>

        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {videos.map((v) => (
            <li key={v.path}>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--surface-card-hover)]">
                <input
                  type="checkbox"
                  aria-label={`选择 ${v.name}`}
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

        <div className="mt-3 flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={importBatch.isPending}
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            size="sm"
            disabled={selected.size === 0 || importBatch.isPending}
            onClick={() => importBatch.mutate(orderedPaths)}
          >
            {importBatch.isPending ? "导入中…" : `导入 (${selected.size})`}
          </Button>
        </div>
      </div>
    </div>
  );
}
