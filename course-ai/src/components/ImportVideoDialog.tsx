import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Download, FileVideo, Plus } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";

// 按需懒加载：下载向导只在用户点击时才需要，避免把它（及 plugin-dialog 等）压进首屏 eager 包。
const BilibiliImportDialog = lazy(() =>
  import("./BilibiliImportDialog").then((m) => ({ default: m.BilibiliImportDialog })),
);

/** 单一「导入」入口：点开后可选「上传本地视频」或「下载网络视频（B 站 / 链接）」。 */
export function ImportVideoButton({ courseId }: { courseId: string }) {
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showBili, setShowBili] = useState(false);
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

            <button
              onClick={() => {
                setMenuOpen(false);
                setShowBili(true);
              }}
              className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-card-hover)]"
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
          </div>
        </>
      )}
      {showBili && (
        <Suspense fallback={null}>
          <BilibiliImportDialog courseId={courseId} onClose={() => setShowBili(false)} />
        </Suspense>
      )}
    </div>
  );
}
