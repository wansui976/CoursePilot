import { lazy, Suspense, useState } from "react";
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
const SlidesPanel = lazy(() =>
  import("./SlidesPanel").then((m) => ({ default: m.SlidesPanel })),
);

const TABS = ["AI 概览", "笔记", "文稿", "课件"] as const;
type Tab = StudyTab;

function PanelFallback() {
  return <TextSkeleton lines={6} />;
}

export function TabsPanel({ videoId }: { videoId: string }) {
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

  const panels: { tab: Tab; node: React.ReactNode }[] = [
    { tab: "AI 概览", node: <AiViewPanel videoId={videoId} /> },
    { tab: "笔记", node: <NotesPanel videoId={videoId} /> },
    { tab: "文稿", node: <TranscriptPanel videoId={videoId} /> },
    { tab: "课件", node: <SlidesPanel videoId={videoId} /> },
  ];

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => changeTab(value as Tab)}
      data-study-tab={activeTab}
      className="flex h-full flex-col bg-[var(--surface-panel)] text-[var(--text-normal)]"
    >
      <TabsList className="flex h-12 items-end justify-around border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2.5 sm:h-14 sm:px-4">
        {TABS.map((tab) => (
          <TabsTrigger
            key={tab}
            value={tab}
            onClick={() => changeTab(tab)}
            className="border-b-[3px] border-transparent px-1 pb-3 text-sm font-semibold text-[var(--text-muted)] transition-colors data-[state=active]:border-primary data-[state=active]:text-[var(--text-strong)] sm:text-base"
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
}
