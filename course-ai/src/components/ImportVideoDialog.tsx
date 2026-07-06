import { ChevronDown, Download, FileVideo, Plus } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { humanizeError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import { pickPersistedFile } from "@/lib/mobileFiles";
import { isMobile } from "@/lib/platform";

// 按需懒加载：下载向导只在用户点击时才需要，避免把它（及 plugin-dialog 等）压进首屏 eager 包。
const BilibiliImportDialog = lazy(() =>
  import("./BilibiliImportDialog").then((m) => ({ default: m.BilibiliImportDialog })),
);

/** 单一「导入」入口：点开后可选「上传本地视频」或「下载网络视频（B 站 / 链接）」。 */
export function ImportVideoButton({ courseId }: { courseId: string }) {
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showBili, setShowBili] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  // 移动端无 yt-dlp sidecar，隐藏「下载网络视频」入口。
  const mobile = isMobile();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["videos", courseId] });

  const local = useMutation({
    mutationFn: async () => {
      setImportError(null);
      const persisted = await pickPersistedFile({
        category: "videos",
        fallbackName: "video.mp4",
        filters: [
          { name: "Video", extensions: ["mp4", "mkv", "mov", "webm", "m4v"] },
        ],
        prompt: "选择本地视频",
      });
      if (!persisted) return null;
      return ipc.videos.addLocal(courseId, persisted.path, persisted.durationMs);
    },
    onSuccess: () => {
      setImportError(null);
      invalidate();
    },
    onError: (error) => {
      setImportError(humanizeError(error));
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
              className="ca-touch-44 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-card-hover)]"
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

            {!mobile && (
              <>
                <div className="my-1 border-t border-[var(--border-faint)]" />
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setShowBili(true);
                  }}
                  className="ca-touch-44 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-card-hover)]"
                >
                  <Download className="mt-0.5 h-4 w-4 flex-none text-primary" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-[var(--text-strong)]">
                      下载网络视频
                    </span>
                    <span className="block text-xs text-[var(--text-muted)]">
                      B 站 / 链接，可选清晰度与自带字幕
                    </span>
                  </span>
                </button>
              </>
            )}
          </div>
        </>
      )}
      {showBili && (
        <Suspense fallback={null}>
          <BilibiliImportDialog courseId={courseId} onClose={() => setShowBili(false)} />
        </Suspense>
      )}
      {importError && (
        <div
          role="alert"
          className="absolute right-0 top-full z-20 mt-2 max-w-80 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 shadow-[var(--shadow-pop)]"
        >
          导入失败：{importError}
        </div>
      )}
    </div>
  );
}
