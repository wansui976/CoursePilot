import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";

export function TranscriptPanel({ videoId }: { videoId: string }) {
  const { data: segments = [] } = useQuery({
    queryKey: ["transcripts", videoId],
    queryFn: () => ipc.transcripts.list(videoId),
    refetchInterval: (query) =>
      query.state.data && query.state.data.length > 0 ? false : 2000,
  });
  const currentMs = usePlayer((s) => s.currentMs);
  const requestSeek = usePlayer((s) => s.requestSeek);
  const listRef = useRef<HTMLDivElement>(null);
  const [exportMsg, setExportMsg] = useState("");

  async function exportSubs(format: "srt" | "vtt") {
    try {
      const path = await ipc.export.subtitles(videoId, format);
      setExportMsg(`已导出 ${path}`);
    } catch (error) {
      setExportMsg(String(error));
    }
    setTimeout(() => setExportMsg(""), 4000);
  }
  const activeIdx = segments.findIndex(
    (segment) => currentMs >= segment.start_ms && currentMs < segment.end_ms,
  );

  useEffect(() => {
    if (activeIdx < 0) return;
    const element = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${activeIdx}"]`,
    );
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIdx]);

  if (segments.length === 0) {
    return <p className="p-4 text-sm text-white/40">字幕生成中或尚未开始</p>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5 text-xs">
        <span className="text-white/40">导出：</span>
        <button className="text-primary hover:underline" onClick={() => void exportSubs("srt")}>
          SRT
        </button>
        <button className="text-primary hover:underline" onClick={() => void exportSubs("vtt")}>
          VTT
        </button>
        {exportMsg && <span className="ml-2 truncate text-white/40">{exportMsg}</span>}
      </div>
      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto p-3">
      {segments.map((segment, index) => (
        <button
          key={segment.id}
          data-idx={index}
          onClick={() => requestSeek(segment.start_ms)}
          className={`w-full rounded px-2 py-1 text-left text-sm leading-relaxed ${
            index === activeIdx ? "bg-primary/20" : "hover:bg-white/5"
          }`}
        >
          <span className="mr-2 text-xs text-white/40">
            {formatMs(segment.start_ms)}
          </span>
          <span>{segment.text}</span>
        </button>
      ))}
      </div>
    </div>
  );
}
