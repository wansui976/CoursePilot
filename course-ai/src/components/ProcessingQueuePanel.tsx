import { useTranslation } from "react-i18next";
import { ClipboardList, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { ViewHeader } from "@/components/ui/view-header";
import { displayTitle } from "@/lib/videoTitle";
import type { Video } from "@/lib/types";

/** 队列里一个视频项的展示数据（由 Home 算好传入，避免把进度/阶段逻辑搬进展示组件）。 */
export type QueueItem = {
  video: Video;
  percent: number;
  message: string | null;
  failed: boolean;
  canCancel: boolean;
  jobLoadError: unknown;
  jobLoadLoading: boolean;
  dismissError: unknown;
  dismissPending: boolean;
};

export type DismissState = {
  isError: boolean;
  isPending: boolean;
  variables: string | undefined;
  error: unknown;
  mutate: (videoId: string) => void;
};

export function ProcessingQueuePanel({
  items,
  loading,
  error,
  errorObj,
  onRetryLoad,
  onBack,
  onOpenVideo,
  onRetryProcessing,
  onRemoveVideo,
  onRetryJobs,
  onCancelVideo,
  onCancelAll,
  onRetryAll,
  dismiss,
}: {
  items: QueueItem[];
  loading: boolean;
  error: boolean;
  errorObj: unknown;
  onRetryLoad: () => void;
  onBack: () => void;
  onOpenVideo: (video: Video) => void;
  onRetryProcessing: (video: Video) => void;
  onRemoveVideo: (videoId: string) => void;
  onRetryJobs: (videoId: string) => void;
  onCancelVideo: (videoId: string) => void;
  onCancelAll: () => void;
  onRetryAll: () => void;
  dismiss: DismissState;
}) {
  const { t } = useTranslation();
  const hasCancellable = items.some((item) => item.canCancel);
  const hasFailed = items.some((item) => item.failed);

  return (
    <div
      aria-label={t("home.queueTitle")}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <ViewHeader
        title={t("home.queueLabel")}
        onBack={onBack}
        backLabel={t("home.queueBack")}
        actions={
          <>
            {/* 批量操作：有运行/排队中的任务时「全部取消」，有失败任务时「全部重试」。 */}
            {hasCancellable && (
              <Button variant="outline" size="sm" onClick={onCancelAll} className="ca-touch-44">
                <X className="h-3.5 w-3.5" />
                {t("home.cancelAll")}
              </Button>
            )}
            {hasFailed && (
              <Button variant="outline" size="sm" onClick={onRetryAll} className="ca-touch-44">
                <RotateCcw className="h-3.5 w-3.5" />
                {t("home.retryAll")}
              </Button>
            )}
            <Badge tone="neutral" dot={false}>
              {t("home.queueCount", { count: items.length })}
            </Badge>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        {error && (
          <ErrorNote className="mb-4" error={errorObj} onRetry={onRetryLoad} />
        )}
        {loading && items.length === 0 ? (
          <div
            role="status"
            className="flex h-full min-h-[240px] items-center justify-center gap-2 text-sm text-[var(--text-faint)]"
          >
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            {t("home.queueLoading")}
          </div>
        ) : items.length === 0 && !error ? (
          <div className="flex h-full min-h-[240px] items-center justify-center">
            <EmptyState
              icon={<ClipboardList className="h-6 w-6" />}
              title={t("home.queueEmpty")}
            />
          </div>
        ) : items.length > 0 ? (
          <div className="flex w-full flex-col gap-3">
            {items.map((item) => {
              const { video, percent, message, failed, canCancel } = item;
              return (
                <div
                  key={video.id}
                  className="relative overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-[var(--shadow-card)]"
                >
                  <button
                    onClick={() => onOpenVideo(video)}
                    className={`block w-full px-4 py-3 text-left transition hover:bg-[var(--surface-card-hover)] ${
                      canCancel ? "pr-20" : failed ? "pr-40" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 truncate text-sm font-medium text-[var(--text-strong)]">
                        {displayTitle(video.title)}
                      </div>
                      <span className="shrink-0 tabular-nums text-xs text-[var(--text-muted)]">
                        {percent}%
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label={t("home.queueTaskProgress", {
                        title: displayTitle(video.title),
                      })}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent}
                      aria-valuetext={t("home.queueTaskProgressValue", {
                        percent,
                        message,
                      })}
                      className="mt-2 h-1.5 overflow-hidden rounded bg-[var(--surface-card-hover)]"
                    >
                      <div
                        className={
                          failed ? "h-full bg-[var(--status-err)]" : "ca-fill-grad h-full"
                        }
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    <div
                      role={failed ? "alert" : "status"}
                      aria-live={failed ? "assertive" : "polite"}
                      aria-atomic="true"
                      className={
                        failed
                          ? "mt-1.5 whitespace-pre-wrap break-words pr-2 text-xs leading-relaxed text-[var(--status-err)]"
                          : "mt-1.5 truncate text-xs text-[var(--text-muted)]"
                      }
                    >
                      {message}
                    </div>
                  </button>
                  {item.jobLoadError != null && (
                    <div className="border-t border-[var(--border-faint)] px-4 py-2">
                      <ErrorNote error={item.jobLoadError} onRetry={() => onRetryJobs(video.id)} />
                    </div>
                  )}
                  {dismiss.isError && dismiss.variables === video.id && (
                    <div className="border-t border-[var(--border-faint)] px-4 py-2">
                      <ErrorNote
                        error={dismiss.error}
                        onRetry={() => dismiss.mutate(video.id)}
                      />
                    </div>
                  )}
                  {canCancel && (
                    <button
                      onClick={() => onCancelVideo(video.id)}
                      className="ca-touch-44 absolute right-3 top-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2 py-1 text-xs text-[var(--text-muted)] transition hover:text-[var(--status-err)]"
                    >
                      {t("home.cancel")}
                    </button>
                  )}
                  {failed && (
                    <div className="absolute right-3 top-3 flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onRetryProcessing(video)}
                        className="ca-touch-44 inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2 py-1 text-xs font-medium text-[var(--text-normal)] transition hover:bg-[var(--surface-card-hover)]"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {t("home.retry")}
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveVideo(video.id)}
                        disabled={dismiss.isPending && dismiss.variables === video.id}
                        className="ca-touch-44 inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2 py-1 text-xs font-medium text-[var(--status-err)] transition hover:bg-[var(--surface-card-hover)]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t("home.remove")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
