import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { CloudDownload, Loader2, Wifi } from "lucide-react";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { ipc, type RemoteSyncDownloadEvent } from "@/lib/ipc";
import type { Video } from "@/lib/types";

const MB = 1024 * 1024;

/** 看起来是网盘（WebDAV）上的文件：只用来决定提示怎么说。 */
const looksLikeDriveFile = (video: Video) =>
  video.source_type === "url" && /\/dav(\/|$)|remote\.php\/dav|:500[56]\//i.test(video.source_uri ?? "");
const formatMb = (bytes: number) => `${Math.max(1, Math.round(bytes / MB))} MB`;

/**
 * 视频条目是从别的设备同步过来的、这台设备上还没有文件时，舞台上显示这个，而不是让播放器报错。
 * 网盘上有就给「从网盘下载」（带进度，断了可以接着下）；没有就说明要先在有文件的那台设备上传。
 * 字幕、笔记、AI 内容这些照常在右边看——它们已经同步过来了。
 *
 * 舞台出现之前（和同时）工作台已经在局域网里找过开着「局域网直连播放」的电脑；找到了就直接播，
 * 不会显示这里。这里给一句提示和「再找一次」。
 */
export function RemoteMediaStage({
  video,
  lanChecking = false,
  onRetryLan,
}: {
  video: Video;
  lanChecking?: boolean;
  onRetryLan?: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [error, setError] = useState<unknown>(null);

  const size = useQuery({
    queryKey: ["remote-media-size", video.id],
    queryFn: () => ipc.remoteSync.mediaSize(video.id),
    retry: false,
    staleTime: 30_000,
  });

  useEffect(() => {
    const unlisten = listen<RemoteSyncDownloadEvent>("remote-sync:download", (event) => {
      if (event.payload.videoId !== video.id || event.payload.done) return;
      setProgress({ received: event.payload.received, total: event.payload.total });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [video.id]);

  async function download() {
    setError(null);
    setProgress({ received: 0, total: size.data ?? 0 });
    try {
      await ipc.remoteSync.downloadVideo(video.id);
      // 文件挂上了：刷新视频条目，工作台换成播放器。
      await queryClient.invalidateQueries({ queryKey: ["videos"] });
      await queryClient.invalidateQueries();
    } catch (err) {
      setError(err);
    } finally {
      setProgress(null);
    }
  }

  const percent = progress && progress.total > 0 ? Math.floor((progress.received / progress.total) * 100) : 0;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-[#0b0d12] p-6 text-center text-white/85">
      <CloudDownload className="h-10 w-10 text-white/50" aria-hidden="true" />
      <div className="max-w-sm space-y-1.5">
        <p className="ca-t-md font-medium">{t("remoteMedia.title")}</p>
        {looksLikeDriveFile(video) && <p className="ca-t-sm text-white/70">{t("webdavImport.streamUnavailable")}</p>}
        <p className="ca-t-sm text-white/55">
          {size.isError
            ? t("remoteMedia.noSync")
            : size.data === null
              ? t("remoteMedia.notUploaded")
              : t("remoteMedia.available")}
        </p>
      </div>
      {size.isPending && <Loader2 className="h-4 w-4 animate-spin text-white/50" aria-label={t("remoteMedia.checking")} />}
      {typeof size.data === "number" && (
        progress ? (
          <div className="w-full max-w-xs space-y-2">
            <div
              role="progressbar"
              aria-label={t("remoteMedia.downloading")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-1.5 overflow-hidden rounded-full bg-white/15"
            >
              <div className="h-full rounded-full bg-white/80 transition-[width] duration-300" style={{ width: `${percent}%` }} />
            </div>
            <p className="ca-t-xs tabular-nums text-white/55">
              {t("remoteMedia.progress", { received: formatMb(progress.received), total: formatMb(progress.total || size.data) })}
            </p>
          </div>
        ) : (
          <Button variant="primary" onClick={() => void download()}>
            <CloudDownload className="h-4 w-4" />
            {t("remoteMedia.download", { size: formatMb(size.data) })}
          </Button>
        )
      )}
      {error != null && <ErrorNote className="w-full max-w-md text-left" error={error} onRetry={() => void download()} />}
      {onRetryLan && (
        <div className="flex max-w-sm flex-col items-center gap-1.5 border-t border-white/10 pt-4">
          {lanChecking ? (
            <p className="ca-t-xs flex items-center gap-1.5 text-white/55">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {t("remoteMedia.lanChecking")}
            </p>
          ) : (
            <>
              <p className="ca-t-xs text-white/45">{t("remoteMedia.lanHint")}</p>
              <Button size="sm" variant="ghost" className="text-white/75" onClick={onRetryLan}>
                <Wifi className="h-3.5 w-3.5" />
                {t("remoteMedia.lanRetry")}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
