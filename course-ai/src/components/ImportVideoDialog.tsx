import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";

export function ImportVideoButton({ courseId }: { courseId: string }) {
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
    <div className="space-y-2">
      <Button size="sm" onClick={() => local.mutate()}>
        + 导入视频
      </Button>
      <div className="flex gap-1">
        <input
          className="min-w-0 flex-1 rounded bg-zinc-800 px-2 py-1 text-xs"
          placeholder="B站/视频 URL"
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
          {bili.isPending ? "下载中…" : "下载"}
        </Button>
      </div>
      {bili.isError && (
        <p className="text-xs text-red-400">{String(bili.error)}</p>
      )}
    </div>
  );
}
