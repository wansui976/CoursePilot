import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { HardDriveDownload, Loader2, Wifi } from "lucide-react";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { ipc, type LanDownloadEvent } from "@/lib/ipc";
import type { Video } from "@/lib/types";

/**
 * 正在从局域网里那台电脑串流：播放器上方一条，可以整段存到本机。
 * 下到的就是刚在播的那一份（电脑转过码时就是转好的 H.264），存下来以后断网也能看。
 */
export function LanDownloadBar({ video }: { video: Video }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<{ downloaded: number; total: number } | null>(null);

  useEffect(() => {
    const unlisten = listen<LanDownloadEvent>("lan-share:download", (event) => {
      if (event.payload.videoId !== video.id || event.payload.done) return;
      setProgress({ downloaded: event.payload.downloaded, total: event.payload.total });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [video.id]);

  const download = useMutation({
    mutationFn: () => ipc.lanShare.downloadVideo(video.id),
    onSuccess: async () => {
      // 文件挂上了：视频条目、播放地址都换掉，工作台换成本地播放。
      await queryClient.invalidateQueries();
    },
    onSettled: () => setProgress(null),
  });

  const percent =
    progress && progress.total > 0 ? Math.min(100, Math.floor((progress.downloaded / progress.total) * 100)) : 0;

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[var(--text-muted)]">
      <Wifi className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
      <span className="ca-t-xs min-w-0 flex-1 truncate">{t("lanShare.downloadHint")}</span>
      <Button size="sm" variant="ghost" disabled={download.isPending} onClick={() => download.mutate()}>
        {download.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <HardDriveDownload className="h-3.5 w-3.5" />
        )}
        {download.isPending
          ? progress
            ? t("lanShare.downloading", { percent })
            : t("lanShare.preparing")
          : t("lanShare.downloadLocal")}
      </Button>
      {download.error != null && <ErrorNote className="w-full" error={download.error} />}
    </div>
  );
}
