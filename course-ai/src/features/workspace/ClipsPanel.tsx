import { useEffect, useMemo, useRef, useState } from "react";
import { qk } from "@/lib/queryKeys";
import { useTranslation } from "react-i18next";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { Play, Scissors, Trash2, X } from "lucide-react";
import { Button } from "@/ui/button";
import { PanelEmptyState } from "@/ui/empty-state";
import { ErrorNote } from "@/ui/ErrorNote";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import type { Clip } from "@/lib/types";
import { usePlayer } from "@/stores/player";

const CLIP_NOTE_MUTATION_KEY = ["clips", "note"] as const;
const CLIP_NOTE_MUTATION_SCOPE = { id: "clip-note-updates" } as const;

type NoteMutationSnapshot = {
  mutationId: number;
  status: "idle" | "pending" | "error" | "success";
  error: unknown;
  variables: Clip | undefined;
};

function noteKey(clip: Pick<Clip, "video_id" | "id">) {
  return `${clip.video_id}:${clip.id}`;
}

function noteMutationKey(clip: Pick<Clip, "video_id" | "id">) {
  return [...CLIP_NOTE_MUTATION_KEY, clip.video_id, clip.id] as const;
}

export function ClipsPanel({ videoId }: { videoId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const requestSeek = usePlayer((s) => s.requestSeek);
  // 懒读播放进度（不订阅，避免每秒重渲染）。
  const nowMs = () => Math.floor(usePlayer.getState().currentMs);
  // 起点标记连同 videoId 一起存：组件被 TabsPanel 保活，换视频只变 prop 不重挂，
  // 别的视频里标的起点在当前视频必须视为不存在，否则会拼出跨视频的错误片段。
  const [pending, setPending] = useState<{ videoId: string; ms: number } | null>(
    null,
  );
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const noteDraftsRef = useRef<Record<string, string>>({});
  const submittedNotesRef = useRef(new Map<string, string>());
  const clipsByVideoRef = useRef(new Map<string, Clip[]>());
  const flushVideoNotesRef = useRef<(targetVideoId: string) => void>(() => {});
  const pendingStart = pending?.videoId === videoId ? pending.ms : null;
  const setPendingStart = (ms: number | null) =>
    setPending(ms == null ? null : { videoId, ms });

  const {
    data: clips = [],
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: qk.clips(videoId),
    queryFn: () => ipc.clips.list(videoId),
  });

  const noteMutationSnapshots = useMutationState({
    filters: { mutationKey: CLIP_NOTE_MUTATION_KEY },
    select: (mutation) => ({
      mutationId: mutation.mutationId,
      status: mutation.state.status,
      error: mutation.state.error,
      variables: mutation.state.variables as Clip | undefined,
    }),
  });
  const latestNoteMutations = useMemo(() => {
    const latest = new Map<string, NoteMutationSnapshot>();
    for (const snapshot of noteMutationSnapshots) {
      if (!snapshot.variables) continue;
      const key = noteKey(snapshot.variables);
      const previous = latest.get(key);
      if (!previous || snapshot.mutationId > previous.mutationId) latest.set(key, snapshot);
    }
    return latest;
  }, [noteMutationSnapshots]);
  const latestNoteMutationsRef = useRef(latestNoteMutations);
  latestNoteMutationsRef.current = latestNoteMutations;

  useEffect(() => {
    clipsByVideoRef.current.set(videoId, clips);
  }, [clips, videoId]);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: qk.clips(videoId) });

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
      t("clips.deleteConfirm", { range: `${formatMs(clip.start_ms)} – ${formatMs(clip.end_ms)}` }),
      { title: t("clips.deleteTitle"), kind: "warning", okLabel: t("clips.delete"), cancelLabel: t("clips.cancel") },
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

  function commitNote(clip: Clip) {
    const mutationCache = qc.getMutationCache();
    // 每个片段只保留当前有用的任务；进行中的旧写入保留并由 scope 串行，避免旧值后到覆盖新值。
    for (const existing of mutationCache.findAll({
      mutationKey: noteMutationKey(clip),
      exact: true,
    })) {
      if (existing.state.status !== "pending") mutationCache.remove(existing);
    }

    const mutation = mutationCache.build(qc, {
      mutationKey: noteMutationKey(clip),
      scope: CLIP_NOTE_MUTATION_SCOPE,
      // 失败草稿在本次应用会话内必须可恢复，不能因面板卸载后的默认 GC 消失。
      gcTime: Infinity,
      mutationFn: (nextClip: Clip) =>
        ipc.clips.update(nextClip.id, nextClip.start_ms, nextClip.end_ms, nextClip.note),
      onSuccess: (_data, savedClip) => {
        // 查询失效后的首个响应可能仍是旧快照；先把已提交值写入缓存，避免输入闪回。
        qc.setQueryData<Clip[]>(["clips", savedClip.video_id], (current) =>
          current?.map((item) =>
            item.id === savedClip.id ? { ...item, note: savedClip.note } : item,
          ),
        );
        void qc.invalidateQueries({ queryKey: qk.clips(savedClip.video_id) });
      },
      onError: (_error, failedClip) => {
        const key = noteKey(failedClip);
        if (submittedNotesRef.current.get(key) === failedClip.note) {
          submittedNotesRef.current.delete(key);
        }
      },
    });
    void mutation.execute(clip).catch(() => undefined);
  }

  function saveNote(clip: Clip, note: string, retry = false) {
    const key = noteKey(clip);
    const latest = latestNoteMutationsRef.current.get(key);
    if (!retry) {
      // 同一内容已在排队、已保存或已显示失败时，blur/卸载清理不再重复写入。
      if (latest?.variables?.note === note || submittedNotesRef.current.get(key) === note) return;
      const confirmedNote = latest?.status === "success" ? latest.variables?.note : clip.note;
      // pending 时若用户又修改了内容，即使新值等于最初值也要排在旧写入之后。
      if (latest?.status !== "pending" && note === confirmedNote) return;
    }
    submittedNotesRef.current.set(key, note);
    commitNote({ ...clip, note });
  }

  flushVideoNotesRef.current = (targetVideoId) => {
    for (const clip of clipsByVideoRef.current.get(targetVideoId) ?? []) {
      const draft = noteDraftsRef.current[noteKey(clip)];
      if (draft !== undefined) saveNote(clip, draft);
    }
  };

  useEffect(
    () => () => {
      flushVideoNotesRef.current(videoId);
    },
    [videoId],
  );

  return (
    <div className="flex h-full flex-col p-3 text-[var(--text-normal)]">
      {!isError && (
        <div className="flex items-center gap-2">
          <Button
            onClick={onCapture}
            className="h-9"
            title={t("clips.markStartTitle")}
          >
            {pendingStart == null
              ? t("clips.markStart")
              : t("clips.markEnd", { time: formatMs(pendingStart) })}
          </Button>
          {pendingStart != null && (
            <button
              type="button"
              aria-label={t("clips.cancelMark")}
              className="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text-strong)]"
              onClick={() => setPendingStart(null)}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {(add.isError || update.isError || remove.isError) && (
        <ErrorNote
          error={add.error ?? update.error ?? remove.error}
          className="mt-2"
        />
      )}

      <div className="mt-3 min-h-0 flex-1 overflow-auto">
        {isError ? (
          <ErrorNote error={error} onRetry={() => void refetch()} />
        ) : clips.length === 0 ? (
          <PanelEmptyState
            icon={<Scissors className="h-7 w-7" />}
            title={t("clips.emptyTitle")}
            description={t("clips.emptyDescription")}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {clips.map((clip) => {
              const draftKey = noteKey(clip);
              const noteMutation = latestNoteMutations.get(draftKey);
              const note = noteDrafts[draftKey] ?? noteMutation?.variables?.note ?? clip.note;
              const savedNote =
                noteMutation?.status === "success" || noteMutation?.status === "pending"
                  ? noteMutation.variables?.note ?? clip.note
                  : clip.note;
              const dirty = note !== savedNote;
              const notePending = noteMutation?.status === "pending";
              const noteError = noteMutation?.status === "error";
              return (
                <li
                  key={clip.id}
                  className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-2.5"
                >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={t("clips.jump")}
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
                        note,
                      })
                    }
                  >
                    {t("clips.resetStart")}
                  </button>
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]"
                    onClick={() =>
                      update.mutate({
                        id: clip.id,
                        start_ms: clip.start_ms,
                        end_ms: Math.max(nowMs(), clip.start_ms),
                        note,
                      })
                    }
                  >
                    {t("clips.resetEnd")}
                  </button>
                  <button
                    type="button"
                    aria-label={t("clips.deleteClip")}
                    className="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--status-err)]"
                    onClick={() => void confirmRemove(clip)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div
                  data-system-back-layer={dirty || notePending ? "" : undefined}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape" || (!dirty && !notePending)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (dirty) saveNote(clip, note);
                  }}
                  className="mt-2"
                >
                  <input
                    aria-label={t("clips.clipNote")}
                    value={note}
                    placeholder={t("clips.addNote")}
                    className="w-full rounded-md border border-[var(--border-subtle)] bg-transparent px-2 py-1 text-sm outline-none focus:border-[var(--focus-ring)]"
                    onChange={(event) => {
                      const nextNote = event.target.value;
                      noteDraftsRef.current[draftKey] = nextNote;
                      setNoteDrafts((current) => ({
                        ...current,
                        [draftKey]: nextNote,
                      }));
                    }}
                    onBlur={() => saveNote(clip, note)}
                  />
                  {(dirty || notePending) && !noteError && (
                    <span
                      role="status"
                      aria-live="polite"
                      className="mt-1 block ca-t-2xs text-[var(--text-faint)]"
                    >
                      {notePending ? t("clips.saving") : t("clips.unsaved")}
                    </span>
                  )}
                  {noteError && (
                    <ErrorNote
                      className="mt-1"
                      error={noteMutation?.error}
                      onRetry={() => saveNote(clip, note, true)}
                    />
                  )}
                </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
