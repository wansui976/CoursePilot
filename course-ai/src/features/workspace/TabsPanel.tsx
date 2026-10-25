import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useContainerPixelWidth } from "@/lib/useContainerWidth";
import { SPLIT_NOTES_MIN_WIDTH } from "./workbenchLayout";
import { queries } from "@/lib/queries";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { TextSkeleton } from "@/ui/skeleton";
import { useNoteCapture } from "@/stores/noteCapture";
import {
  readVideoResumeState,
  type StudyTab,
  writeVideoResumeState,
} from "@/lib/resumeState";

// 重组件（tiptap / markmap / katex）按需懒加载，缩小首屏主包体积。
const AiViewPanel = lazy(() =>
  import("./AiViewPanel").then((m) => ({ default: m.AiViewPanel })),
);
const NotesPanel = lazy(() =>
  import("./NotesPanel").then((m) => ({ default: m.NotesPanel })),
);
const TranscriptPanel = lazy(() =>
  import("./TranscriptPanel").then((m) => ({ default: m.TranscriptPanel })),
);
const MoreStudyPanel = lazy(() =>
  import("./MoreStudyPanel").then((m) => ({ default: m.MoreStudyPanel })),
);

// 练习收进「更多」后只剩 4 个一级 tab：面板拖到最窄（384px）也能全部放下，
// 「更多」不会再被挤出可视区。StudyTab 里的 "quiz" 只作为存量存储值被迁移读取。
const TAB_KEYS: Exclude<StudyTab, "quiz">[] = [
  "overview",
  "transcript",
  "notes",
  "more",
];
type Tab = Exclude<StudyTab, "quiz">;


function PanelFallback() {
  return <TextSkeleton lines={6} />;
}

/** tab 徽标：「更多」显示练习题数（数字，练习已收进更多），概览/笔记有内容显示圆点。
 *  只亮有内容的 tab——空状态不该挨个 tab 点开才知道哪里什么都没有。
 *  独立成组件的原因：徽标查询状态更新只重渲染自己的 span，不带动整个面板
 *  （尤其已保活的文稿/笔记等重面板）重渲染。 */
function TabBadge({ tab, videoId }: { tab: Tab; videoId: string }) {
  const quiz = useQuery({ ...queries.quiz(videoId), staleTime: 60_000 });
  const notes = useQuery({ ...queries.notes(videoId), staleTime: 60_000 });
  const summary = useQuery({ ...queries.summary(videoId), staleTime: 60_000 });
  const chapters = useQuery({ ...queries.chapters(videoId), staleTime: 60_000 });

  // 徽标只数有效题：与 QuizPanel 的 sanitize 同口径的轻量近似（stem 非空即可）。
  const quizCount = useMemo(() => {
    if (tab !== "more") return 0;
    const raw = quiz.data;
    if (!raw) return 0;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return 0;
      return parsed.filter(
        (item) =>
          item != null &&
          typeof item.stem === "string" &&
          item.stem.trim() !== "",
      ).length;
    } catch {
      return 0;
    }
  }, [tab, quiz.data]);

  if (tab === "more" && quizCount > 0) {
    const shown = quizCount > 999 ? "999+" : String(quizCount);
    return (
      <span className="ml-1 rounded-full bg-[var(--surface-card-active)] px-1.5 py-px ca-t-2xs font-semibold leading-4 tabular-nums text-[var(--accent-text)]">
        {shown}
      </span>
    );
  }
  if (tab === "overview" && (Boolean(summary.data) || (chapters.data?.length ?? 0) > 0)) {
    return <span aria-hidden="true" className="ml-1 h-1.5 w-1.5 rounded-full bg-[var(--accent-text)]" />;
  }
  if (tab === "notes" && Boolean(notes.data?.trim())) {
    return <span aria-hidden="true" className="ml-1 h-1.5 w-1.5 rounded-full bg-[var(--accent-text)]" />;
  }
  return null;
}

