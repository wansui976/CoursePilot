import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { renderMarkdown } from "@/lib/renderMarkdown";
import { usePlayer } from "@/stores/player";
import { TextSkeleton } from "@/components/ui/skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { PanelActions } from "./PanelActions";

// 折叠是全局 UI 偏好（非按视频），存一个 localStorage 布尔即可。
const COLLAPSE_KEY = "course-ai-summary-collapsed";

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveCollapsed(value: boolean) {
  try {
    localStorage.setItem(COLLAPSE_KEY, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function SummaryPanel({ videoId }: { videoId: string }) {
  const qc = useQueryClient();
  const requestSeek = usePlayer((s) => s.requestSeek);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const { data: summary, isLoading } = useQuery({
    queryKey: ["summary", videoId],
    queryFn: () => ipc.ai.getSummary(videoId),
  });
  const generate = useMutation({
    mutationFn: () => ipc.ai.generate(videoId, "summary"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["summary", videoId] }),
  });

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      saveCollapsed(next);
      return next;
    });
  }

  // 折叠时只剩标题条、不占 45%，把整块高度让给下方「重点章节」。
  return (
    <div
      className={`relative flex shrink-0 flex-col border-b border-[var(--border-subtle)] ${
        collapsed ? "" : "max-h-[45%]"
      }`}
    >
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        title={collapsed ? "展开整体摘要" : "折叠整体摘要"}
        className="ca-touch-44 flex shrink-0 items-center gap-1 px-3 py-2 text-left text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-normal)]"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${collapsed ? "-rotate-90" : ""}`}
        />
        整体摘要
      </button>
      {!collapsed && (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-12 pt-1">
            {generate.isError && (
              <ErrorNote
                className="mb-2"
                error={generate.error}
                onRetry={() => generate.mutate()}
              />
            )}
            {isLoading ? (
              <TextSkeleton lines={5} className="p-0" />
            ) : summary ? (
              renderMarkdown(summary, requestSeek)
            ) : (
              <p className="text-sm text-[var(--text-faint)]">
                还没有摘要，字幕就绪后会自动生成，也可点右下角生成。
              </p>
            )}
          </div>
          <PanelActions
            onRegenerate={() => generate.mutate()}
            regenerating={generate.isPending}
            hasContent={!!summary}
          />
        </>
      )}
    </div>
  );
}
