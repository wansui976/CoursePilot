import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Captions, LayoutGrid, Sparkles, StickyNote } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TextSkeleton } from "@/components/ui/skeleton";
import { ipc } from "@/lib/ipc";
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

// 每个 tab 一个图标：下划线 tab 之间靠图标+文字一起辨识，避免面板窄到只剩图标时迷失。
const TAB_ICONS: Record<Tab, typeof Sparkles> = {
  overview: Sparkles,
  transcript: Captions,
  notes: StickyNote,
  more: LayoutGrid,
};

function PanelFallback() {
  return <TextSkeleton lines={6} />;
}

/** tab 徽标：「更多」显示练习题数（数字，练习已收进更多），概览/笔记有内容显示圆点。
 *  只亮有内容的 tab——空状态不该挨个 tab 点开才知道哪里什么都没有。
 *  独立成组件的原因：徽标查询状态更新只重渲染自己的 span，不带动整个面板
 *  （尤其已保活的文稿/笔记等重面板）重渲染。 */
function TabBadge({ tab, videoId }: { tab: Tab; videoId: string }) {
  const quiz = useQuery({
    queryKey: ["quiz", videoId],
    queryFn: () => ipc.ai.getQuiz(videoId),
    staleTime: 60_000,
  });
  const notes = useQuery({
    queryKey: ["notes", videoId],
    queryFn: () => ipc.ai.getNotes(videoId),
    staleTime: 60_000,
  });
  const summary = useQuery({
    queryKey: ["summary", videoId],
    queryFn: () => ipc.ai.getSummary(videoId),
    staleTime: 60_000,
  });
  const chapters = useQuery({
    queryKey: ["chapters", videoId],
    queryFn: () => ipc.ai.getChapters(videoId),
    staleTime: 60_000,
  });

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

function VideoTabsPanel({ videoId }: { videoId: string }) {
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
      if (!Number.isInteger(digit) || digit < 1 || digit > TAB_KEYS.length) return;
      const tab = TAB_KEYS[digit - 1];
      if (tab) changeTab(tab);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [changeTab]);

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

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => changeTab(value as Tab)}
      data-study-tab={activeTab}
      className="flex h-full flex-col bg-[var(--surface-panel)] text-[var(--text-normal)]"
    >
      {/* 面板拖窄时允许横向滚动；核心任务保持一级可见，低频资料统一收进"更多"。 */}
      <TabsList className="flex h-12 items-stretch overflow-x-auto border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2.5 [scrollbar-width:none] sm:h-14 sm:px-4 [&::-webkit-scrollbar]:hidden">
        {TAB_KEYS.map((tab) => {
          const Icon = TAB_ICONS[tab];
          return (
            <TabsTrigger
              key={tab}
              value={tab}
              onClick={() => changeTab(tab)}
              className="ca-touch-44 ca-study-tab-trigger flex min-h-11 min-w-max flex-1 items-center justify-center gap-1.5 border-b-[3px] border-transparent px-3 py-3 text-sm font-semibold text-[var(--text-muted)] transition-colors data-[state=active]:border-primary data-[state=active]:text-[var(--text-strong)] sm:min-h-12 sm:px-4 sm:text-base"
            >
              <Icon aria-hidden="true" className="h-4 w-4 flex-none" />
              <span>{t(`studyTab.${tab}`)}</span>
              <TabBadge tab={tab} videoId={videoId} />
            </TabsTrigger>
          );
        })}
      </TabsList>
      {panels.map(({ tab, node }) => (
        <TabsContent
          key={tab}
          value={tab}
          // 访问过即常驻：Radix 在非活动时不再卸载，由 data-[state=inactive]:hidden 隐藏。
          forceMount={visited.has(tab) ? true : undefined}
          className="ca-tab-content min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        >
          {visited.has(tab) ? (
            <Suspense fallback={<PanelFallback />}>{node}</Suspense>
          ) : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}

export const TabsPanel = memo(function TabsPanel({ videoId }: { videoId: string }) {
  // videoId 是学习现场的边界。换视频时重建内部状态，重新读取该视频保存的
  // activeTab，同时让 visited 只从当前标签开始，避免上一视频的重面板继续保活。
  return <VideoTabsPanel key={videoId} videoId={videoId} />;
});
