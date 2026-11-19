import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { CloudDownload, Loader2 } from "lucide-react";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { ipc, type WebDavDownloadEvent } from "@/lib/ipc";
import type { Video } from "@/lib/types";

/**
 * 「在线看」导入的网盘视频正在从网盘边下边播：播放器上方一条，可以下载到本机。
 * 下完视频就有了本地文件，识别字幕、截图这些都能用了。
 */
export function DriveDownloadBar({ video }: { video: Video }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null } | null>(null);

  useEffect(() => {
    const unlisten = listen<WebDavDownloadEvent>("webdav-import:download", (event) => {
      if (event.payload.videoId !== video.id || event.payload.done) return;
      setProgress({ downloaded: event.payload.downloaded, total: event.payload.total });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [video.id]);

  const download = useMutation({
    mutationFn: () => ipc.webdavImport.downloadVideo(video.id),
    onSuccess: async () => {
      // 有了本地文件：视频条目、播放地址都换掉，工作台换成本地播放。
      await queryClient.invalidateQueries();
    },
    onSettled: () => setProgress(null),
  });

  const percent =
    progress && progress.total ? Math.min(100, Math.floor((progress.downloaded / progress.total) * 100)) : 0;

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[var(--text-muted)]">
      <CloudDownload className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
      <span className="ca-t-xs min-w-0 flex-1">{t("webdavImport.modes.stream")}</span>
      <Button size="sm" variant="ghost" disabled={download.isPending} onClick={() => download.mutate()}>
        {download.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {download.isPending ? t("webdavImport.downloading", { percent }) : t("webdavImport.downloadLocal")}
      </Button>
      {download.error != null && <ErrorNote className="w-full" error={download.error} />}
    </div>
  );
}
