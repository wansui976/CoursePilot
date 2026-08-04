import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { Play, Scissors, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PanelEmptyState } from "@/components/ui/empty-state";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import type { Clip } from "@/lib/types";
import { usePlayer } from "@/stores/player";

export function ClipsPanel({ videoId }: { videoId: string }) {
  const qc = useQueryClient();
  const requestSeek = usePlayer((s) => s.requestSeek);
  // 懒读播放进度（不订阅，避免每秒重渲染）。
  const nowMs = () => Math.floor(usePlayer.getState().currentMs);
  // 起点标记连同 videoId 一起存：组件被 TabsPanel 保活，换视频只变 prop 不重挂，
  // 别的视频里标的起点在当前视频必须视为不存在，否则会拼出跨视频的错误片段。
  const [pending, setPending] = useState<{ videoId: string; ms: number } | null>(
    null,
  );
  const pendingStart = pending?.videoId === videoId ? pending.ms : null;
  const setPendingStart = (ms: number | null) =>
    setPending(ms == null ? null : { videoId, ms });

  const { data: clips = [] } = useQuery({
    queryKey: ["clips", videoId],
    queryFn: () => ipc.clips.list(videoId),
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["clips", videoId] });

  const add = useMutation({
    mutationFn: (v: { start: number; end: number }) =>
      ipc.clips.add(videoId, v.start, v.end, ""),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: (c: Pick<Clip, "id" | "start_ms" | "end_ms" | "note">) =>
      ipc.clips.update(c.id, c.start_ms, c.end_ms, c.note),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: number) => ipc.clips.delete(id),
    onSuccess: invalidate,
  });

  // 片段没有回收站兜底：删除先确认（与删视频/课程一致）。
  async function confirmRemove(clip: Clip) {
    const ok = await confirmDialog(
      `删除片段 ${formatMs(clip.start_ms)} – ${formatMs(clip.end_ms)}？`,
      { title: "删除片段", kind: "warning", okLabel: "删除", cancelLabel: "取消" },
    );
    if (ok) remove.mutate(clip.id);
  }

  function onCapture() {
    if (pendingStart == null) {
      setPendingStart(nowMs());
    } else {
      add.mutate({ start: pendingStart, end: nowMs() });
      setPendingStart(null);
    }
  }

  return (
    <div className="flex h-full flex-col p-3 text-[var(--text-normal)]">
      <div className="flex items-center gap-2">
        <Button
          onClick={onCapture}
          className="h-9"
          title="播放到起点点一下，到终点再点一下"
        >
          {pendingStart == null
            ? "标记起点"
            : `标记终点 · 起 ${formatMs(pendingStart)}`}
        </Button>
        {pendingStart != null && (
          <button
            type="button"
            aria-label="取消标记"
            className="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text-strong)]"
            onClick={() => setPendingStart(null)}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {(add.isError || update.isError || remove.isError) && (
        <ErrorNote
          error={add.error ?? update.error ?? remove.error}
          className="mt-2"
        />
      )}

      <div className="mt-3 min-h-0 flex-1 overflow-auto">
        {clips.length === 0 ? (
          <PanelEmptyState
            icon={<Scissors className="h-7 w-7" />}
            title="还没有收藏的片段"
            description="播放时点「标记起点」，到终点再点「标记终点」，这一段就留在这里。"
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {clips.map((clip) => (
              <li
                key={clip.id}
                className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-2.5"
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="跳转"
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-[var(--text-strong)] hover:bg-[var(--bg-sunken)]"
                    onClick={() => requestSeek(clip.start_ms)}
                  >
                    <Play className="h-3.5 w-3.5" />
                    {formatMs(clip.start_ms)} – {formatMs(clip.end_ms)}
                  </button>
                  <span className="text-xs tabular-nums text-[var(--text-muted)]">
                    {formatMs(Math.max(0, clip.end_ms - clip.start_ms))}
                  </span>
                  <div className="flex-1" />
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]"
                    onClick={() =>
                      update.mutate({
                        id: clip.id,
                        // 夹到终点：播放头越过终点时不产生 start > end 的倒置区间。
                        start_ms: Math.min(nowMs(), clip.end_ms),
                        end_ms: clip.end_ms,
                        note: clip.note,
                      })
                    }
                  >
                    重设起点
                  </button>
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]"
                    onClick={() =>
                      update.mutate({
                        id: clip.id,
                        start_ms: clip.start_ms,
                        end_ms: Math.max(nowMs(), clip.start_ms),
                        note: clip.note,
                      })
                    }
                  >
                    重设终点
                  </button>
                  <button
                    type="button"
                    aria-label="删除片段"
                    className="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--status-err)]"
                    onClick={() => void confirmRemove(clip)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <input
                  aria-label="片段备注"
                  defaultValue={clip.note}
                  placeholder="添加备注…"
                  className="mt-2 w-full rounded-md border border-[var(--border-subtle)] bg-transparent px-2 py-1 text-sm outline-none focus:border-primary/70"
                  onBlur={(e) => {
                    const note = e.target.value;
                    if (note !== clip.note) {
                      update.mutate({
                        id: clip.id,
                        start_ms: clip.start_ms,
                        end_ms: clip.end_ms,
                        note,
                      });
                    }
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
