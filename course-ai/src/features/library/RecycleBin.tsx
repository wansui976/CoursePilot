import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { qk } from "@/lib/queryKeys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { displayTitle } from "@/lib/videoTitle";
import { VideoCover } from "./VideoCover";
import { EmptyState } from "@/ui/empty-state";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { ViewHeader } from "@/ui/view-header";
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
  const { t } = useTranslation();
  const qc = useQueryClient();
  const {
    data: items = [],
    isLoading,
    isError,
    error: loadError,
    refetch,
  } = useQuery({
    queryKey: qk.trash(),
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
    qc.invalidateQueries({ queryKey: qk.trash() });
    qc.invalidateQueries({ queryKey: qk.courses() });
    qc.invalidateQueries({ queryKey: qk.videos.all() });
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
      t("recycleBin.deleteSelectedConfirm", { count: ids.length }),
      { title: t("recycleBin.deleteConfirmTitle"), kind: "warning", okLabel: t("recycleBin.permanentDelete"), cancelLabel: t("common.cancel") },
    );
    if (ok) purgeMany.mutate(ids);
  }

  async function confirmPurgeAll() {
    const ok = await confirmDialog(
      t("recycleBin.clearAllConfirm", { count: items.length }),
      { title: t("recycleBin.clearConfirmTitle"), kind: "warning", okLabel: t("recycleBin.clear"), cancelLabel: t("common.cancel") },
    );
    if (ok) purgeAll.mutate();
  }

  async function confirmPurge(item: TrashedVideo) {
    const ok = await confirmDialog(
      t("recycleBin.deleteSingleConfirm", { title: item.title }),
      { title: t("recycleBin.deleteConfirmTitle"), kind: "warning", okLabel: t("recycleBin.permanentDelete"), cancelLabel: t("common.cancel") },
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

  // 外观与课程列表视图的行（.ca-row / .row-thumb）同一套：同样的缩略图尺寸、标题字号、
  // 分隔线与悬停浮起。原来这里自成一派——居中窄栏、更大的缩略图、普通字重的标题，
  // 和旁边的课程列表、处理队列放在一起像是另一个应用。
  // 手机宽度下操作按钮换到第二行，否则标题会被挤得只剩几个字。
  function renderRow(item: TrashedVideo) {
    const left = daysLeft(item.expires_at);
    return (
      <li
        key={item.id}
        className="ca-row flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2 sm:flex-nowrap sm:px-3"
      >
        <label className="inline-flex h-11 w-8 flex-none cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            aria-label={t("recycleBin.selectItem", { title: item.title })}
            checked={selected.has(item.id)}
            onChange={() => toggleOne(item.id)}
            className="h-4 w-4 accent-[var(--accent,#888)]"
          />
        </label>
        <span className="row-thumb">
          <VideoCover videoId={item.id} className="absolute inset-0 h-full w-full" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-[550] text-[var(--text-1)]">
            {displayTitle(item.title)}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs tabular-nums text-[var(--text-muted)]">
            {item.duration_ms != null && <span>{formatMs(item.duration_ms)}</span>}
            <span
              className={
                left <= URGENT_DAYS
                  ? "font-semibold text-[var(--status-err)]"
                  : undefined
              }
            >
              {t("recycleBin.daysLeft", { days: left })}
            </span>
          </div>
        </div>
        <div
          data-recycle-row-actions
          className="flex w-full flex-none items-center justify-end gap-1 pl-11 sm:w-auto sm:pl-0"
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => restore.mutate(item.id)}
            disabled={restore.isPending || busy}
            title={t("recycleBin.restoreTitle")}
            aria-label={t("recycleBin.restoreItem", { title: item.title })}
            className="ca-touch-44 gap-1"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("recycleBin.restore")}
          </Button>
          {/* 每一行都挂一个红色按钮，整页红成一片；平时灰色，悬停才变红（删除前还有确认）。 */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void confirmPurge(item)}
            disabled={busy}
            title={t("recycleBin.permanentDeleteTitle")}
            aria-label={t("recycleBin.deleteItem", { title: item.title })}
            className="ca-touch-44 gap-1 text-[var(--text-muted)] hover:text-[var(--status-err)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("recycleBin.permanentDelete")}
          </Button>
        </div>
      </li>
    );
  }

  function renderGroup(group: CourseGroup) {
    const selectedCount = group.items.filter((item) =>
      selected.has(item.id),
    ).length;
    const allSelected = selectedCount === group.items.length;
    return (
      <section key={group.courseId} aria-label={t("recycleBin.courseGroup", { name: group.courseName })}>
        {/* 分区标题与处理队列的「正在下载」同款：小图标 + 次要色小字，不和条目抢视线。
            整组勾选框与行内勾选框同一列。 */}
        <div className="mb-1 flex items-center gap-3 px-2 sm:px-3">
          <label className="inline-flex h-8 w-8 flex-none cursor-pointer items-center justify-center">
            <input
              type="checkbox"
              aria-label={t("recycleBin.selectAllInCourse", { name: group.courseName })}
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = selectedCount > 0 && !allSelected;
              }}
              onChange={() => toggleGroup(group)}
              className="h-4 w-4 accent-[var(--accent,#888)]"
            />
          </label>
          <h2 className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
            <FolderOpen className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
            <span className="truncate">
              {group.courseName} ({group.items.length})
            </span>
          </h2>
        </div>
        <ul>{group.items.map(renderRow)}</ul>
      </section>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-[var(--surface-app)] text-[var(--text-normal)]">
      <ViewHeader
        title={t("recycleBin.title")}
        description={t("recycleBin.description")}
        onBack={onClose}
        actions={
          items.length > 0 ? (
            // 与处理队列的「全部取消」同款：带边框的小按钮 + 右侧计数。
            <div className="flex flex-none items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void confirmPurgeAll()}
                disabled={busy}
                title={t("recycleBin.clearAll")}
                aria-label={t("recycleBin.clearAll")}
                className="ca-touch-44 gap-1 text-[var(--status-err)]"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span className="sr-only min-[400px]:not-sr-only">
                  {t("recycleBin.clearAll")}
                </span>
              </Button>
              <span className="hidden text-xs tabular-nums text-[var(--text-muted)] min-[400px]:inline">
                {t("recycleBin.count", { count: items.length })}
              </span>
            </div>
          ) : undefined
        }
      />

      {/* 和处理队列同样的版心：左右 28px 铺满，左缘与标题对齐，不再居中缩成一条窄栏。 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-7 sm:py-6">
        <div>
          {opError && <ErrorNote error={opError} className="mb-4" />}
          {isLoading ? (
            <p role="status" className="p-4 text-sm text-[var(--text-faint)]">
              {t("recycleBin.loading")}
            </p>
          ) : isError ? (
            <ErrorNote
              error={loadError}
              onRetry={() => void refetch()}
            />
          ) : items.length === 0 ? (
            <div className="flex min-h-[320px] items-center justify-center">
              <EmptyState
                title={t("recycleBin.empty")}
              />
            </div>
          ) : (
            <div className="space-y-6">{groups.map(renderGroup)}</div>
          )}

          {selected.size > 0 && (
            <div className="sticky bottom-2 mt-6 flex flex-col items-stretch gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-3 shadow-[var(--shadow-pop)] min-[400px]:flex-row min-[400px]:items-center min-[400px]:gap-3 min-[400px]:px-4">
              <span className="text-sm text-[var(--text-strong)]">
                {t("recycleBin.selected", { count: selected.size })}
              </span>
              <div className="grid w-full grid-cols-1 gap-2 min-[400px]:ml-auto min-[400px]:flex min-[400px]:w-auto min-[400px]:items-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => restoreMany.mutate([...selected])}
                  disabled={busy}
                  className="ca-touch-44 gap-1"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t("recycleBin.restoreSelected")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void confirmPurgeSelected()}
                  disabled={busy}
                  className="ca-touch-44 gap-1 text-[var(--status-err)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("recycleBin.deleteSelected")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
