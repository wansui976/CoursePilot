import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { stageMessage } from "@/lib/pipelineProgress";
import type { Video } from "@/lib/types";
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
      onCancelAll={queue.cancelAllProcessing}
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
