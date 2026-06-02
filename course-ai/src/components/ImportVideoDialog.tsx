import { open } from "@tauri-apps/plugin-dialog";
import { Download, FileVideo } from "lucide-react";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";

export function ImportVideoButton({
  courseId,
  showLinkImport = true,
}: {
  courseId: string;
  showLinkImport?: boolean;
}) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["videos", courseId] });

  const local = useMutation({
    mutationFn: async () => {
      const file = await open({
        directory: false,
        multiple: false,
        filters: [
          { name: "Video", extensions: ["mp4", "mkv", "mov", "webm", "m4v"] },
        ],
      });
      if (!file || Array.isArray(file)) return null;
      return ipc.videos.addLocal(courseId, file);
    },
    onSuccess: invalidate,
  });

  const bili = useMutation({
    mutationFn: () => ipc.tools.importBilibili(courseId, url.trim()),
    onSuccess: () => {
      setUrl("");
      invalidate();
    },
  });

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Button
        className="flex-none"
        size="sm"
        onClick={() => local.mutate()}
      >
        <FileVideo className="h-4 w-4" />
        导入本地视频
      </Button>
      {showLinkImport && (
        <div className="flex min-w-[220px] flex-1 gap-1">
          <input
            aria-label="视频链接"
            className="min-w-0 flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-1.5 text-xs text-[var(--text-strong)] outline-none placeholder:text-[var(--text-faint)] focus:border-primary/70"
            placeholder="B 站 / 视频链接…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!url.trim() || bili.isPending}
            onClick={() => bili.mutate()}
            title="需安装 yt-dlp；仅供个人学习使用"
          >
            <Download className="h-3.5 w-3.5" />
            {bili.isPending ? "下载中" : "下载"}
          </Button>
        </div>
      )}
      {showLinkImport && bili.isError && (
        <p className="basis-full text-xs text-red-400">{String(bili.error)}</p>
      )}
    </div>
  );
}
