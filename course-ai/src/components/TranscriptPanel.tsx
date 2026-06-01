import { useEffect, useRef } from "react";
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
    <div ref={listRef} className="h-full space-y-2 overflow-y-auto p-3">
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
  );
}
