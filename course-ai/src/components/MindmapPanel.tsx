import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { Transformer } from "markmap-lib";
import { Markmap } from "markmap-view";
import { ipc } from "@/lib/ipc";
import { Skeleton } from "@/components/ui/skeleton";

const transformer = new Transformer();

export function MindmapPanel({ videoId }: { videoId: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const mmRef = useRef<Markmap | undefined>(undefined);
  const { data: md, isLoading } = useQuery({
    queryKey: ["mindmap", videoId],
    queryFn: () => ipc.ai.getMindmap(videoId),
  });

  useEffect(() => {
    if (!svgRef.current || !md) return;
    if (!mmRef.current) {
      mmRef.current = Markmap.create(svgRef.current);
    }
    const { root } = transformer.transform(md);
    mmRef.current.setData(root);
    void mmRef.current.fit();
  }, [md]);

  function zoom(scale: number) {
    void mmRef.current?.rescale(scale);
  }

  if (isLoading) {
    return (
      <div className="h-full p-4" role="status" aria-label="加载中…">
        <Skeleton className="h-full min-h-[200px] w-full" />
      </div>
    );
  }
  if (!md) {
    return (
      <p className="p-4 text-sm text-[var(--text-faint)]">
        还没有脑图，字幕就绪后会自动生成，也可点右下角重新生成。
      </p>
    );
  }
  return (
    <div className="relative flex h-full flex-col">
      <div className="absolute right-2 top-2 z-10 flex flex-col gap-1">
        {(
          [
            [ZoomIn, "放大", () => zoom(1.25)],
            [ZoomOut, "缩小", () => zoom(0.8)],
            [Maximize2, "适应窗口", () => void mmRef.current?.fit()],
          ] as const
        ).map(([Icon, label, onClick]) => (
          <button
            key={label}
            aria-label={label}
            title={label}
            onClick={onClick}
            className="grid h-8 w-8 place-items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] text-[var(--text-muted)] shadow-sm transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>
      <svg ref={svgRef} className="min-h-0 flex-1 w-full" />
    </div>
  );
}
