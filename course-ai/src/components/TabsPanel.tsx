import { lazy, memo, Suspense, useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TextSkeleton } from "@/components/ui/skeleton";
import {
  readVideoResumeState,
  type StudyTab,
  writeVideoResumeState,
} from "@/lib/resumeState";
import { useInlineAsk } from "@/stores/inlineAsk";

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
const SlidesPanel = lazy(() =>
  import("./SlidesPanel").then((m) => ({ default: m.SlidesPanel })),
);
const ClipsPanel = lazy(() =>
  import("./ClipsPanel").then((m) => ({ default: m.ClipsPanel })),
);

// 「学习」标签汇集笔记 + 出题 / 脑图 / 提问 / 搜索等 AI 学习工具。命名为容器义的
// 「学习」而非其中之一「笔记」，既避免与内层「笔记」视图重名，也提示里面不止笔记。
const TABS = ["AI 概览", "学习", "文稿", "课件", "片段"] as const;
type Tab = StudyTab;

function PanelFallback() {
  return <TextSkeleton lines={6} />;
}

export const TabsPanel = memo(function TabsPanel({ videoId }: { videoId: string }) {
  const [activeTab, setActiveTab] = useState<Tab>(
    () => readVideoResumeState(videoId).activeTab ?? "AI 概览",
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

  // 就地追问：用户在文稿里「问 AI」后跳到「学习」标签（提问视图由 NotesPanel 切换）。
  const pendingAsk = useInlineAsk((s) => s.pending);
  useEffect(() => {
    if (pendingAsk) changeTab("学习");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAsk]);

  const panels: { tab: Tab; node: React.ReactNode }[] = [
    { tab: "AI 概览", node: <AiViewPanel videoId={videoId} /> },
    { tab: "学习", node: <NotesPanel videoId={videoId} /> },
    { tab: "文稿", node: <TranscriptPanel videoId={videoId} /> },
    { tab: "课件", node: <SlidesPanel videoId={videoId} /> },
    { tab: "片段", node: <ClipsPanel videoId={videoId} /> },
  ];

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => changeTab(value as Tab)}
      data-study-tab={activeTab}
      className="flex h-full flex-col bg-[var(--surface-panel)] text-[var(--text-normal)]"
    >
      <TabsList className="flex h-12 items-stretch justify-around border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2.5 sm:h-14 sm:px-4">
        {TABS.map((tab) => (
          <TabsTrigger
            key={tab}
            value={tab}
            onClick={() => changeTab(tab)}
            className="ca-touch-44 ca-study-tab-trigger flex min-h-11 flex-1 items-center justify-center border-b-[3px] border-transparent px-3 py-3 text-sm font-semibold text-[var(--text-muted)] transition-colors data-[state=active]:border-primary data-[state=active]:text-[var(--text-strong)] sm:min-h-12 sm:px-4 sm:text-base"
          >
            {tab}
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
});
