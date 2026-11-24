import type { TFunction } from "i18next";
import type { DownloadJob, DownloadSubtitleState } from "@/lib/ipc";

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

/** 字幕那一步给人看的一句话。字幕拿不到不算失败：视频照样导入，文稿改用语音识别。 */
function describeSubtitle(state: DownloadSubtitleState, wait: number | null, t: TFunction): string {
  if (state === "fetching") return t("urlImport.subtitles");
  if (state === "waiting") return t("urlImport.subtitlesWaiting", { seconds: wait ?? 0 });
  if (state === "rateLimited") return t("urlImport.subtitlesRateLimited");
  if (state === "failed") return t("urlImport.subtitlesFailed");
  return t("urlImport.subtitlesSkipped");
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
  // 视频下完后单独下字幕：从这一步起视频已经下好，下载中 / 合并中都只说字幕的情况
  // （没拿到的说明），不再显示停住的百分比；入库时跟在「正在导入」后面。
  const subtitle = job.subtitle ? describeSubtitle(job.subtitle, job.subtitleWait, t) : null;
  const inSubtitleStep = job.subtitle === "fetching" || job.subtitle === "waiting";
  if (subtitle && job.status === "downloading") return subtitle;
  if (subtitle && inSubtitleStep && job.status !== "importing") return subtitle;
  if (job.status === "merging") return subtitle ? `${t("urlImport.merging")}\n${subtitle}` : t("urlImport.merging");
  if (job.status === "importing") {
    return subtitle && !inSubtitleStep ? `${t("downloads.importing")}\n${subtitle}` : t("downloads.importing");
  }
  const label =
    job.total && job.total > 0
      ? t("urlImport.percent", { percent: jobPercent(job) })
      : t("urlImport.bytes", { size: formatBytes(job.downloaded) });
  return job.speed && job.speed > 0
    ? t("urlImport.speed", { label, speed: formatBytes(job.speed) })
    : label;
}
