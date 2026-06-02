import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TranscriptPanel } from "./TranscriptPanel";
import { NotesPanel } from "./NotesPanel";
import { AiViewPanel } from "./AiViewPanel";
import { SlidesPanel } from "./SlidesPanel";

const TABS = ["AI 概览", "笔记", "文稿", "课件"] as const;
type Tab = (typeof TABS)[number];

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
        <AiViewPanel videoId={videoId} />
      </TabsContent>
      <TabsContent value="笔记" className="min-h-0 flex-1 overflow-hidden">
        <NotesPanel videoId={videoId} />
      </TabsContent>
      <TabsContent value="文稿" className="min-h-0 flex-1 overflow-hidden">
        <TranscriptPanel videoId={videoId} />
      </TabsContent>
      <TabsContent value="课件" className="min-h-0 flex-1 overflow-hidden">
        <SlidesPanel videoId={videoId} />
      </TabsContent>
    </Tabs>
  );
}
