import { convertFileSrc } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";

export function SlidesPanel({ videoId }: { videoId: string }) {
  const qc = useQueryClient();
  const requestSeek = usePlayer((s) => s.requestSeek);
  const currentMs = usePlayer((s) => s.currentMs);

  const { data: slides = [] } = useQuery({
    queryKey: ["slides", videoId],
    queryFn: () => ipc.slides.list(videoId),
  });
  const { data: shots = [] } = useQuery({
    queryKey: ["screenshots", videoId],
    queryFn: () => ipc.slides.screenshots(videoId),
  });

  const extract = useMutation({
    mutationFn: () => ipc.slides.extract(videoId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slides", videoId] }),
  });
  const capture = useMutation({
    mutationFn: () => ipc.slides.capture(videoId, Math.floor(currentMs)),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["screenshots", videoId] }),
  });
  const ocr = useMutation<string, unknown, void>({
    mutationFn: () => ipc.tools.ocr(videoId, Math.floor(currentMs)),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-sm text-white/60">课件页</span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={ocr.isPending}
            onClick={() => ocr.mutate()}
            title="对当前帧整屏 OCR（需安装 tesseract）"
          >
            {ocr.isPending ? "识别中…" : "截字"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={capture.isPending}
            onClick={() => capture.mutate()}
          >
            {capture.isPending ? "截图中…" : "截当前帧"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={extract.isPending}
            onClick={() => extract.mutate()}
          >
            {extract.isPending
              ? "提取中…"
              : slides.length
                ? "重新提取"
                : "提取课件"}
          </Button>
        </div>
      </div>
      {extract.isError && (
        <p className="px-3 py-2 text-xs text-red-400">
          {String(extract.error)}
        </p>
      )}
      {ocr.isError && (
        <p className="px-3 py-2 text-xs text-red-400">{String(ocr.error)}</p>
      )}
      {ocr.data !== undefined && (
        <div className="border-b border-white/10 px-3 py-2 text-xs">
          <div className="mb-1 text-white/40">OCR 结果（点击复制）</div>
          <button
            className="block w-full whitespace-pre-wrap text-left text-white/80 hover:text-white"
            onClick={() => void navigator.clipboard.writeText(ocr.data ?? "")}
          >
            {ocr.data || "（未识别到文字）"}
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-3">
        {slides.length === 0 ? (
          <p className="text-sm text-white/40">
            还没有课件页，点右上角「提取课件」（基于画面切换检测）。
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {slides.map((s) => (
              <button
                key={s.id}
                onClick={() => requestSeek(s.start_ms)}
                className="group overflow-hidden rounded border border-white/10 text-left hover:border-primary"
              >
                <img
                  src={convertFileSrc(s.image_path)}
                  alt={`page ${s.page_no}`}
                  className="aspect-video w-full object-cover"
                />
                <div className="px-2 py-1 text-xs text-white/50">
                  P{s.page_no + 1} · {formatMs(s.start_ms)}
                </div>
              </button>
            ))}
          </div>
        )}

        {shots.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 text-xs text-white/40">我的截图</div>
            <div className="flex gap-2 overflow-x-auto">
              {shots.map((sh) => (
                <button
                  key={sh.id}
                  onClick={() => requestSeek(sh.at_ms)}
                  className="shrink-0"
                  title={formatMs(sh.at_ms)}
                >
                  <img
                    src={convertFileSrc(sh.image_path)}
                    alt={`shot ${sh.at_ms}`}
                    className="h-16 rounded border border-white/10 hover:border-primary"
                  />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
