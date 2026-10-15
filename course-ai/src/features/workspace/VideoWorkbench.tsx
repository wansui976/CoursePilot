import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { VideoPlayer } from "@/features/player";
import { ipc } from "@/lib/ipc";
import { isIOS } from "@/lib/platform";
import { qk } from "@/lib/queryKeys";
import type { Course, Video } from "@/lib/types";
import { displayTitle } from "@/lib/videoTitle";
import { ErrorNote } from "@/ui/ErrorNote";
import { TabsPanel } from "./TabsPanel";
import { shouldSplitNotes, WorkspaceLayout } from "./WorkspaceLayout";

/** 单个视频的学习工作台：标题条 + 播放舞台 + 右侧（窄屏下方）学习面板。 */
export function VideoWorkbench({
  video,
  course,
  courseVideos,
  isPhoneDevice,
  shellWide,
  availableWidth,
  backToConceptName,
  onReturnToKnowledge,
  onReturnFromVideo,
  onFullscreenChange,
}: {
  video: Video;
  course: Course | undefined;
  /** 当前课程的视频列表，用来显示「第 N 讲 / 共 M 讲」。 */
  courseVideos: Video[];
  isPhoneDevice: boolean;
  shellWide: boolean;
  availableWidth: number;
  /** 从知识点跳进来时的知识点名：标题条多一个「回到知识点」。 */
  backToConceptName: string | null;
  onReturnToKnowledge: () => void;
  onReturnFromVideo: () => void;
  onFullscreenChange: (fullscreen: boolean) => void;
}) {
  const { t } = useTranslation();
  // asset 协议在 macOS WKWebView 下放大文件会「有画面没声音」；改用本地 HTTP
  // 媒体服务（带 Range）提供视频，拿到 http://127.0.0.1 的 URL 再播。
  const {
    data: mediaSrc,
    isError: mediaSrcError,
    error: mediaSrcErrorObj,
    refetch: refetchMediaSrc,
  } = useQuery({
    queryKey: qk.mediaUrl.video(video.id),
    queryFn: () => ipc.videos.mediaUrl(video.id),
  });
  // 本集在课程中的位置（从 1 起）；队列打开的跨课程视频不在当前列表里时为 0，不显示。
  const videoPosition = courseVideos.findIndex((item) => item.id === video.id) + 1;
  const backLabel = backToConceptName
    ? t("home.backToConcept", { name: backToConceptName })
    : t("nav.back");

  return (
    <WorkspaceLayout
      videoId={video.id}
      shellWide={shellWide}
      availableWidth={availableWidth}
      panel={
        <TabsPanel videoId={video.id} split={shouldSplitNotes(shellWide, availableWidth)} />
      }
      player={
        <section aria-label={t("home.workbench")} className="ca-player-col">
          {!isPhoneDevice && (
            <header className="ca-wb-head">
              <div className="wb-title-row">
                {backToConceptName && (
                  <button
                    type="button"
                    onClick={onReturnToKnowledge}
                    aria-label={t("home.backToConcept", { name: backToConceptName })}
                    title={t("home.backToConcept", { name: backToConceptName })}
                    className="ca-touch-44 inline-flex max-w-[45%] flex-none items-center gap-1 text-sm font-medium text-primary transition hover:opacity-80"
                  >
                    <ChevronLeft className="h-4 w-4 flex-none" />
                    <span className="truncate">{t("home.backToConcepts", { name: backToConceptName })}</span>
                  </button>
                )}
                <div className="min-w-0">
                  {course && (
                    <div className="wb-crumb">
                      <button
                        type="button"
                        onClick={onReturnFromVideo}
                        aria-label={t("home.backToCourse", { name: course.name })}
                        className="wb-crumb-course"
                      >
                        {course.name}
                      </button>
                      {videoPosition > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{t("home.episodeOf", { index: videoPosition, total: courseVideos.length })}</span>
                        </>
                      )}
                    </div>
                  )}
                  <h1 className="wb-title" title={displayTitle(video.title)}>
                    {displayTitle(video.title)}
                  </h1>
                </div>
              </div>
            </header>
          )}
          <div className="ca-stage-wrap">
            {isPhoneDevice && (
              <button
                type="button"
                className="ca-back-fab"
                onClick={onReturnFromVideo}
                title={backLabel}
                aria-label={backLabel}
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            <div className="ca-stage">
              {mediaSrcError ? (
                <div className="flex h-full items-center justify-center bg-black p-4">
                  <ErrorNote
                    className="w-full max-w-md"
                    error={mediaSrcErrorObj}
                    onRetry={() => void refetchMediaSrc()}
                  />
                </div>
              ) : mediaSrc ? (
                <VideoPlayer
                  src={mediaSrc}
                  videoId={video.id}
                  immersive={isIOS()}
                  onFullscreenChange={onFullscreenChange}
                />
              ) : (
                <div className="flex h-full items-center justify-center bg-black text-sm text-white/40">
                  {t("home.preparing")}
                </div>
              )}
            </div>
          </div>
        </section>
      }
    />
  );
}
