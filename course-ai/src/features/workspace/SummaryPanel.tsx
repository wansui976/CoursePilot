import { useState } from "react";
import { queries } from "@/lib/queries";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, FileText } from "lucide-react";
import { renderMarkdown } from "@/lib/renderMarkdown";
import { usePlayer } from "@/stores/player";
import { TextSkeleton } from "@/ui/skeleton";
import { PanelEmptyState } from "@/ui/empty-state";
import { ErrorNote } from "@/ui/ErrorNote";
import { PanelActions } from "./PanelActions";
import { useStaleArtifacts } from "@/lib/useStaleArtifacts";
import { useAiGeneration } from "@/lib/useAiGeneration";

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
  const { t } = useTranslation();
  const requestSeek = usePlayer((s) => s.requestSeek);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const {
    data: summary,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(queries.summary(videoId));
  const stale = useStaleArtifacts(videoId);
  const generate = useAiGeneration(videoId, "summary");

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      saveCollapsed(next);
      return next;
    });
  }

  // 折叠时只剩标题条，把整块高度让给下方「重点章节」。
  // ca-summary-panel 的尺寸/分隔线规则在 globals.css：默认最多占 45%；
  // 章节收回贴底时（:has 命中）摘要填满底栏以上全部空间，底边线摘掉（线随章节栏走）。
  return (
    <div
      data-summary-collapsed={collapsed ? true : undefined}
      className="ca-summary-panel"
    >
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        title={collapsed ? t("summary.expandTitle") : t("summary.collapseTitle")}
        className="ca-touch-44 flex shrink-0 items-center gap-1 px-3 py-2 text-left text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-normal)]"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${collapsed ? "-rotate-90" : ""}`}
        />
        {t("summary.title")}
      </button>
      {collapsed && isError && (
        <div className="px-3 pb-3">
          <ErrorNote error={error} onRetry={() => void refetch()} />
        </div>
      )}
      {!collapsed && (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-12 pt-1">
            {!isError && generate.isError && (
              <ErrorNote
                className="mb-2"
                error={generate.error}
                onRetry={generate.start}
              />
            )}
            {isLoading ? (
              <TextSkeleton lines={5} className="p-0" />
            ) : isError ? (
              <ErrorNote error={error} onRetry={() => void refetch()} />
            ) : summary ? (
              renderMarkdown(summary, requestSeek)
            ) : (
              <PanelEmptyState
                icon={<FileText className="h-7 w-7" />}
                title={t("summary.emptyTitle")}
                description={t("summary.emptyDescription")}
              />
            )}
          </div>
          {!isError && (
            <PanelActions
              onRegenerate={generate.start}
              regenerating={generate.isPending}
              hasContent={!!summary}
              stale={stale.has("summary")}
            />
          )}
        </>
      )}
    </div>
  );
}
