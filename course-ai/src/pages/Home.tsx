import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock3, Film, ListVideo, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { CourseSidebar } from "@/components/CourseSidebar";
import { ImportVideoButton } from "@/components/ImportVideoDialog";
import { JobProgress } from "@/components/JobProgress";
import { RagSearchPanel } from "@/components/RagSearchPanel";
import { SettingsPanel } from "@/components/SettingsDialog";
import { TabsPanel } from "@/components/TabsPanel";
import { Button } from "@/components/ui/button";
import { VideoPlayer } from "@/components/VideoPlayer";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";

const statusLabel = {
  pending: "待处理",
  processing: "处理中",
  done: "已完成",
  failed: "处理失败",
} as const;

export function Home() {
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const setVideo = usePlayer((s) => s.setVideo);

  const { data: videos = [] } = useQuery({
    queryKey: ["videos", selectedCourseId],
    queryFn: () => ipc.videos.list(selectedCourseId!),
    enabled: !!selectedCourseId,
  });

  const selectedVideo = videos.find((video) => video.id === selectedVideoId);

  useEffect(() => {
    setVideo(selectedVideoId);
  }, [selectedVideoId, setVideo]);

  return (
    <div className="relative flex h-full overflow-hidden bg-[#0b0b0c]">
      <CourseSidebar
        selectedCourseId={selectedCourseId}
        onSelect={(id) => {
          setSelectedCourseId(id);
          setSelectedVideoId(null);
        }}
        onOpenSettings={() => setShowSettings(true)}
      />
      <section className="flex h-full w-[250px] flex-col border-r border-white/10 bg-[#151515]">
        <div className="border-b border-white/10 px-4 py-4">
          <div className="mb-3 flex items-center gap-2">
            <ListVideo className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-white">课程视频</h2>
          </div>
          {selectedCourseId ? (
            <ImportVideoButton courseId={selectedCourseId} />
          ) : (
            <div className="rounded-md border border-white/8 bg-white/[0.04] p-3 text-xs leading-relaxed text-white/48">
              先在左侧添加或选择课程，再导入本地视频。
            </div>
          )}
        </div>
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {videos.map((video) => (
            <li key={video.id}>
              <button
                onClick={() => setSelectedVideoId(video.id)}
                className={`w-full rounded-md px-3 py-2.5 text-left transition ${
                  video.id === selectedVideoId
                    ? "bg-white/12 text-white shadow-sm"
                    : "text-white/62 hover:bg-white/6 hover:text-white"
                }`}
              >
                <span className="flex items-start gap-2">
                  <Film className="mt-0.5 h-4 w-4 flex-shrink-0 text-white/35" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {video.title}
                    </span>
                    <span className="mt-1 flex items-center gap-2 text-xs text-white/38">
                      <span>{statusLabel[video.processed_status]}</span>
                      {video.duration_ms && (
                        <>
                          <span className="h-1 w-1 rounded-full bg-white/25" />
                          <span>{formatMs(video.duration_ms)}</span>
                        </>
                      )}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          ))}
          {selectedCourseId && videos.length === 0 && (
            <li className="rounded-md border border-white/8 bg-white/[0.04] p-4 text-sm leading-relaxed text-white/50">
              这个课程还没有视频。导入后会在这里形成学习列表。
            </li>
          )}
        </ul>
      </section>
      <main className="flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col bg-black">
          {selectedVideo ? (
            <>
              <div className="flex min-h-24 items-center gap-4 border-b border-white/10 bg-[#101010] px-6 py-4">
                <div className="min-w-0 flex-1">
                  <p className="mb-1 flex items-center gap-2 text-xs font-medium text-white/42">
                    <Sparkles className="h-3.5 w-3.5 text-primary" />
                    学习工作台
                  </p>
                  <h1 className="truncate text-xl font-semibold text-white">
                    {selectedVideo.title}
                  </h1>
                  <p className="mt-2 flex items-center gap-2 text-xs text-white/45">
                    {selectedVideo.processed_status === "done" ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Clock3 className="h-3.5 w-3.5 text-primary" />
                    )}
                    {selectedVideo.processed_status === "done"
                      ? "文稿和学习资料已生成"
                      : "下一步：处理视频生成文稿和学习资料"}
                  </p>
                </div>
                <div className="min-w-[300px]">
                  <RagSearchPanel videoId={selectedVideo.id} />
                </div>
                <Button
                  size="sm"
                  onClick={() => void ipc.pipeline.process(selectedVideo.id)}
                >
                  开始处理
                </Button>
              </div>
              <div className="min-h-0 flex-1">
                <VideoPlayer filePath={selectedVideo.file_path} />
              </div>
              <div className="border-t border-white/10 bg-[#0f0f10] px-4 py-2">
                <JobProgress videoId={selectedVideo.id} />
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center bg-[#0d0d0e] px-8">
              <div className="max-w-md rounded-lg border border-white/8 bg-white/[0.04] p-6 text-center">
                <Film className="mx-auto mb-4 h-10 w-10 text-primary" />
                <h1 className="text-lg font-semibold text-white">
                  {selectedCourseId ? "选择一个视频开始学习" : "选择课程文件夹开始"}
                </h1>
                <p className="mt-2 text-sm leading-relaxed text-white/50">
                  {selectedCourseId
                    ? "从左侧课程视频列表选择一节课，进入播放器、文稿、笔记和 AI 看板。"
                    : "添加课程后导入视频，应用会把字幕、课件和笔记收进同一个学习工作台。"}
                </p>
              </div>
            </div>
          )}
        </div>
        {selectedVideo && (
          <div className="w-[460px] flex-shrink-0 border-l border-white/10 bg-[#171717]">
            <TabsPanel videoId={selectedVideo.id} />
          </div>
        )}
      </main>
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}
