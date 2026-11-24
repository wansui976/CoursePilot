import { useMemo } from "react";
import { Info, Settings } from "lucide-react";
import { useOptionalShell } from "@/app/shell";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ipc, type DownloadJob } from "@/lib/ipc";
import { queries } from "@/lib/queries";
import { qk } from "@/lib/queryKeys";
import { describeDownloadJob, jobPercent } from "@/lib/downloadProgress";
import { looksLikeCookieError, pickBilibiliCookies } from "@/lib/bilibiliCookies";
import { isBilibiliUrl } from "@/lib/sourceUrl";
import { stageMessage } from "@/lib/pipelineProgress";
import type { Video } from "@/lib/types";
import {
  isCancelableDownload,
  isVisibleDownload,
  useDownloads,
} from "@/stores/downloads";
import { ProcessingQueuePanel } from "./ProcessingQueuePanel";
import type { ProcessingQueue } from "./useProcessingQueue";

/** 处理队列整页：把 useProcessingQueue 的状态整理成卡片数据交给 ProcessingQueuePanel。 */
export function ProcessingQueueView({
  queue,
  onBack,
  onOpenVideo,
}: {
  queue: ProcessingQueue;
  onBack: () => void;
  onOpenVideo: (video: Video) => void;
}) {
  const { t } = useTranslation();
  const downloadsById = useDownloads((s) => s.byId);
  const downloadOrder = useDownloads((s) => s.order);
  const downloads = useMemo(
    () =>
      downloadOrder
        .map((id) => downloadsById[id])
        .filter((job): job is DownloadJob => !!job && isVisibleDownload(job.status))
        .map((job) => {
          const failed = job.status === "failed";
          // 下载在后台跑，弹窗早关了：B 站凭证过期（412 等）只能在这里说清楚、给出路。
          const cookieExpired =
            failed && isBilibiliUrl(job.url) && looksLikeCookieError(job.error ?? "");
          const message = describeDownloadJob(job, t);
          return {
            job,
            percent: jobPercent(job),
            message: cookieExpired ? `${t("downloads.cookieExpired")}\n${message}` : message,
            failed,
            cookieExpired,
            canCancel: isCancelableDownload(job.status),
          };
        }),
    [downloadOrder, downloadsById, t],
  );
  const { data: recentVideos } = useQuery({
    queryKey: qk.recentProcessed(),
    queryFn: () => ipc.pipeline.recent(5),
  });
  const { data: courses } = useQuery(queries.courses());
  const recent = useMemo(() => {
    const names = new Map((courses ?? []).map((course) => [course.id, course.name]));
    // 还在队列里的（比如刚做完、正停在 100% 那一秒）不重复列。
    const queued = new Set(queue.queuedVideos.map((video) => video.id));
    return (recentVideos ?? [])
      .filter((video) => !queued.has(video.id))
      .map((video) => ({
        video,
        courseName: names.get(video.course_id) ?? null,
        finishedAt: video.finished_at,
      }));
  }, [courses, queue.queuedVideos, recentVideos]);
  const items = queue.queuedVideos.map((video) => {
    const active = queue.activeJobFor(video.id);
    const jobLoadState = queue.jobLoadStateByVideo[video.id];
    const jobLoadError = jobLoadState?.status === "error" ? jobLoadState.error : null;
    const message = jobLoadError
      ? t("home.queueJobsLoadError")
      : jobLoadState?.status === "loading" && !active
        ? t("home.queueJobsLoading")
        : stageMessage(active, t);
    return {
      video,
      percent: Math.floor(queue.pipelineProgressFor(video.id) * 100),
      message,
      note: video.subtitle_missing ? t("home.queueSubtitleMissing") : null,
      failed: active?.status === "failed",
      canCancel: active?.status === "running" || active?.status === "pending",
      jobLoadError,
      jobLoadLoading: jobLoadState?.status === "loading",
      dismissError: queue.dismissProcessing.error,
      dismissPending: queue.dismissProcessing.isPending && queue.dismissProcessing.variables === video.id,
    };
  });
  return (
    <ProcessingQueuePanel
      items={items}
      downloads={downloads}
      recent={recent}
      onCancelDownload={(id) => {
        void ipc.downloads.cancel(id).catch(() => {});
      }}
      onRetryDownload={(id) => {
        void ipc.downloads.retry(id).catch(() => {});
      }}
      onReimportCookies={(id) => {
        void pickBilibiliCookies()
          .then((picked) => (picked ? ipc.downloads.retry(id) : undefined))
          .catch(() => {});
      }}
      onRemoveDownload={(id) => {
        void ipc.downloads
          .remove(id)
          .then(() => useDownloads.getState().remove(id))
          .catch(() => {});
      }}
      loading={queue.activeProcessingLoading}
      error={queue.activeProcessingError}
      errorObj={queue.activeProcessingErrorObj}
      onRetryLoad={() => void queue.retryActiveProcessing()}
      onBack={onBack}
      onOpenVideo={onOpenVideo}
      onRetryProcessing={queue.startProcessing}
      onRemoveVideo={queue.removeQueuedVideo}
      onRetryJobs={queue.retryJobsForVideo}
      onCancelVideo={(id) => void ipc.pipeline.cancel(id)}
      onCancelAll={() => {
        // 先让后端停掉下载、并且不再给下完的视频起流水线，再取消正在跑的处理；
        // 反过来的话，最后一个下载被取消时整批「结束」，又会起一批新的处理。
        void ipc.downloads
          .cancelAll()
          .catch(() => {})
          .finally(() => queue.cancelAllProcessing());
      }}
      onRetryAll={queue.retryFailedAll}
      notice={<AsrNotReadyNotice />}
      dismiss={{
        isError: queue.dismissProcessing.isError,
        isPending: queue.dismissProcessing.isPending,
        variables: queue.dismissProcessing.variables,
        error: queue.dismissProcessing.error,
        mutate: queue.dismissProcessing.mutate,
      }}
    />
  );

}

/** 设置「导入后立刻处理」开着、但语音识别没配好：导入的视频不会自动开始（带自带字幕的除外）。 */
function AsrNotReadyNotice() {
  const { t } = useTranslation();
  const shell = useOptionalShell();
  const { data } = useQuery({
    queryKey: qk.autoProcessReadiness(),
    queryFn: async () => {
      const [auto, ready] = await Promise.all([
        ipc.settings.get("auto_process_imports").catch(() => null),
        ipc.pipeline.asrReady().catch(() => true),
      ]);
      return { auto: auto !== "false", ready };
    },
  });
  if (!data || !data.auto || data.ready) return null;
  return (
    <div role="note" className="ca-callout info mb-4">
      <Info className="ca-callout-icon" />
      <span className="min-w-0 flex-1 text-[var(--text-normal)]">{t("home.queueAsrNotReady")}</span>
      {shell && (
        <button type="button" onClick={() => shell.openSettingsCategory("asr")} className="ca-callout-act">
          <Settings className="h-3 w-3" />
          {t("errors.fixAsr")}
        </button>
      )}
    </div>
  );
}
