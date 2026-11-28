import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, ChevronRight, KeyRound, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { ErrorNote } from "@/ui/ErrorNote";
import { ViewHeader } from "@/ui/view-header";
import { displayTitle } from "@/lib/videoTitle";
import { formatRelativeTime } from "@/lib/time";
import type { Video } from "@/lib/types";
import type { DownloadJob } from "@/lib/ipc";

/** 队列里一个视频项的展示数据（由 Home 算好传入，避免把进度/阶段逻辑搬进展示组件）。 */
export type QueueItem = {
  video: Video;
  percent: number;
  message: string | null;
  /** 下载时没拿到字幕：说明这一条在用语音识别生成文稿。 */
  note?: string | null;
  /** 走到第几步（「第 3 步，共 10 步」）；失败或还没有阶段时为空。 */
  step?: string | null;
  failed: boolean;
  canCancel: boolean;
  jobLoadError: unknown;
  jobLoadLoading: boolean;
  dismissError: unknown;
  dismissPending: boolean;
};

/** 队列里一个下载项的展示数据（由 ProcessingQueueView 算好传入）。 */
export type DownloadQueueItem = {
  job: DownloadJob;
  percent: number;
  message: string;
  failed: boolean;
  /** 失败原因像是 B 站登录凭证过期：给「重新导入 cookies 并重试」。 */
  cookieExpired?: boolean;
  canCancel: boolean;
};

