import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, X } from "lucide-react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Button } from "@/components/ui/button";
import { ExportMenu } from "./ExportMenu";
import { MathText } from "./MathText";
import { ipc } from "@/lib/ipc";
import { readVideoResumeState, writeVideoResumeState } from "@/lib/resumeState";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";

export function TranscriptPanel({ videoId }: { videoId: string }) {
  const qc = useQueryClient();
  const { data: segments = [] } = useQuery({
    queryKey: ["transcripts", videoId],
    queryFn: () => ipc.transcripts.list(videoId),
    refetchInterval: (query) =>
      query.state.data && query.state.data.length > 0 ? false : 2000,
  });
  const requestSeek = usePlayer((s) => s.requestSeek);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  // 跟随播放的活动行下标。只在「跨段」时更新（见下方订阅），不随每个进度 tick 重渲染。
  const [activeRowIndex, setActiveRowIndex] = useState(-1);

  // 仅渲染非空分段：空段是纠错清空的语气词，原本也不显示（且无法被点开编辑）。
  const rows = useMemo(
    () => segments.filter((segment) => segment.text.trim() !== ""),
    [segments],
  );

  const update = useMutation({
    mutationFn: ({ id, text }: { id: number; text: string }) =>
      ipc.transcripts.update(id, text),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transcripts", videoId] });
      setEditingId(null);
    },
  });

  function startEdit(id: number, text: string) {
    setEditingId(id);
    setDraft(text);
  }
  function save() {
    if (editingId == null) return;
    update.mutate({ id: editingId, text: draft });
  }

  // 跟随播放：订阅进度，只在活动行真正变化时 setState，避免每个 tick 重渲染可见行。
  useEffect(() => {
    const compute = (ms: number) => {
      const idx = rows.findIndex(
        (segment) => ms >= segment.start_ms && ms < segment.end_ms,
      );
      setActiveRowIndex((prev) => (prev === idx ? prev : idx));
    };
    compute(usePlayer.getState().currentMs);
    return usePlayer.subscribe((state) => compute(state.currentMs));
  }, [rows]);

  // 活动行变化时滚到列表中部（编辑时不打扰用户）。虚拟列表用 scrollToIndex 而非 DOM 查询。
  useEffect(() => {
    if (activeRowIndex < 0 || editingId != null) return;
    virtuosoRef.current?.scrollToIndex({
      index: activeRowIndex,
      align: "center",
      behavior: "smooth",
    });
  }, [activeRowIndex, editingId]);

  // 滚动位置恢复：记录顶部可见行下标，节流写入，切走 / 换视频时再补一次。
  const topIndexRef = useRef(readVideoResumeState(videoId).transcriptTopIndex);
  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      writeVideoResumeState(videoId, { transcriptTopIndex: topIndexRef.current });
    };
  }, [videoId]);

  if (segments.length === 0) {
    return <p className="p-4 text-sm text-[var(--text-muted)]">字幕生成中或尚未开始</p>;
  }

  return (
    <div className="flex h-full flex-col text-[var(--text-normal)]">
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 text-xs">
        <span className="text-[var(--text-faint)]">悬停文稿可纠错</span>
        <div className="ml-auto">
          <ExportMenu
            items={[
              { label: "SRT 字幕", run: () => ipc.export.subtitles(videoId, "srt") },
              { label: "VTT 字幕", run: () => ipc.export.subtitles(videoId, "vtt") },
            ]}
          />
        </div>
      </div>
      <Virtuoso
        ref={virtuosoRef}
        aria-label="文稿内容滚动区"
        data={rows}
        className="min-h-0 flex-1"
        // 初次挂载时恢复到上次离开的行（夹在有效范围内）。
        initialTopMostItemIndex={Math.min(
          topIndexRef.current,
          Math.max(0, rows.length - 1),
        )}
        components={{
          Header: () => <div className="h-2" />,
          Footer: () => <div className="h-3" />,
        }}
        rangeChanged={(range) => {
          topIndexRef.current = range.startIndex;
          if (saveTimer.current) return;
          saveTimer.current = window.setTimeout(() => {
            saveTimer.current = undefined;
            writeVideoResumeState(videoId, {
              transcriptTopIndex: topIndexRef.current,
            });
          }, 400);
        }}
        itemContent={(index, segment) => {
          const isEditing = editingId === segment.id;
          if (isEditing) {
            return (
              <div className="ca-transcript-row rounded bg-[var(--surface-card)] mx-3 my-0.5 p-2">
                <textarea
                  aria-label="编辑文稿"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  className="w-full resize-y rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)] outline-none"
                  rows={2}
                />
                <div className="mt-1 flex items-center gap-2 text-xs">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={save}
                    disabled={update.isPending}
                  >
                    <Check className="h-3 w-3" />
                    保存
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingId(null)}
                  >
                    <X className="h-3 w-3" />
                    取消
                  </Button>
                  <span className="text-[var(--text-faint)]">⌘/Ctrl+Enter 保存</span>
                </div>
              </div>
            );
          }
          return (
            <div
              className={`ca-transcript-row group mx-3 my-0.5 flex items-start gap-1 rounded ${
                index === activeRowIndex
                  ? "bg-primary/20"
                  : "hover:bg-[var(--surface-card-hover)]"
              }`}
            >
              <button
                onClick={() => requestSeek(segment.start_ms)}
                className="min-w-0 flex-1 px-2 py-1 text-left text-sm leading-relaxed"
              >
                <span className="mr-2 text-xs text-[var(--text-muted)]">
                  {formatMs(segment.start_ms)}
                </span>
                <span>
                  <MathText text={segment.text} />
                </span>
              </button>
              <button
                aria-label="编辑这句文稿"
                title="纠错"
                onClick={() => startEdit(segment.id, segment.text)}
                className="ca-touch-44 mt-1 mr-1 grid h-6 w-6 shrink-0 place-items-center rounded text-[var(--text-muted)] opacity-0 transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] group-hover:opacity-100"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        }}
      />
    </div>
  );
}
