import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Images, ScanText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { getSlidesSensitivity, sensitivityToThreshold } from "@/lib/slides";
import { usePlayer } from "@/stores/player";

function SlideImage({
  videoId,
  imagePath,
  alt,
  className,
}: {
  videoId: string;
  imagePath: string;
  alt: string;
  className: string;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setSrc(null);
    ipc.slides
      .image(videoId, imagePath)
      .then((bytes) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }),
        );
        setSrc(objectUrl);
      })
      .catch(() => {
        if (active) setSrc(null);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imagePath, videoId]);

  if (!src) {
    return <div aria-label={alt} className={`${className} bg-[var(--surface-card)]`} />;
  }

  return <img src={src} alt={alt} className={className} />;
}

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
    // 灵敏度在「设置 → 课件提取」里调，这里取当前值换算成阈值。
    mutationFn: () =>
      ipc.slides.extract(videoId, sensitivityToThreshold(getSlidesSensitivity())),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slides", videoId] }),
  });
  const capture = useMutation({
    mutationFn: () => ipc.slides.capture(videoId, Math.floor(currentMs)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["screenshots", videoId] }),
  });
  const ocr = useMutation<string, unknown, void>({
    mutationFn: () => ipc.tools.ocr(videoId, Math.floor(currentMs)),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-none items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2.5">
        <span className="text-sm font-medium text-[var(--text-strong)]">课件页</span>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={ocr.isPending}
            onClick={() => ocr.mutate()}
            title="对当前帧整屏 OCR（引擎在设置里选择：本地 Tesseract 或 阿里云 OCR）"
          >
            <ScanText className="h-3.5 w-3.5" />
            {ocr.isPending ? "识别中…" : "截图OCR"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={capture.isPending}
            onClick={() => capture.mutate()}
            title="把当前帧存为截图"
          >
            <Camera className="h-3.5 w-3.5" />
            {capture.isPending ? "截图中…" : "截图"}
          </Button>
          <Button
            size="sm"
            disabled={extract.isPending}
            onClick={() => extract.mutate()}
            title="按画面变化自动识别换页（灵敏度在设置里调）"
          >
            <Images className="h-3.5 w-3.5" />
            {extract.isPending ? "提取中…" : slides.length ? "重新提取" : "提取课件"}
          </Button>
        </div>
      </div>

      {extract.isError && (
        <p className="flex-none px-3 py-2 text-xs text-red-400">
          {String(extract.error)}
        </p>
      )}
      {ocr.isError && (
        <p className="flex-none px-3 py-2 text-xs text-red-400">{String(ocr.error)}</p>
      )}
      {ocr.data !== undefined && (
        <div className="flex-none border-b border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 text-xs">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-medium text-[var(--text-muted)]">
              OCR 结果（点击复制）
            </span>
            <button
              aria-label="关闭 OCR 结果"
              title="关闭"
              onClick={() => ocr.reset()}
              className="grid h-5 w-5 place-items-center rounded text-[var(--text-muted)] transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <button
            className="block max-h-40 w-full overflow-y-auto whitespace-pre-wrap text-left text-[var(--text-normal)] hover:text-[var(--text-strong)]"
            onClick={() => void navigator.clipboard.writeText(ocr.data ?? "")}
          >
            {ocr.data || "（未识别到文字）"}
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {slides.length === 0 ? (
          <div className="flex h-full min-h-[220px] items-center justify-center">
            <div className="max-w-xs text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--border-faint)] bg-[var(--surface-card)] text-primary">
                <Images className="h-6 w-6" />
              </div>
              <p className="text-sm text-[var(--text-muted)]">
                还没有课件页。点右上角「提取课件」按画面变化自动识别换页，
                或用「截图」「截图OCR」单独抓取当前帧。
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2.5">
            {slides.map((s) => (
              <button
                key={s.id}
                onClick={() => requestSeek(s.start_ms)}
                className="group overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] text-left transition hover:border-primary hover:shadow-[var(--shadow-card)]"
              >
                <SlideImage
                  videoId={videoId}
                  imagePath={s.image_path}
                  alt={`page ${s.page_no}`}
                  className="aspect-video w-full object-cover"
                />
                <div className="flex items-center justify-between px-2 py-1.5 text-xs text-[var(--text-muted)]">
                  <span className="font-medium text-[var(--text-normal)]">
                    P{s.page_no + 1}
                  </span>
                  <span>{formatMs(s.start_ms)}</span>
                </div>
              </button>
            ))}
          </div>
        )}

        {shots.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 text-xs font-medium text-[var(--text-muted)]">
              我的截图
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {shots.map((sh) => (
                <button
                  key={sh.id}
                  onClick={() => requestSeek(sh.at_ms)}
                  className="shrink-0"
                  title={formatMs(sh.at_ms)}
                >
                  <SlideImage
                    videoId={videoId}
                    imagePath={sh.image_path}
                    alt={`shot ${sh.at_ms}`}
                    className="h-16 rounded-lg border border-[var(--border-subtle)] hover:border-primary"
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
