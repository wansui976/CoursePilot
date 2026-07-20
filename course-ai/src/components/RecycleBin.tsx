import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { displayTitle } from "@/lib/videoTitle";
import { VideoCover } from "@/components/VideoCover";
import { ErrorNote } from "@/components/ui/ErrorNote";
import type { TrashedVideo } from "@/lib/types";

function daysLeft(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000));
}

/** 剩余 ≤3 天视为紧迫：红色加粗提醒用户尽快恢复。 */
const URGENT_DAYS = 3;

interface CourseGroup {
  courseId: string;
  courseName: string;
  items: TrashedVideo[];
}

function groupByCourse(items: TrashedVideo[]): CourseGroup[] {
  const groups = new Map<string, CourseGroup>();
  for (const item of items) {
    const group = groups.get(item.course_id);
    if (group) group.items.push(item);
    else
      groups.set(item.course_id, {
        courseId: item.course_id,
        courseName: item.course_name,
        items: [item],
      });
  }
  return [...groups.values()];
}

export function RecycleBin({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["trash"],
    queryFn: ipc.trash.list,
  });
  const groups = useMemo(() => groupByCourse(items), [items]);

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // 恢复/删除后列表会变，勾选里可能残留已消失的 id；渲染前按当前列表过滤。
  const selected = useMemo(() => {
    const alive = new Set(items.map((item) => item.id));
    return new Set([...selectedIds].filter((id) => alive.has(id)));
  }, [items, selectedIds]);

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(group: CourseGroup) {
    const allSelected = group.items.every((item) => selected.has(item.id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const item of group.items) {
        if (allSelected) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });
  }

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
  // 批量操作逐条调单条命令：回收站量级小，不值得加后端批量接口。
  const restoreMany = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await ipc.videos.restore(id);
    },
    // 前面的条目可能已成功、后面的条目才失败；无论结果都要同步真实列表。
    onSettled: refresh,
  });
  const purgeMany = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await ipc.videos.purge(id);
    },
    onSettled: refresh,
  });
  const purgeAll = useMutation({
    mutationFn: () => ipc.trash.purgeAll(),
    onSuccess: refresh,
  });

  async function confirmPurgeSelected() {
    const ids = [...selected];
    const ok = await confirmDialog(
      `彻底删除所选 ${ids.length} 个视频？\n此操作无法撤销。`,
      { title: "彻底删除", kind: "warning", okLabel: "彻底删除", cancelLabel: "取消" },
    );
    if (ok) purgeMany.mutate(ids);
  }

  async function confirmPurgeAll() {
    const ok = await confirmDialog(
      `清空回收站？共 ${items.length} 个视频。\n此操作无法撤销。`,
      { title: "清空回收站", kind: "warning", okLabel: "清空", cancelLabel: "取消" },
    );
    if (ok) purgeAll.mutate();
  }

  async function confirmPurge(item: TrashedVideo) {
    const ok = await confirmDialog(
      `彻底删除「${item.title}」？\n此操作无法撤销。`,
      { title: "彻底删除", kind: "warning", okLabel: "彻底删除", cancelLabel: "取消" },
    );
    if (ok) purge.mutate(item.id);
  }

  const busy =
    restoreMany.isPending || purgeMany.isPending || purgeAll.isPending;
  // 恢复/删除失败以前是静默吞掉的：汇总最近一次操作错误，显式提示，别让用户以为成功了。
  const opError =
    restore.error ??
    purge.error ??
    restoreMany.error ??
    purgeMany.error ??
    purgeAll.error;

  function renderRow(item: TrashedVideo) {
    const left = daysLeft(item.expires_at);
    return (
      <li
        key={item.id}
        className="flex items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 transition hover:bg-[var(--surface-card-hover)]"
      >
        <input
          type="checkbox"
          aria-label={`选择 ${item.title}`}
          checked={selected.has(item.id)}
          onChange={() => toggleOne(item.id)}
          className="ca-touch-44 h-4 w-4 flex-none accent-[var(--accent,#888)]"
        />
        <span className="relative h-10 w-[71px] flex-none overflow-hidden rounded-md bg-[var(--surface-card-hover)]">
          <VideoCover
            videoId={item.id}
            className="absolute inset-0 h-full w-full"
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-[var(--text-strong)]">
            {displayTitle(item.title)}
          </div>
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            {item.duration_ms != null && <span>{formatMs(item.duration_ms)}</span>}
            <span
              className={
                left <= URGENT_DAYS
                  ? "font-semibold text-[var(--status-err)]"
                  : undefined
              }
            >
              剩余 {left} 天
            </span>
          </div>
        </div>
        <button
          onClick={() => restore.mutate(item.id)}
          disabled={restore.isPending || busy}
          title="恢复"
          aria-label={`恢复 ${item.title}`}
          className="ca-touch-44 inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-strong)] transition hover:bg-[var(--surface-card-hover)] disabled:opacity-50"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          恢复
        </button>
        <button
          onClick={() => void confirmPurge(item)}
          disabled={busy}
          title="彻底删除"
          aria-label={`彻底删除 ${item.title}`}
          className="ca-touch-44 inline-flex items-center gap-1 rounded-md px-3 py-2 text-xs text-[var(--status-err)] transition hover:bg-[var(--surface-card-hover)] disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
          彻底删除
        </button>
      </li>
    );
  }

  function renderGroup(group: CourseGroup) {
    const selectedCount = group.items.filter((item) =>
      selected.has(item.id),
    ).length;
    const allSelected = selectedCount === group.items.length;
    return (
      <section key={group.courseId} aria-label={`课程 ${group.courseName}`}>
        <div className="mb-2 flex items-center gap-2">
          <input
            type="checkbox"
            aria-label={`选择 ${group.courseName} 全部`}
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = selectedCount > 0 && !allSelected;
            }}
            onChange={() => toggleGroup(group)}
            className="ca-touch-44 h-4 w-4 flex-none accent-[var(--accent,#888)]"
          />
          <h3 className="text-sm font-semibold text-[var(--text-strong)]">
            {group.courseName} ({group.items.length})
          </h3>
        </div>
        <ul className="space-y-1">{group.items.map(renderRow)}</ul>
      </section>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-[var(--surface-app)] text-[var(--text-normal)]">
      <header className="flex flex-none items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-header)] px-7 py-4">
        <button
          aria-label="返回"
          onClick={onClose}
          className="ca-icon-btn ca-touch-44 ml-0"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text-strong)]">
            <Trash2 className="h-4 w-4" />
            回收站
          </h2>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            删除的视频保留 30 天，到期自动清除；期间可恢复
          </p>
        </div>
        {items.length > 0 && (
          <button
            onClick={() => void confirmPurgeAll()}
            disabled={busy}
            className="ca-touch-44 ml-auto inline-flex flex-none items-center gap-1 rounded-md px-3 py-2 text-xs text-[var(--status-err)] transition hover:bg-[var(--surface-card-hover)] disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            清空回收站
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-2xl">
          {opError && <ErrorNote error={opError} className="mb-4" />}
          {isLoading ? (
            <p role="status" className="p-4 text-sm text-[var(--text-faint)]">
              加载中…
            </p>
          ) : items.length === 0 ? (
            <p className="p-6 text-center text-sm text-[var(--text-faint)]">
              回收站是空的
            </p>
          ) : (
            <div className="space-y-6">{groups.map(renderGroup)}</div>
          )}

          {selected.size > 0 && (
            <div className="sticky bottom-2 mt-6 flex items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-4 py-3 shadow-lg">
              <span className="text-sm text-[var(--text-strong)]">
                已选 {selected.size} 项
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => restoreMany.mutate([...selected])}
                  disabled={busy}
                  className="ca-touch-44 inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-strong)] transition hover:bg-[var(--surface-card-hover)] disabled:opacity-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  恢复所选
                </button>
                <button
                  onClick={() => void confirmPurgeSelected()}
                  disabled={busy}
                  className="ca-touch-44 inline-flex items-center gap-1 rounded-md px-3 py-2 text-xs text-[var(--status-err)] transition hover:bg-[var(--surface-card-hover)] disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  彻底删除所选
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