/** 「最近完成」里的一行：整条流水线都做完的视频。 */
export type RecentQueueItem = {
  video: Video;
  courseName: string | null;
  finishedAt: number;
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
  downloads,
  recent = [],
  onCancelDownload,
  onRetryDownload,
  onReimportCookies,
  onRemoveDownload,
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
  notice,
}: {
  items: QueueItem[];
  downloads: DownloadQueueItem[];
  recent?: RecentQueueItem[];
  onCancelDownload: (id: string) => void;
  onRetryDownload: (id: string) => void;
  onReimportCookies: (id: string) => void;
  onRemoveDownload: (id: string) => void;
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
  /** 列表上方的说明（比如语音识别没配好、导入的视频不会自动处理）。 */
  notice?: ReactNode;
}) {
  const { t } = useTranslation();
  const hasCancellable =
    items.some((item) => item.canCancel) || downloads.some((item) => item.canCancel);
  const hasFailed = items.some((item) => item.failed);
  const totalCount = items.length + downloads.length;

  return (
    <div
      aria-label={t("home.queueTitle")}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <ViewHeader
        title={t("home.queueLabel")}
        // 任务数放在标题下面：和按钮挤在一行时，手机上只能藏起来。
        description={totalCount > 0 ? t("home.queueCount", { count: totalCount }) : undefined}
        level="root"
        className="ca-view-header--column"
        onBack={onBack}
        backLabel={t("home.queueBack")}
        actions={
          <>
            {/* 批量操作：有运行/排队中的任务时「全部取消」，有失败任务时「全部重试」。
                不是这一页的主操作，用不带框的轻按钮，手机上不压过标题。 */}
            {hasFailed && (
              <Button variant="ghost" size="sm" onClick={onRetryAll} className="ca-touch-44">
                <RotateCcw className="h-3.5 w-3.5" />
                {t("home.retryAll")}
              </Button>
            )}
            {hasCancellable && (
              <Button variant="ghost" size="sm" onClick={onCancelAll} className="ca-touch-44">
                <X className="h-3.5 w-3.5" />
                {t("home.cancelAll")}
              </Button>
            )}
          </>
        }
      />
      {/* 限宽居中，与学习面板同宽：大屏上进度条不再拉满一千多像素，百分比和「取消」贴着标题。 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto w-full max-w-3xl">
        {error && (
          <ErrorNote className="mb-4" error={errorObj} onRetry={onRetryLoad} />
        )}
        {notice}
        {loading && items.length === 0 ? (
          <div
            role="status"
            className="flex h-full min-h-[240px] items-center justify-center gap-2 text-sm text-[var(--text-faint)]"
          >
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            {t("home.queueLoading")}
          </div>
        ) : totalCount === 0 && !error && recent.length === 0 ? (
          <div className="flex h-full min-h-[240px] items-center justify-center">
            <EmptyState
              title={t("home.queueEmpty")}
            />
          </div>
        ) : totalCount === 0 && !error ? (
          <p className="py-2 text-sm text-[var(--text-muted)]">{t("home.queueIdle")}</p>
        ) : totalCount > 0 ? (
          // 平铺的列表：上下发丝线分隔，不再每个任务一张带框带影的卡片。
          <div className="flex w-full flex-col gap-9">
            {items.length > 0 && (
              <section aria-labelledby="queue-processing" className="flex flex-col">
                <SectionHead id="queue-processing" title={t("home.queueProcessing")} count={items.length} />
                <ul className="flex w-full flex-col">
                  {items.map((item) => {
                    const { video, percent, message, failed, canCancel } = item;
                    const title = displayTitle(video.title);
                    return (
                      <li key={video.id} className="border-b border-[var(--border-faint)]">
                        <QueueRow
                          title={title}
                          percent={percent}
                          failed={failed}
                          message={message}
                          detail={item.step}
                          note={!failed ? item.note : null}
                          progressLabel={t("home.queueTaskProgress", { title })}
                          progressValue={t("home.queueTaskProgressValue", { percent, message })}
                          onOpen={() => onOpenVideo(video)}
                          action={
                            canCancel ? (
                              <RowAction
                                label={t("home.cancel")}
                                ariaLabel={t("home.cancelTask", { title })}
                                onClick={() => onCancelVideo(video.id)}
                              />
                            ) : null
                          }
                          footer={
                            failed ? (
                              <>
                                <FooterButton onClick={() => onRetryProcessing(video)}>
                                  <RotateCcw className="h-3.5 w-3.5" />
                                  {t("home.retry")}
                                </FooterButton>
                                <FooterButton
                                  danger
                                  onClick={() => onRemoveVideo(video.id)}
                                  disabled={dismiss.isPending && dismiss.variables === video.id}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                  {t("home.remove")}
                                </FooterButton>
                              </>
                            ) : null
                          }
                        />
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
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {downloads.length > 0 && (
              <section aria-labelledby="queue-downloads" className="flex flex-col">
                <SectionHead id="queue-downloads" title={t("downloads.sectionTitle")} count={downloads.length} />
                <ul className="flex w-full flex-col">
                  {downloads.map((item) => {
                    const { job, percent, message, failed, cookieExpired, canCancel } = item;
                    // 下载任务的标题常带着文件扩展名（「第 10 讲.mp4」），和课程里的写法对齐。
                    const title = displayTitle(job.title);
                    return (
                      <li key={job.id} className="border-b border-[var(--border-faint)]">
                        <QueueRow
                          title={title}
                          percent={percent}
                          failed={failed}
                          message={message}
                          progressLabel={t("downloads.progressAria", { title })}
                          progressValue={t("downloads.progressAriaValue", { percent, message })}
                          action={
                            canCancel ? (
                              <RowAction
                                label={t("home.cancel")}
                                ariaLabel={t("downloads.cancelTask", { title })}
                                onClick={() => onCancelDownload(job.id)}
                              />
                            ) : null
                          }
                          footer={
                            failed ? (
                              <>
                                {cookieExpired ? (
                                  <FooterButton onClick={() => onReimportCookies(job.id)}>
                                    <KeyRound className="h-3.5 w-3.5" />
                                    {t("downloads.reimportCookies")}
                                  </FooterButton>
                                ) : (
                                  <FooterButton onClick={() => onRetryDownload(job.id)}>
                                    <RotateCcw className="h-3.5 w-3.5" />
                                    {t("downloads.retry")}
                                  </FooterButton>
                                )}
                                <FooterButton danger onClick={() => onRemoveDownload(job.id)}>
                                  <Trash2 className="h-3.5 w-3.5" />
                                  {t("downloads.remove")}
                                </FooterButton>
                              </>
                            ) : null
                          }
                        />
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </div>
        ) : null}
        {recent.length > 0 && !(loading && items.length === 0) && (
          <section aria-labelledby="queue-recent" className="mt-9">
            <SectionHead id="queue-recent" title={t("home.queueRecent")} />
            <ul className="flex w-full flex-col">
              {recent.map(({ video, courseName, finishedAt }) => (
                <li key={video.id} className="border-b border-[var(--border-faint)]">
                  <button
                    type="button"
                    onClick={() => onOpenVideo(video)}
                    className="group flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-[var(--surface-card-hover)]"
                  >
                    <CheckCircle2
                      className="h-4 w-4 shrink-0 text-[var(--status-ok)]"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-[var(--text-strong)]">
                        {displayTitle(video.title)}
                      </span>
                      <span className="block truncate text-xs text-[var(--text-muted)]">
                        {courseName ? `${courseName} · ` : ""}
                        {t("home.queueFinishedAt", { time: formatRelativeTime(finishedAt) })}
                      </span>
                    </span>
                    <ChevronRight
                      className="h-4 w-4 shrink-0 text-[var(--text-faint)] opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100"
                      aria-hidden="true"
                    />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        </div>
      </div>
    </div>
  );
}

/** 小节标题：衬线标题 + 延伸到边的发丝线（设计规范的 section head），数量写在线后面。 */
function SectionHead({ id, title, count }: { id: string; title: string; count?: number }) {
  return (
    <div className="ca-section-head">
      <h2 id={id}>{title}</h2>
      {count != null && (
        <span className="ca-section-more font-[family-name:var(--font-mono)] tabular-nums">{count}</span>
      )}
    </div>
  );
}

/**
 * 队列里的一行：左边标题、进度条、状态；右边百分比和这一行的操作，排成固定的两列，
 * 下载和处理两个区上下对得齐。失败时进度条和状态换成错误色，操作挪到状态下面一排。
 */
function QueueRow({
  title,
  percent,
  failed,
  message,
  detail,
  note,
  progressLabel,
  progressValue,
  onOpen,
  action,
  footer,
}: {
  title: string;
  percent: number;
  failed: boolean;
  message: string | null;
  /** 跟在状态后面的补充（「第 3 步，共 10 步」）。 */
  detail?: string | null;
  note?: string | null;
  progressLabel: string;
  progressValue: string;
  /** 整行可点（打开视频）。 */
  onOpen?: () => void;
  action: ReactNode;
  footer: ReactNode;
}) {
  const body = (
    <>
      <span className="block truncate text-sm font-medium text-[var(--text-strong)]">{title}</span>
      <span
        role="progressbar"
        aria-label={progressLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={progressValue}
        className="mt-2 block h-1.5 overflow-hidden rounded bg-[var(--surface-card-hover)]"
      >
        <span
          className={`block h-full ${failed ? "bg-[var(--status-err)]" : "ca-fill-ink"}`}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span
        role={failed ? "alert" : "status"}
        aria-live={failed ? "assertive" : "polite"}
        aria-atomic="true"
        className={
          failed
            ? "mt-1.5 block whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--status-err)]"
            : "mt-1.5 block truncate text-xs text-[var(--text-muted)]"
        }
      >
        {message}
        {detail ? <span className="text-[var(--text-faint)]">{` · ${detail}`}</span> : null}
      </span>
      {note && <span className="mt-0.5 block text-xs leading-relaxed text-[var(--text-faint)]">{note}</span>}
    </>
  );
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="-mx-2 -my-1 block w-[calc(100%+1rem)] rounded-md px-2 py-1 text-left transition hover:bg-[var(--surface-card-hover)]"
          >
            {body}
          </button>
        ) : (
          body
        )}
        {footer && <div className="mt-2 flex flex-wrap items-center gap-2">{footer}</div>}
      </div>
      <span className="w-10 flex-none pt-px text-right font-[family-name:var(--font-mono)] text-xs tabular-nums text-[var(--text-muted)]">
        {percent}%
      </span>
      <span className="flex w-12 flex-none justify-end">{action}</span>
    </div>
  );
}

function RowAction({
  label,
  ariaLabel,
  onClick,
}: {
  label: string;
  ariaLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="ca-hit-expand relative -my-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--status-err)]"
    >
      {label}
    </button>
  );
}

function FooterButton({
  danger = false,
  disabled,
  onClick,
  children,
}: {
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`ca-touch-44 inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2 py-1 text-xs font-medium transition hover:bg-[var(--surface-card-hover)] disabled:opacity-50 ${
        danger ? "text-[var(--status-err)]" : "text-[var(--text-strong)]"
      }`}
    >
      {children}
    </button>
  );
}
