import { lazy, memo, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TextSkeleton } from "@/components/ui/skeleton";
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
const QuizPanel = lazy(() =>
  import("./QuizPanel").then((m) => ({ default: m.QuizPanel })),
);
const MoreStudyPanel = lazy(() =>
  import("./MoreStudyPanel").then((m) => ({ default: m.MoreStudyPanel })),
);

const TAB_KEYS: StudyTab[] = ["overview", "transcript", "notes", "quiz", "more"];
type Tab = StudyTab;

function PanelFallback() {
  return <TextSkeleton lines={6} />;
}

function VideoTabsPanel({ videoId }: { videoId: string }) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>(
    () => readVideoResumeState(videoId).activeTab ?? "overview",
  );
  // 保活：记录访问过的标签。访问过的面板用 forceMount 常驻 DOM（非活动时隐藏），
  // 再切回时不必重建重组件（tiptap/markmap）或上千行文稿 DOM —— 切换从此瞬时完成。
  // 未访问过的不渲染，保持懒加载、不拖累首屏。
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set([activeTab]));

  function changeTab(tab: Tab) {
    if (tab !== activeTab && !visited.has(tab)) {
      setVisited((prev) => {
        const next = new Set(prev);
        next.add(tab);
        return next;
      });
    }
    setActiveTab(tab);
    writeVideoResumeState(videoId, { activeTab: tab });
  }

  const panels: { tab: Tab; node: React.ReactNode }[] = [
    { tab: "overview", node: <AiViewPanel videoId={videoId} /> },
    { tab: "transcript", node: <TranscriptPanel videoId={videoId} /> },
    { tab: "notes", node: <NotesPanel videoId={videoId} /> },
    { tab: "quiz", node: <QuizPanel videoId={videoId} /> },
    { tab: "more", node: <MoreStudyPanel videoId={videoId} /> },
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
        {TAB_KEYS.map((tab) => (
          <TabsTrigger
            key={tab}
            value={tab}
            onClick={() => changeTab(tab)}
            className="ca-touch-44 ca-study-tab-trigger flex min-h-11 min-w-max flex-1 items-center justify-center border-b-[3px] border-transparent px-3 py-3 text-sm font-semibold text-[var(--text-muted)] transition-colors data-[state=active]:border-primary data-[state=active]:text-[var(--text-strong)] sm:min-h-12 sm:px-4 sm:text-base"
          >
            {t(`studyTab.${tab}`)}
          </TabsTrigger>
        ))}
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
