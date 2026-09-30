import { useState } from "react";
import { queries } from "@/lib/queries";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ListTree } from "lucide-react";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { PanelEmptyState } from "@/components/ui/empty-state";
import { TextSkeleton } from "@/components/ui/skeleton";
import { PanelActions } from "./PanelActions";
import { useStaleArtifacts } from "@/lib/useStaleArtifacts";
import { useAiGeneration } from "@/lib/useAiGeneration";

// 折叠是全局 UI 偏好（与摘要面板一致）：存一个 localStorage 布尔即可。
const COLLAPSE_KEY = "course-ai-chapters-collapsed";

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

export function ChaptersPanel({ videoId }: { videoId: string }) {
  const { t } = useTranslation();
  const requestSeek = usePlayer((s) => s.requestSeek);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const {
    data: chapters = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(queries.chapters(videoId));
  const stale = useStaleArtifacts(videoId);
  const generate = useAiGeneration(videoId, "chapters");

  return (
    // 收回后只剩标题条（shrink-0 + mt-auto 贴底），整块高度让给上方摘要；
    // 展开时才 flex-1 占据下半区。与摘要的分隔线归本面板顶边所有：
    // 展开时线在摘要和章节之间（与原摘要 border-b 同一位置），
    // 收回时线贴着底栏上缘，不再有孤零零浮在中间的线。
    <div
      data-chapters-collapsed={collapsed ? true : undefined}
      className={`relative flex flex-col ${
        collapsed ? "mt-auto shrink-0 border-t border-[var(--border-subtle)]" : "min-h-0 flex-1"
      }`}
    >
      <button
        type="button"
        onClick={() => {
          setCollapsed((c) => {
            saveCollapsed(!c);
            return !c;
          });
        }}
        aria-expanded={!collapsed}
        title={collapsed ? t("chapters.expand") : t("chapters.collapse")}
        className={`ca-touch-44 flex shrink-0 items-center gap-1 px-3 text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-normal)] ${
          collapsed ? "py-2" : "pt-2"
        }`}
      >
        <ChevronDown
          aria-hidden="true"
          className={`h-3.5 w-3.5 transition-transform ${collapsed ? "-rotate-90" : ""}`}
        />
        {t("chapters.keyChapters")}
      </button>
      {!collapsed && (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-12 pt-1">
          {!isError && generate.isError && (
            <ErrorNote
              className="mb-2"
              error={generate.error}
              onRetry={generate.start}
            />
          )}
          {isLoading ? (
            <TextSkeleton lines={4} className="p-0" />
          ) : isError ? (
            <ErrorNote error={error} onRetry={() => void refetch()} />
          ) : chapters.length === 0 ? (
            <PanelEmptyState
              icon={<ListTree className="h-7 w-7" />}
              title={t("chapters.emptyTitle")}
              description={t("chapters.emptyDescription")}
            />
          ) : null}
          {!isError &&
            chapters.map((c) => (
              <button
                key={c.id}
                onClick={() => requestSeek(c.start_ms)}
                className="block w-full rounded px-2 py-2 text-left hover:bg-[var(--surface-card-hover)]"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-xs text-primary">{formatMs(c.start_ms)}</span>
                  <span className="text-sm">{c.title}</span>
                </div>
                {c.summary && (
                  <p className="mt-0.5 text-xs text-[var(--text-faint)]">{c.summary}</p>
                )}
              </button>
            ))}
        </div>
      )}
      {/* 收回成底栏时悬浮按钮会叠在标题条上，与摘要面板同款：收回即隐藏。 */}
      {!collapsed && !isError && (
        <PanelActions
          onRegenerate={generate.start}
          regenerating={generate.isPending}
          hasContent={chapters.length > 0}
          stale={stale.has("chapters")}
        />
      )}
    </div>
  );
}
