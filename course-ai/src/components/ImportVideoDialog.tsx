import {
  AlertCircle,
  ChevronDown,
  Download,
  FileVideo,
  FolderInput,
  ListVideo,
  Plus,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { humanizeError } from "@/lib/errors";
import { ipc, type FolderVideo } from "@/lib/ipc";
import { pickDirectoryPath, pickPersistedFile } from "@/lib/mobileFiles";
import { isMobile } from "@/lib/platform";
import type { Video } from "@/lib/types";

// 按需懒加载：下载向导只在用户点击时才需要，避免把它（及 plugin-dialog 等）压进首屏 eager 包。
const BilibiliImportDialog = lazy(() =>
  import("./BilibiliImportDialog").then((m) => ({ default: m.BilibiliImportDialog })),
);
const FolderImportDialog = lazy(() =>
  import("./FolderImportDialog").then((m) => ({ default: m.FolderImportDialog })),
);
const PlaylistImportDialog = lazy(() =>
  import("./PlaylistImportDialog").then((m) => ({ default: m.PlaylistImportDialog })),
);

/** 单一「导入」入口：点开后可选「上传本地视频」或「下载网络视频（B 站 / 链接）」。 */
export function ImportVideoButton({
  courseId,
  onStartProcessing,
}: {
  courseId: string;
  onStartProcessing?: (video: Video) => void;
}) {
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showBili, setShowBili] = useState(false);
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [folderVideos, setFolderVideos] = useState<FolderVideo[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  // 移动端无 yt-dlp sidecar / 无法扫描任意文件夹，隐藏「下载网络视频」「导入整个文件夹」入口。
  const mobile = isMobile();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["videos", courseId] });

  // 选一个文件夹 → 扫描其中的视频 → 打开勾选清单批量导入。
  const folder = useMutation({
    mutationFn: async () => {
      setImportError(null);
      const dir = await pickDirectoryPath();
      if (!dir) return null;
      return ipc.videos.scanFolder(dir);
    },
    onSuccess: (videos) => {
      if (videos == null) return; // 用户取消了选目录
      if (videos.length === 0) {
        setImportError("该文件夹里没有可导入的视频");
        return;
      }
      setFolderVideos(videos);
    },
    onError: (error) => setImportError(humanizeError(error)),
  });

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
      <Button
        size="sm"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
      >
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
              <button
                onClick={() => {
                  setMenuOpen(false);
                  folder.mutate();
                }}
                className="ca-touch-44 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-card-hover)]"
              >
                <FolderInput className="mt-0.5 h-4 w-4 flex-none text-primary" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-[var(--text-strong)]">
                    导入整个文件夹
                  </span>
                  <span className="block text-xs text-[var(--text-muted)]">
                    批量导入一个文件夹里的所有视频
                  </span>
                </span>
              </button>
            )}

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
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setShowPlaylist(true);
                  }}
                  className="ca-touch-44 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-card-hover)]"
                >
                  <ListVideo className="mt-0.5 h-4 w-4 flex-none text-primary" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-[var(--text-strong)]">
                      导入播放列表 / 合集
                    </span>
                    <span className="block text-xs text-[var(--text-muted)]">
                      B 站合集·多 P / 播放列表，批量下载
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
          <BilibiliImportDialog
            courseId={courseId}
            onClose={() => setShowBili(false)}
            onStartProcessing={onStartProcessing}
          />
        </Suspense>
      )}
      {folderVideos && (
        <Suspense fallback={null}>
          <FolderImportDialog
            courseId={courseId}
            videos={folderVideos}
            onClose={() => setFolderVideos(null)}
          />
        </Suspense>
      )}
      {showPlaylist && (
        <Suspense fallback={null}>
          <PlaylistImportDialog
            courseId={courseId}
            onClose={() => setShowPlaylist(false)}
            onStartProcessing={onStartProcessing}
          />
        </Suspense>
      )}
      {importError && (
        // 语义错误色（主题感知），不再用硬编码 tailwind 红。importError 已是人话，
        // 这里直接展示、保留「导入失败：」前缀，不再过一遍 humanizeError（会吞掉前缀）。
        <div
          role="alert"
          className="absolute right-0 top-full z-20 mt-2 flex w-72 max-w-[calc(100vw-2rem)] items-start gap-2 rounded-lg bg-[var(--status-err-bg)] px-3 py-2 text-xs leading-relaxed text-[var(--status-err)] shadow-[var(--shadow-pop)]"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-none" />
          <span className="min-w-0 break-words">导入失败：{importError}</span>
        </div>
      )}
    </div>
  );
}
