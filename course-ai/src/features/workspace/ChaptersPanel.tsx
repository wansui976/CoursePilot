import { useState } from "react";
import { queries } from "@/lib/queries";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ListTree } from "lucide-react";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";
import { ErrorNote } from "@/ui/ErrorNote";
import { PanelEmptyState } from "@/ui/empty-state";
import { TextSkeleton } from "@/ui/skeleton";
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

/** 当前播放位置所在章节的下标；还没进入第一章（或没有章节）时为 -1。 */
function activeChapterIndex(chapters: { start_ms: number }[], currentMs: number) {
  let index = -1;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].start_ms <= currentMs) index = i;
    else break;
  }
  return index;
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
  // 只订阅「当前落在第几章」：章节切换时才重渲染，而不是跟着 timeupdate 每秒刷几次。
  const activeIndex = usePlayer((s) =>
    s.videoId === videoId ? activeChapterIndex(chapters, s.currentMs) : -1,
  );

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
          {!isError && chapters.length > 0 && (
            <ol className="ca-chapter-timeline">
              {chapters.map((c, index) => (
                <li
                  key={c.id}
                  data-active={index === activeIndex || undefined}
                  data-past={index < activeIndex || undefined}
                >
                  <button
                    type="button"
                    onClick={() => requestSeek(c.start_ms)}
                    aria-current={index === activeIndex ? "true" : undefined}
                    className="ca-chapter"
                  >
                    <span className="ca-chapter-dot" aria-hidden="true" />
                    <span className="ca-chapter-time">{formatMs(c.start_ms)}</span>
                    <span className="ca-chapter-title">{c.title}</span>
                    {c.summary && <span className="ca-chapter-summary">{c.summary}</span>}
                  </button>
                </li>
              ))}
            </ol>
          )}
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
