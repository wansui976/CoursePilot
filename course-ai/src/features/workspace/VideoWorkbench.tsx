import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { VideoPlayer } from "@/features/player";
import { ipc } from "@/lib/ipc";
import { isIOS } from "@/lib/platform";
import { qk } from "@/lib/queryKeys";
import type { Course, Video } from "@/lib/types";
import { displayTitle } from "@/lib/videoTitle";
import { ErrorNote } from "@/ui/ErrorNote";
import { TabsPanel } from "./TabsPanel";
import { ClipQueueBar } from "./ClipQueueBar";
import { RemoteMediaStage } from "./RemoteMediaStage";
import { DriveDownloadBar } from "./DriveDownloadBar";
import { LanDownloadBar } from "./LanDownloadBar";
import { WorkspaceLayout } from "./WorkspaceLayout";
import { allowsNotesSplit } from "./workbenchLayout";

/** 单个视频的学习工作台：标题条 + 播放舞台 + 右侧（窄屏下方）学习面板。 */
export function VideoWorkbench({
  video,
  course,
  courseVideos,
  isPhoneDevice,
  shellWide,
  availableWidth,
  backToConceptName,
  showBackButton = false,
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
  /** 侧栏收起时为 true：rail 里没有返回，标题左边补一个。 */
  showBackButton?: boolean;
  onReturnToKnowledge: () => void;
  onReturnFromVideo: () => void;
  onFullscreenChange: (fullscreen: boolean) => void;
}) {
  const { t } = useTranslation();
  const hasLocalFile = video.file_path !== "";
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
    // 从别的设备同步过来、本机还没有文件：不去要播放地址，舞台上给「从网盘下载」。
    enabled: hasLocalFile,
  });
  // 本机没有文件：网盘导入的「在线看」视频从网盘边下边播；不是的话在局域网里找开着
  // 「局域网直连播放」的电脑。都找不到就给「从网盘下载」（RemoteMediaStage）。
  const remoteStream = useQuery({
    queryKey: qk.mediaUrl.lan(video.id),
    queryFn: async (): Promise<{ src: string; kind: "drive" | "lan" } | null> => {
      const drive = await ipc.webdavImport.streamUrl(video.id).catch(() => null);
      if (drive) return { src: drive, kind: "drive" };
      const lan = await ipc.lanShare.streamUrl(video.id);
      return lan ? { src: lan, kind: "lan" } : null;
    },
    enabled: !hasLocalFile,
    retry: false,
    staleTime: 5 * 60_000,
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
        <TabsPanel
          videoId={video.id}
          subtitleMissing={video.subtitle_missing ?? null}
          allowSplit={allowsNotesSplit(shellWide, availableWidth)}
        />
      }
      player={
        <section aria-label={t("home.workbench")} className="ca-player-col">
          {!isPhoneDevice && (
            <header className="ca-wb-head">
              <div className="wb-title-row">
                {/* 侧栏收起时这里放一个明确的返回：收起后的 rail 只剩图标，返回箭头混在一排
                    入口里、又紧挨着展开侧栏的箭头，不好找。侧栏展开时侧栏顶上已经有「返回课程库」。 */}
                {showBackButton && !backToConceptName && (
                  <button
                    type="button"
                    onClick={onReturnFromVideo}
                    aria-label={t("nav.backToLibrary")}
                    title={t("nav.backToLibrary")}
                    className="wb-back ca-icon-btn"
                  >
                    <ArrowLeft className="h-[18px] w-[18px]" />
                  </button>
                )}
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
          <ClipQueueBar />
          {/* 存到本机之后文件就有了，这条不用再留着（下载完成会立刻刷新 video.file_path）。 */}
          {!hasLocalFile && remoteStream.data?.kind === "drive" && <DriveDownloadBar video={video} />}
          {!hasLocalFile && remoteStream.data?.kind === "lan" && <LanDownloadBar video={video} />}
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
              {!hasLocalFile ? (
                remoteStream.data ? (
                  <VideoPlayer
                    src={remoteStream.data.src}
                    videoId={video.id}
                    courseId={video.course_id}
                    immersive={isIOS()}
                    onFullscreenChange={onFullscreenChange}
                    onTranscoded={() => remoteStream.refetch()}
                    remote={{ kind: remoteStream.data.kind, onReconnect: () => remoteStream.refetch() }}
                  />
                ) : (
                  <RemoteMediaStage
                    video={video}
                    lanChecking={remoteStream.isFetching}
                    onRetryLan={() => void remoteStream.refetch()}
                  />
                )
              ) : mediaSrcError ? (
                <div className="flex h-full items-center justify-center bg-black p-4">
                  <ErrorNote
                    className="w-full max-w-md"
                    error={mediaSrcErrorObj}
                    onRetry={() => void refetchMediaSrc()}
                  />
                </div>
              ) : mediaSrc ? (
                // onTranscoded 把 refetch 的 Promise 交回去：播放器等它完成（媒体服务的
                // 注册表已指向 playable.mp4）再重挂 <video>，免得抢在更新前又请求到原件。
                <VideoPlayer
                  src={mediaSrc}
                  videoId={video.id}
                  courseId={video.course_id}
                  immersive={isIOS()}
                  onFullscreenChange={onFullscreenChange}
                  onTranscoded={() => refetchMediaSrc()}
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