function VideoTabsPanel({ videoId, split }: { videoId: string; split: boolean }) {
  const { t } = useTranslation();
  // 存量恢复：练习已并入「更多」，读到旧值 "quiz" 时落到更多并直接定位练习视图。
  const [restored] = useState(() => readVideoResumeState(videoId));
  const [activeTab, setActiveTab] = useState<Tab>(() =>
    restored.activeTab === "quiz"
      ? "more"
      : (restored.activeTab as Tab | null) ?? "overview",
  );
  const restoredQuizView = restored.activeTab === "quiz";
  // 保活：记录访问过的标签。访问过的面板用 forceMount 常驻 DOM（非活动时隐藏），
  // 再切回时不必重建重组件（tiptap/markmap）或上千行文稿 DOM —— 切换从此瞬时完成。
  // 未访问过的不渲染，保持懒加载、不拖累首屏。
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set([activeTab]));
  // 分栏时笔记在右边常驻，不再是一个标签；记住的标签若是笔记，左边先显示概览。
  const tabKeys = useMemo(
    () => (split ? TAB_KEYS.filter((tab) => tab !== "notes") : TAB_KEYS),
    [split],
  );
  const shownTab: Tab = split && activeTab === "notes" ? "overview" : activeTab;

  const changeTab = useCallback(
    (tab: Tab) => {
      setVisited((prev) => {
        if (prev.has(tab)) return prev;
        const next = new Set(prev);
        next.add(tab);
        return next;
      });
      setActiveTab(tab);
      writeVideoResumeState(videoId, { activeTab: tab });
    },
    [videoId],
  );

  // 「记一笔」：切到笔记（分栏时笔记本来就常驻在右边，不用切）。
  useEffect(
    () =>
      useNoteCapture.subscribe((state, previous) => {
        const request = state.request;
        if (!request || request === previous.request || request.videoId !== videoId) return;
        if (!split) changeTab("notes");
      }),
    [videoId, split, changeTab],
  );

  // 数字键 1-4 直接切 tab（播放器快捷键不占数字键，无冲突）。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        typeof target.closest === "function" &&
        target.closest("input, textarea, select, [contenteditable]")
      ) {
        return;
      }
      const digit = Number(event.key);
      if (!Number.isInteger(digit) || digit < 1 || digit > tabKeys.length) return;
      const tab = tabKeys[digit - 1];
      if (tab) changeTab(tab);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [changeTab, tabKeys]);

  const panels: { tab: Tab; node: React.ReactNode }[] = [
    { tab: "overview", node: <AiViewPanel videoId={videoId} /> },
    { tab: "transcript", node: <TranscriptPanel videoId={videoId} /> },
    { tab: "notes", node: <NotesPanel videoId={videoId} /> },
    {
      tab: "more",
      node: (
        <MoreStudyPanel
          videoId={videoId}
          initialView={restoredQuizView ? "quiz" : undefined}
        />
      ),
    },
  ];

  const tabs = (
    <Tabs
      value={shownTab}
      onValueChange={(value) => changeTab(value as Tab)}
      data-study-tab={shownTab}
      className="flex h-full flex-col bg-[var(--surface-panel)] text-[var(--text-normal)]"
    >
      {/* 分段控件：macOS 式凹槽轨道 + 选中丸，取代下划线 tab。面板拖窄时轨道横向
          滚动；核心任务保持一级可见，低频资料统一收进「更多」。 */}
      <TabsList className="ca-study-tabs-band block">
        <div className="ca-study-tabs">
          {tabKeys.map((tab) => {
            return (
              <TabsTrigger
                key={tab}
                value={tab}
                onClick={() => changeTab(tab)}
                className="ca-study-tab ca-touch-44"
              >
                <span>{t(`studyTab.${tab}`)}</span>
                <TabBadge tab={tab} videoId={videoId} />
              </TabsTrigger>
            );
          })}
        </div>
      </TabsList>
      {panels
        .filter(({ tab }) => tabKeys.includes(tab))
        .map(({ tab, node }) => {
          const mounted = visited.has(tab) || tab === shownTab;
          return (
            <TabsContent
              key={tab}
              value={tab}
              // 访问过即常驻：Radix 在非活动时不再卸载，由 data-[state=inactive]:hidden 隐藏。
              forceMount={mounted ? true : undefined}
              className="ca-tab-content min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
            >
              {mounted ? <Suspense fallback={<PanelFallback />}>{node}</Suspense> : null}
            </TabsContent>
          );
        })}
    </Tabs>
  );

  if (!split) return tabs;
  return (
    <div className="ca-study-split">
      {tabs}
      <section aria-label={t("studyTab.notes")} className="ca-study-split-notes">
        {/* 与左边标签条同一套结构（同高同底色），只有一个常亮的「笔记」。 */}
        <div className="ca-study-tabs-band">
          <div className="ca-study-tabs">
            <span className="ca-study-tab ca-touch-44" data-state="active">
              <span>{t("studyTab.notes")}</span>
              <TabBadge tab="notes" videoId={videoId} />
            </span>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <Suspense fallback={<PanelFallback />}>
            <NotesPanel videoId={videoId} />
          </Suspense>
        </div>
      </section>
    </div>
  );
}

export const TabsPanel = memo(function TabsPanel({
  videoId,
  allowSplit = false,
}: {
  videoId: string;
  /** 布局允许分栏（播放器不与面板并排）；真正分不分，看面板自身是否够宽。 */
  allowSplit?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useContainerPixelWidth(rootRef);
  const split = allowSplit && width >= SPLIT_NOTES_MIN_WIDTH;
  // videoId 是学习现场的边界。换视频时重建内部状态，重新读取该视频保存的
  // activeTab，同时让 visited 只从当前标签开始，避免上一视频的重面板继续保活。
  return (
    <div ref={rootRef} className="h-full min-h-0">
      <VideoTabsPanel key={videoId} videoId={videoId} split={split} />
    </div>
  );
});
