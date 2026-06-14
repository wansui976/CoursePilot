import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, X } from "lucide-react";
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
  const currentMs = usePlayer((s) => s.currentMs);
  const requestSeek = usePlayer((s) => s.requestSeek);
  const listRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

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

  const activeIdx = segments.findIndex(
    (segment) => currentMs >= segment.start_ms && currentMs < segment.end_ms,
  );

  useEffect(() => {
    if (activeIdx < 0 || editingId != null) return;
    const element = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${activeIdx}"]`,
    );
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIdx, editingId]);

  useEffect(() => {
    if (activeIdx >= 0 || !listRef.current) return;
    listRef.current.scrollTop = readVideoResumeState(videoId).transcriptScrollTop;
  }, [activeIdx, segments.length, videoId]);

  function rememberTranscriptScroll() {
    if (!listRef.current) return;
    writeVideoResumeState(videoId, {
      transcriptScrollTop: listRef.current.scrollTop,
    });
  }

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
      <div
        ref={listRef}
        aria-label="文稿内容滚动区"
        className="flex-1 space-y-1 overflow-y-auto p-3"
        onScroll={rememberTranscriptScroll}
      >
        {segments.map((segment, index) => {
          const isEditing = editingId === segment.id;
          // 被纠错清空的分段（整段语气词，如「哎。」）不显示空行；仍保留在库里
          // 以维持「重新纠错」所需的行数对齐。正在编辑的行不隐藏。
          if (!isEditing && !segment.text.trim()) return null;
          if (isEditing) {
            return (
              <div
                key={segment.id}
                data-idx={index}
                className="ca-transcript-row rounded bg-[var(--surface-card)] p-2"
              >
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
              key={segment.id}
              data-idx={index}
              className={`ca-transcript-row group flex items-start gap-1 rounded ${
                index === activeIdx
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
                className="mt-1 mr-1 grid h-6 w-6 shrink-0 place-items-center rounded text-[var(--text-muted)] opacity-0 transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] group-hover:opacity-100"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
