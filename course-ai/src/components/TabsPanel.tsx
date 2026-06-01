import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TranscriptPanel } from "./TranscriptPanel";
import { NotesPanel } from "./NotesPanel";
import { ChaptersPanel } from "./ChaptersPanel";
import { SlidesPanel } from "./SlidesPanel";

const TABS = ["视频", "笔记", "AI看", "课件", "文稿"] as const;

export function TabsPanel({ videoId }: { videoId: string }) {
  return (
    <Tabs defaultValue="文稿" className="flex h-full flex-col bg-[#171717]">
      <TabsList className="flex h-16 items-end justify-around border-b border-white/8 bg-[#171717] px-4">
        {TABS.map((tab) => (
          <TabsTrigger
            key={tab}
            value={tab}
            className="border-b-[3px] border-transparent px-1 pb-3 text-base font-semibold text-white/45 data-[state=active]:border-primary data-[state=active]:text-white"
          >
            {tab}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="视频" className="min-h-0 flex-1 overflow-y-auto p-5 text-white/70">
        <div className="space-y-4">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-white/30">Overview</p>
            <h3 className="mt-2 text-xl font-semibold text-white">视频学习区</h3>
          </div>
          <div className="rounded-lg border border-white/8 bg-white/[0.04] p-4 text-sm leading-relaxed">
            导入视频后，先点击“开始处理”生成字幕；随后可以在文稿、AI看、笔记、课件中继续学习。
          </div>
        </div>
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
