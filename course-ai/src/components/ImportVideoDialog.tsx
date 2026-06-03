import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Download, FileVideo, Plus } from "lucide-react";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";

/** 单一「导入」入口：点开后可选「上传本地视频」或「下载网络视频（B 站 / 链接）」。 */
export function ImportVideoButton({ courseId }: { courseId: string }) {
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
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

  const network = useMutation({
    mutationFn: () => ipc.tools.importBilibili(courseId, url.trim()),
    onSuccess: () => {
      setUrl("");
      setMenuOpen(false);
      invalidate();
    },
  });

  return (
    <div className="relative flex-none">
      <Button size="sm" onClick={() => setMenuOpen((o) => !o)}>
        <Plus className="h-4 w-4" />
        导入
        <ChevronDown className="h-3.5 w-3.5 opacity-70" />
      </Button>
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1.5 w-72 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-1.5 shadow-[var(--shadow-pop)]">
            <button
              onClick={() => {
                setMenuOpen(false);
                local.mutate();
              }}
              className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-card-hover)]"
            >
              <FileVideo className="mt-0.5 h-4 w-4 flex-none text-primary" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-[var(--text-strong)]">
                  上传本地视频
                </span>
                <span className="block text-xs text-[var(--text-muted)]">
                  从电脑选择 mp4 / mkv / mov…
                </span>
              </span>
            </button>

            <div className="my-1 border-t border-[var(--border-faint)]" />

            <div className="px-2.5 py-2">
              <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-[var(--text-muted)]">
                <Download className="h-3.5 w-3.5" />
                下载网络视频
              </div>
              <div className="flex gap-1">
                <input
                  aria-label="视频链接"
                  className="min-w-0 flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2.5 py-1.5 text-xs text-[var(--text-strong)] outline-none placeholder:text-[var(--text-faint)] focus:border-primary/70"
                  placeholder="B 站 / 视频链接…"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && url.trim() && !network.isPending) {
                      network.mutate();
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!url.trim() || network.isPending}
                  onClick={() => network.mutate()}
                  title="需安装 yt-dlp；仅供个人学习使用"
                >
                  {network.isPending ? "下载中" : "下载"}
                </Button>
              </div>
              {network.isError && (
                <p className="mt-1 text-xs text-red-400">{String(network.error)}</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
