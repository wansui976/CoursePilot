import { useCallback, useEffect, useRef, useState } from "react";
import { queries } from "@/lib/queries";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Locate, LocateFixed, Mic, GraduationCap } from "lucide-react";
import { useFeynman } from "@/stores/feynman";
import { formatMs } from "@/lib/time";
import { readVideoResumeState, writeVideoResumeState } from "@/lib/resumeState";
import { usePlayer } from "@/stores/player";
import { Modal } from "@/ui/dialog";
import { ErrorNote } from "@/ui/ErrorNote";
import { PanelEmptyState } from "@/ui/empty-state";
import { TextSkeleton } from "@/ui/skeleton";
import { PanelActions, GenerateEmptyAction } from "./PanelActions";
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

// 手动滚动后暂停「跟随播放自动居中」的时长；停手超过该窗口才恢复跟随。
const FOLLOW_PAUSE_MS = 4000;

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
  const [pickerOpen, setPickerOpen] = useState(false);
  const {
    data: chapters = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(queries.chapters(videoId));
  const generate = useAiGeneration(videoId, "chapters");
  // 只订阅「当前落在第几章」：章节切换时才重渲染，而不是跟着 timeupdate 每秒刷几次。
  const activeIndex = usePlayer((s) =>
    s.videoId === videoId ? activeChapterIndex(chapters, s.currentMs) : -1,
  );
  // 「跟随播放」：默认开，当前章节高亮并自动滚到视区中线；手动滚动后暂停一会儿，
  // 也可以直接关掉开关钉住当前位置。与文稿面板的跟随是同一套习惯。
  const [followEnabled, setFollowEnabled] = useState(true);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const userScrollRef = useRef(0);
  // 滚动位置按视频记在本地：切到处理队列再回来时接着看，不用重新找。
  const savedScrollTop = useRef(0);
  const saveTimer = useRef<number | undefined>(undefined);
  const restoredForRef = useRef<string | null>(null);
  const pointerDownRef = useRef(false);
  const hasChapters = chapters.length > 0;

  useEffect(() => {
    // 章节异步加载，等列表真正渲染出来（高度就位）再恢复，否则会被夹回 0。
    if (collapsed || isLoading || !hasChapters) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (restoredForRef.current !== videoId) {
      const saved = readVideoResumeState(videoId).chaptersScrollTop;
      savedScrollTop.current = saved;
      restoredForRef.current = videoId;
      // 恢复了非零位置时把恢复本身视作一次用户定位，
      // 避免紧随其后的跟随立刻把位置抢走（与文稿面板一致）。
      if (saved > 0) userScrollRef.current = Date.now();
    }
    scroller.scrollTop = savedScrollTop.current;
  }, [videoId, collapsed, isLoading, hasChapters]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      // StrictMode（dev）挂载后会立刻跑一次 cleanup：此时章节可能还在加载，
      // savedScrollTop 仍是 0，写回去会把真正的历史位置抹掉。只有真正恢复过才补写。
      if (restoredForRef.current === videoId) {
        writeVideoResumeState(videoId, { chaptersScrollTop: savedScrollTop.current });
      }
    };
  }, [videoId]);

  // 手动滚动（滚轮 / 触摸 / 拖滚动条 / 键盘）打时间戳：其后一小段窗口暂停自动居中。
  // 列表只在展开时挂载，收起/展开后需要重新挂监听。
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const mark = () => {
      userScrollRef.current = Date.now();
    };
    const pointerDown = () => {
      pointerDownRef.current = true;
    };
    const pointerUp = () => {
      pointerDownRef.current = false;
    };
    el.addEventListener("wheel", mark, { passive: true });
    el.addEventListener("touchmove", mark, { passive: true });
    el.addEventListener("pointerdown", pointerDown, { passive: true });
    el.addEventListener("keydown", mark);
    window.addEventListener("pointerup", pointerUp, { passive: true });
    return () => {
      el.removeEventListener("wheel", mark);
      el.removeEventListener("touchmove", mark);
      el.removeEventListener("pointerdown", pointerDown);
      el.removeEventListener("keydown", mark);
      window.removeEventListener("pointerup", pointerUp);
    };
  }, [collapsed, hasChapters]);

  function onScroll() {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (pointerDownRef.current) userScrollRef.current = Date.now();
    savedScrollTop.current = scroller.scrollTop;
    if (saveTimer.current) return;
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = undefined;
      writeVideoResumeState(videoId, { chaptersScrollTop: savedScrollTop.current });
    }, 400);
  }

  // 当前章节滚到视区中线。章节列表很短，不需要文稿那套块级可见性纠偏。
  const centerOnChapter = useCallback((index: number) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const item = scroller.querySelector<HTMLElement>(`[data-chapter-index="${index}"]`);
    if (!item) return;
    const sRect = scroller.getBoundingClientRect();
    const rRect = item.getBoundingClientRect();
    const target = Math.max(
      0,
      scroller.scrollTop + (rRect.top - sRect.top) - (scroller.clientHeight - rRect.height) / 2,
    );
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof scroller.scrollTo === "function") {
      scroller.scrollTo({ top: target, behavior: reduceMotion ? "auto" : "smooth" });
    } else {
      scroller.scrollTop = target;
    }
  }, []);

  useEffect(() => {
    if (!followEnabled || activeIndex < 0) return;
    if (Date.now() - userScrollRef.current < FOLLOW_PAUSE_MS) return;
    centerOnChapter(activeIndex);
  }, [followEnabled, activeIndex, centerOnChapter]);

  // 重新开启跟随：立即回到当前章节，而不是等下一次换章才动。
  function setFollow(next: boolean) {
    setFollowEnabled(next);
    if (next) {
      userScrollRef.current = 0;
      requestAnimationFrame(() => centerOnChapter(activeIndex));
    }
  }

  const explainChapter = (chapter: (typeof chapters)[number]) => {
    setPickerOpen(false);
    useFeynman.getState().open(
      {
        kind: "range",
        video_id: videoId,
        start_ms: chapter.start_ms,
        end_ms: chapter.end_ms,
        title: chapter.title,
      },
      chapter.title,
      videoId,
    );
  };

  return (
    // 收回后只剩标题条（shrink-0 + mt-auto 贴底），整块高度让给上方摘要；
    // 展开时才 flex-1 占据下半区。与摘要的分隔线归本面板顶边所有：
    // 展开时线在摘要和章节之间（与原摘要 border-b 同一位置），
    // 收回时线贴着底栏上缘，不再有孤零零浮在中间的线。
    <div
      data-tour="chapters"
      data-chapters-collapsed={collapsed ? true : undefined}
      className={`relative flex flex-col ${
        collapsed ? "mt-auto shrink-0 border-t border-[var(--border-subtle)]" : "min-h-0 flex-1"
      }`}
    >
      <div className={`flex shrink-0 items-center pr-2 ${collapsed ? "" : "pt-1"}`}>
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
          "py-2"
        }`}
      >
        <ChevronDown
          aria-hidden="true"
          className={`h-3.5 w-3.5 transition-transform ${collapsed ? "-rotate-90" : ""}`}
        />
        {t("chapters.keyChapters")}
      </button>
      {/* 收回成底栏时只留标题，与摘要面板同款。 */}
      {!collapsed && !isError && (
        <PanelActions
          inline
          leading={
            chapters.length > 0 ? (
              <>
                <button
                  type="button"
                  onClick={() => setFollow(!followEnabled)}
                  aria-pressed={followEnabled}
                  title={followEnabled ? t("transcript.followOff") : t("transcript.followOn")}
                  className={`ca-touch-44 inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-xs font-medium transition-colors ${
                    followEnabled
                      ? "text-[var(--accent-text)]"
                      : "text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
                  }`}
                >
                  {followEnabled ? (
                    <LocateFixed className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Locate className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {t("transcript.follow")}
                </button>
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded={pickerOpen}
                  onClick={() => setPickerOpen(true)}
                  title={t("feynman.chapterPickerHint")}
                  // 面板标题行的次要入口：与「重新生成」同一层级，灰阶 + 图标，不用强调色抢主内容。
                  className="ca-touch-44 inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-xs text-[var(--text-muted)] transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
                >
                  <Mic className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("feynman.entryChapters")}
                </button>
              </>
            ) : undefined
          }
          onRegenerate={generate.start}
          regenerating={generate.isPending}
          hasContent={chapters.length > 0}
        />
      )}
      </div>
      {!collapsed && (
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          className="ca-panel-scroll-end min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pt-1"
        >
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
              title={t("chapters.emptyTitle")}
              description={t("chapters.emptyDescription")}
              action={<GenerateEmptyAction onGenerate={generate.start} generating={generate.isPending} />}
            />
          ) : null}
          {!isError && chapters.length > 0 && (
            <ol className="ca-chapter-timeline">
              {chapters.map((c, index) => (
                <li
                  key={c.id}
                  data-chapter-index={index}
                  data-active={index === activeIndex || undefined}
                  data-past={index < activeIndex || undefined}
                >
                  <button
                    type="button"
                    onClick={() => requestSeek(c.start_ms)}
                    aria-current={index === activeIndex ? "true" : undefined}
                    className="ca-chapter"
                  >
                    <span className="ca-chapter-time">{formatMs(c.start_ms)}</span>
                    <span className="ca-chapter-title">{c.title}</span>
                    {c.summary && <span className="ca-chapter-summary ca-prose">{c.summary}</span>}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      <Modal
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title={t("feynman.chapterPickerTitle")}
        icon={<GraduationCap className="h-4 w-4 text-[var(--accent-text)]" />}
        size="md"
      >
        <p className="mt-2 text-sm text-[var(--text-muted)]">{t("feynman.chapterPickerHint")}</p>
        <div className="mt-3 max-h-[60vh] space-y-1 overflow-y-auto">
          {chapters.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => explainChapter(c)}
              className="ca-touch-44 flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-[var(--surface-card-hover)]"
            >
              <span className="ca-tabular flex-none pt-0.5 text-xs text-[var(--text-faint)]">
                {formatMs(c.start_ms)}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-[var(--text-strong)]">{c.title}</span>
                {c.summary && (
                  <span className="mt-0.5 block text-xs leading-relaxed text-[var(--text-muted)]">
                    {c.summary}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}
