import type { TFunction } from "i18next";
import type { UrlImportEvent } from "@/lib/ipc";

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
