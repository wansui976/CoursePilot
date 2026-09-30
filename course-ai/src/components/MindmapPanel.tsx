import { useEffect, useRef } from "react";
import { qk } from "@/lib/queryKeys";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Maximize2, Share2, ZoomIn, ZoomOut } from "lucide-react";
import { Transformer } from "markmap-lib";
import { Markmap } from "markmap-view";
import { ipc } from "@/lib/ipc";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { PanelEmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useTheme } from "@/stores/theme";
import { PanelActions } from "./PanelActions";
import { useStaleArtifacts } from "@/lib/useStaleArtifacts";
import { useAiGeneration } from "@/lib/useAiGeneration";

const transformer = new Transformer();

export function MindmapPanel({ videoId }: { videoId: string }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.effective);
  const svgRef = useRef<SVGSVGElement>(null);
  const mmRef = useRef<Markmap | undefined>(undefined);
  const {
    data: md,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: qk.artifact("mindmap", videoId),
    queryFn: () => ipc.ai.getMindmap(videoId),
  });
  const stale = useStaleArtifacts(videoId);
  const generate = useAiGeneration(videoId, "mindmap");

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

  return (
    <div
      className={`relative flex h-full min-h-0 flex-col ${
        theme === "dark" ? "markmap-dark" : ""
      }`}
    >
      {!isError && md && (
        <div className="absolute right-2 top-2 z-10 flex flex-col gap-1">
          {(
            [
              [ZoomIn, t("mindmap.zoomIn"), () => zoom(1.25)],
              [ZoomOut, t("mindmap.zoomOut"), () => zoom(0.8)],
              [Maximize2, t("mindmap.fitWindow"), () => void mmRef.current?.fit()],
            ] as const
          ).map(([Icon, label, onClick]) => (
            <button
              key={label}
              aria-label={label}
              title={label}
              onClick={onClick}
              className="ca-touch-44 grid h-8 w-8 place-items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] text-[var(--text-muted)] shadow-[var(--shadow-raise)] transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      )}
      {!isError && generate.isError && (
        <div className="shrink-0 px-4 pt-4">
        <ErrorNote error={generate.error} onRetry={generate.start} />
        </div>
      )}
      {isLoading && (
        <div className="min-h-0 flex-1 p-4" role="status" aria-label={t("mindmap.loading")}>
          <Skeleton className="h-full min-h-[200px] w-full" />
        </div>
      )}
      {!isLoading && isError && (
        <div className="min-h-0 flex-1 p-4">
          <ErrorNote error={error} onRetry={() => void refetch()} />
        </div>
      )}
      {!isLoading && !isError && !md && (
        <PanelEmptyState
          icon={<Share2 className="h-7 w-7" />}
          title={t("mindmap.emptyTitle")}
          description={t("mindmap.emptyDescription")}
        />
      )}
      {/* svg 常驻，没图时只是藏起来。它一旦卸载再挂回来就是个新节点，而 Markmap 实例
          绑在创建它的那个节点上——沿用旧实例等于往一张已经脱离文档的画布上画，
          点了生成、请求也成功了，画面却还是空的。不卸载，这种状态就不存在。 */}
      <svg
        ref={svgRef}
        aria-hidden={isError || !md}
        className={`min-h-0 w-full flex-1 ${!isError && md ? "" : "hidden"}`}
      />
      {/* 空状态和加载中原先是提前 return 的，绕过了整个外壳——「点右下角生成」
          承诺的那个按钮，恰恰在最需要它的空状态下不存在。 */}
      {!isError && (
        <PanelActions
          onRegenerate={generate.start}
          regenerating={generate.isPending}
          hasContent={!!md}
          stale={stale.has("mindmap")}
        />
      )}
    </div>
  );
}
