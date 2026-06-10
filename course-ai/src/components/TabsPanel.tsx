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

  function changeTab(tab: Tab) {
    setActiveTab(tab);
    writeVideoResumeState(videoId, { activeTab: tab });
  }

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => changeTab(value as Tab)}
      className="flex h-full flex-col bg-[var(--surface-panel)] text-[var(--text-normal)]"
    >
      <TabsList className="flex h-12 items-end justify-around border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2.5 sm:h-14 sm:px-4">
        {TABS.map((tab) => (
          <TabsTrigger
            key={tab}
            value={tab}
            onClick={() => changeTab(tab)}
            className="border-b-[3px] border-transparent px-1 pb-3 text-sm font-semibold text-[var(--text-muted)] data-[state=active]:border-primary data-[state=active]:text-[var(--text-strong)] sm:text-base"
          >
            {tab}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="AI 概览" className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<PanelFallback />}>
          <AiViewPanel videoId={videoId} />
        </Suspense>
      </TabsContent>
      <TabsContent value="笔记" className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<PanelFallback />}>
          <NotesPanel videoId={videoId} />
        </Suspense>
      </TabsContent>
      <TabsContent value="文稿" className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<PanelFallback />}>
          <TranscriptPanel videoId={videoId} />
        </Suspense>
      </TabsContent>
      <TabsContent value="课件" className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<PanelFallback />}>
          <SlidesPanel videoId={videoId} />
        </Suspense>
      </TabsContent>
    </Tabs>
  );
}
