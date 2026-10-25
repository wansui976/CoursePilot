import type { TFunction } from "i18next";
import type { DownloadJob, UrlImportEvent } from "@/lib/ipc";

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

/** 把一条下载事件写成一行给人看的进度：「下载中 42% · 3.1 MB/s」。 */
export function describeDownload(event: UrlImportEvent, t: TFunction): string {
  if (event.type === "merging") return t("urlImport.merging");
  if (event.type === "retrying") {
    return t("urlImport.retrying", { height: event.maxHeight });
  }
  const label =
    event.total && event.total > 0
      ? t("urlImport.percent", {
          percent: Math.min(100, Math.floor((event.downloaded / event.total) * 100)),
        })
      : t("urlImport.bytes", { size: formatBytes(event.downloaded) });
  return event.speed && event.speed > 0
    ? t("urlImport.speed", { label, speed: formatBytes(event.speed) })
    : label;
}

/** 下载任务的完成度（0–100）。合并、已完成都算 100%。 */
export function jobPercent(job: DownloadJob): number {
  if (job.status === "done" || job.status === "merging" || job.status === "importing") {
    return 100;
  }
  if (!job.total || job.total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((job.downloaded / job.total) * 100)));
}

/** 把一条队列任务写成一行给人看的进度：「下载中 42% · 3.1 MB/s」。 */
export function describeDownloadJob(job: DownloadJob, t: TFunction): string {
  if (job.status === "failed") return job.error ?? t("downloads.failed");
  if (job.status === "queued") return t("downloads.queued");
  if (job.retryHeight != null) return t("urlImport.retrying", { height: job.retryHeight });
  if (job.status === "merging") return t("urlImport.merging");
  if (job.status === "importing") return t("downloads.importing");
  const label =
    job.total && job.total > 0
      ? t("urlImport.percent", { percent: jobPercent(job) })
      : t("urlImport.bytes", { size: formatBytes(job.downloaded) });
  return job.speed && job.speed > 0
    ? t("urlImport.speed", { label, speed: formatBytes(job.speed) })
    : label;
}
