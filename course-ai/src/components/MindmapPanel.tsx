import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Transformer } from "markmap-lib";
import { Markmap } from "markmap-view";
import { ipc } from "@/lib/ipc";

const transformer = new Transformer();

export function MindmapPanel({ videoId }: { videoId: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const mmRef = useRef<Markmap | undefined>(undefined);
  const { data: md } = useQuery({
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

  function exportSvg() {
    if (!svgRef.current) return;
    const xml = new XMLSerializer().serializeToString(svgRef.current);
    const blob = new Blob([xml], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mindmap.svg";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (!md) {
    return (
      <p className="p-4 text-sm text-[var(--text-faint)]">
        还没有脑图，点右上角「生成AI脑图」。
      </p>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex justify-end px-2 py-1">
        <button
          className="text-xs text-primary hover:underline"
          onClick={exportSvg}
        >
          导出 SVG
        </button>
      </div>
      <svg ref={svgRef} className="min-h-0 flex-1 w-full" />
    </div>
  );
}
