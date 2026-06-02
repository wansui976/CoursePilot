import { SummaryPanel } from "./SummaryPanel";
import { ChaptersPanel } from "./ChaptersPanel";

/** 「AI 看」标签页：上半区整体摘要，下半区分段总结（重点章节）。 */
export function AiViewPanel({ videoId }: { videoId: string }) {
  return (
    <div className="flex h-full flex-col">
      <div className="max-h-[45%] shrink-0 overflow-y-auto border-b border-[var(--border-subtle)]">
        <SummaryPanel videoId={videoId} />
      </div>
      <div className="min-h-0 flex-1">
        <ChaptersPanel videoId={videoId} />
      </div>
    </div>
  );
}
