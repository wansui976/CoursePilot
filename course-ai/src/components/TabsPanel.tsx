import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TranscriptPanel } from "./TranscriptPanel";
import { NotesPanel } from "./NotesPanel";
import { ChaptersPanel } from "./ChaptersPanel";
import { SlidesPanel } from "./SlidesPanel";

const TABS = ["视频", "笔记", "AI看", "课件", "文稿"] as const;

export function TabsPanel({ videoId }: { videoId: string }) {
  return (
    <Tabs defaultValue="文稿" className="flex h-full flex-col">
      <TabsList className="flex gap-4 border-b border-white/10 bg-transparent px-3">
        {TABS.map((tab) => (
          <TabsTrigger
            key={tab}
            value={tab}
            className="border-b-2 border-transparent py-2 text-sm text-white/50 data-[state=active]:border-primary data-[state=active]:text-primary"
          >
            {tab}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="视频" className="p-4 text-white/40">
        基础信息
      </TabsContent>
      <TabsContent value="笔记" className="flex-1 overflow-hidden">
        <NotesPanel videoId={videoId} />
      </TabsContent>
      <TabsContent value="AI看" className="flex-1 overflow-hidden">
        <ChaptersPanel videoId={videoId} />
      </TabsContent>
      <TabsContent value="课件" className="flex-1 overflow-hidden">
        <SlidesPanel videoId={videoId} />
      </TabsContent>
      <TabsContent value="文稿" className="flex-1 overflow-hidden">
        <TranscriptPanel videoId={videoId} />
      </TabsContent>
    </Tabs>
  );
}
