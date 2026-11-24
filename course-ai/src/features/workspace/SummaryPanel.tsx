import { useEffect, useRef, useState } from "react";
import { queries } from "@/lib/queries";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { renderMarkdown } from "@/lib/renderMarkdown";
import { readVideoResumeState, writeVideoResumeState } from "@/lib/resumeState";
import { usePlayer } from "@/stores/player";
import { TextSkeleton } from "@/ui/skeleton";
import { PanelEmptyState } from "@/ui/empty-state";
import { ErrorNote } from "@/ui/ErrorNote";
import { PanelActions, GenerateEmptyAction } from "./PanelActions";
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
  const generate = useAiGeneration(videoId, "summary");
  // 概览滚到哪儿记在本地：切到处理队列再回来、或收起再展开时都能接着看，
  // 不用重新往下找。滚动时节流写入（400ms），卸载时补最后一次。
  const scrollerRef = useRef<HTMLDivElement>(null);
  const savedScrollTop = useRef(0);
  const saveTimer = useRef<number | undefined>(undefined);
  const restoredForRef = useRef<string | null>(null);

  useEffect(() => {
    // 摘要异步加载，等正文真正渲染出来（高度就位）再恢复，否则会被夹回 0。
    if (collapsed || isLoading) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (restoredForRef.current !== videoId) {
      savedScrollTop.current = readVideoResumeState(videoId).summaryScrollTop;
      restoredForRef.current = videoId;
    }
    scroller.scrollTop = savedScrollTop.current;
  }, [videoId, collapsed, isLoading, summary]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      // StrictMode（dev）挂载后会立刻跑一次 cleanup：此时摘要可能还在加载，
      // savedScrollTop 仍是 0，写回去会把真正的历史位置抹掉。只有真正恢复过才补写。
      if (restoredForRef.current === videoId) {
        writeVideoResumeState(videoId, { summaryScrollTop: savedScrollTop.current });
      }
    };
  }, [videoId]);

  function onScroll() {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    savedScrollTop.current = scroller.scrollTop;
    if (saveTimer.current) return;
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = undefined;
      writeVideoResumeState(videoId, { summaryScrollTop: savedScrollTop.current });
    }, 400);
  }

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
      <div className="flex shrink-0 items-center pr-2">
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
      {!collapsed && !isError && (
        <PanelActions
          inline
          onRegenerate={generate.start}
          regenerating={generate.isPending}
          hasContent={!!summary}
        />
      )}
      </div>
      {collapsed && isError && (
        <div className="px-3 pb-3">
          <ErrorNote error={error} onRetry={() => void refetch()} />
        </div>
      )}
      {!collapsed && (
        <>
          <div
            ref={scrollerRef}
            onScroll={onScroll}
            className="ca-panel-scroll-end min-h-0 flex-1 overflow-y-auto px-3 pt-1"
          >
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
              <div className="ca-reading ca-reading-measure">{renderMarkdown(summary, requestSeek)}</div>
            ) : (
              <PanelEmptyState
                title={t("summary.emptyTitle")}
                description={t("summary.emptyDescription")}
                action={<GenerateEmptyAction onGenerate={generate.start} generating={generate.isPending} />}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
