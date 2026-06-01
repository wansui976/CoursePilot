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

  if (!md) {
    return (
      <p className="p-4 text-sm text-white/40">
        还没有脑图，点右上角「生成AI脑图」。
      </p>
    );
  }
  return <svg ref={svgRef} className="h-full w-full" />;
}
