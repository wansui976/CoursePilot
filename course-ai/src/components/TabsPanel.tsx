import { lazy, Suspense, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
type Tab = (typeof TABS)[number];

function PanelFallback() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-[var(--text-faint)]">
      加载中…
    </div>
  );
}

export function TabsPanel({ videoId }: { videoId: string }) {
  const [activeTab, setActiveTab] = useState<Tab>("AI 概览");

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as Tab)}
      className="flex h-full flex-col bg-[var(--surface-panel)] text-[var(--text-normal)]"
    >
      <TabsList className="flex h-14 items-end justify-around border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-4">
        {TABS.map((tab) => (
          <TabsTrigger
            key={tab}
            value={tab}
            onClick={() => setActiveTab(tab)}
            className="border-b-[3px] border-transparent px-1 pb-3 text-base font-semibold text-[var(--text-muted)] data-[state=active]:border-primary data-[state=active]:text-[var(--text-strong)]"
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
