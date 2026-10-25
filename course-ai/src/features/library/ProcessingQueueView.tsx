import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ipc, type DownloadJob } from "@/lib/ipc";
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
