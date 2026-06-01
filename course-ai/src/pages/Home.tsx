import { useQuery } from "@tanstack/react-query";
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
import { usePlayer } from "@/stores/player";

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
    <div className="relative flex h-full">
      <CourseSidebar
        selectedCourseId={selectedCourseId}
        onSelect={(id) => {
          setSelectedCourseId(id);
          setSelectedVideoId(null);
        }}
        onOpenSettings={() => setShowSettings(true)}
      />
      <div className="flex w-64 flex-col gap-2 border-r border-white/10 p-3">
        {selectedCourseId && <ImportVideoButton courseId={selectedCourseId} />}
        <ul className="flex-1 overflow-y-auto">
          {videos.map((video) => (
            <li key={video.id}>
              <button
                onClick={() => setSelectedVideoId(video.id)}
                className={`w-full rounded px-2 py-1.5 text-left text-sm ${
                  video.id === selectedVideoId ? "bg-white/10" : "hover:bg-white/5"
                }`}
              >
                <span className="block truncate">{video.title}</span>
                <span className="text-xs text-white/40">{video.processed_status}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <main className="flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedVideo ? (
            <>
              <div className="flex items-center gap-3 border-b border-white/10 p-2">
                <h2 className="flex-1 truncate text-sm">{selectedVideo.title}</h2>
                <RagSearchPanel videoId={selectedVideo.id} />
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
              <div className="border-t border-white/10 p-2">
                <JobProgress videoId={selectedVideo.id} />
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-white/40">
              选择视频
            </div>
          )}
        </div>
        {selectedVideo && (
          <div className="w-[400px] flex-shrink-0 border-l border-white/10">
            <TabsPanel videoId={selectedVideo.id} />
          </div>
        )}
      </main>
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}
