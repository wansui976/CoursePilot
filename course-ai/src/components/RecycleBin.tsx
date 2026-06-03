import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import type { TrashedVideo } from "@/lib/types";

function daysLeft(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000));
}

export function RecycleBin({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["trash"],
    queryFn: ipc.trash.list,
  });

  function refresh() {
    qc.invalidateQueries({ queryKey: ["trash"] });
    qc.invalidateQueries({ queryKey: ["courses"] });
    qc.invalidateQueries({ queryKey: ["videos"] });
  }

  const restore = useMutation({
    mutationFn: (id: string) => ipc.videos.restore(id),
    onSuccess: refresh,
  });
  const purge = useMutation({
    mutationFn: (id: string) => ipc.videos.purge(id),
    onSuccess: refresh,
  });

  async function confirmPurge(item: TrashedVideo) {
    const ok = await confirmDialog(
      `彻底删除「${item.title}」？\n此操作无法撤销。`,
      { title: "彻底删除", kind: "warning", okLabel: "彻底删除", cancelLabel: "取消" },
    );
    if (ok) purge.mutate(item.id);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[560px] max-w-full flex-col overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-rail)] text-[var(--text-normal)] shadow-[var(--shadow-pop)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-4">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--text-strong)]">
              <Trash2 className="h-4 w-4" />
              回收站
            </h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              删除的视频保留 30 天，到期自动清除；期间可恢复
            </p>
          </div>
          <button
            aria-label="关闭回收站"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {isLoading ? (
            <p className="p-4 text-sm text-[var(--text-faint)]">加载中…</p>
          ) : items.length === 0 ? (
            <p className="p-6 text-center text-sm text-[var(--text-faint)]">
              回收站是空的
            </p>
          ) : (
            <ul className="space-y-1">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-[var(--text-strong)]">
                      {item.title}
                    </div>
                    <div className="text-xs text-[var(--text-muted)]">
                      {item.course_name} · 剩余 {daysLeft(item.expires_at)} 天
                    </div>
                  </div>
                  <button
                    onClick={() => restore.mutate(item.id)}
                    disabled={restore.isPending}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] px-2 py-1 text-xs text-[var(--text-strong)] transition hover:bg-[var(--surface-card-hover)] disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    恢复
                  </button>
                  <button
                    onClick={() => void confirmPurge(item)}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-red-500 transition hover:bg-[var(--surface-card-hover)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    彻底删除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-end border-t border-[var(--border-subtle)] px-5 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            关闭
          </Button>
        </footer>
      </div>
    </div>
  );
}
