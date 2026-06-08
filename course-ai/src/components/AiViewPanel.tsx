import { SummaryPanel } from "./SummaryPanel";
import { ChaptersPanel } from "./ChaptersPanel";

/** 「AI 看」标签页：上半区整体摘要，下半区分段总结（重点章节）。 */
export function AiViewPanel({ videoId }: { videoId: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SummaryPanel videoId={videoId} />
      <ChaptersPanel videoId={videoId} />
    </div>
  );
}
