import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
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

// 灵敏度(0~100)→ 亮度差阈值。灵敏度越高、阈值越低、抓的页越多。
function sensitivityToThreshold(sensitivity: number) {
  return Math.round(8 + ((100 - sensitivity) / 100) * 42); // 灵敏度100→8，0→50
}

export function SlidesPanel({ videoId }: { videoId: string }) {
  const qc = useQueryClient();
  const requestSeek = usePlayer((s) => s.requestSeek);
  const currentMs = usePlayer((s) => s.currentMs);
  const [sensitivity, setSensitivity] = useState(() => {
    const saved = Number(localStorage.getItem("slides-sensitivity"));
    return Number.isFinite(saved) && saved > 0 ? saved : 50;
  });
  const threshold = sensitivityToThreshold(sensitivity);

  function changeSensitivity(value: number) {
    setSensitivity(value);
    localStorage.setItem("slides-sensitivity", String(value));
  }

  const { data: slides = [] } = useQuery({
    queryKey: ["slides", videoId],
    queryFn: () => ipc.slides.list(videoId),
  });
  const { data: shots = [] } = useQuery({
    queryKey: ["screenshots", videoId],
    queryFn: () => ipc.slides.screenshots(videoId),
  });

  const extract = useMutation({
    mutationFn: () => ipc.slides.extract(videoId, threshold),
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
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2">
        <span className="text-sm text-[var(--text-muted)]">课件页</span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={ocr.isPending}
            onClick={() => ocr.mutate()}
            title="对当前帧整屏 OCR（引擎在设置里选择：本地 Tesseract 或 阿里云 OCR）"
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
      <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-muted)]">
        <span className="whitespace-nowrap">灵敏度</span>
        <span className="text-[var(--text-faint)]">低</span>
        <input
          aria-label="课件提取灵敏度"
          type="range"
          min={0}
          max={100}
          step={5}
          value={sensitivity}
          onChange={(event) => changeSensitivity(Number(event.target.value))}
          className="h-1 flex-1 accent-primary"
          title={`差异阈值 ${threshold}（越低越敏感）`}
        />
        <span className="text-[var(--text-faint)]">高</span>
        <span className="w-14 text-right text-[var(--text-faint)]">阈值 {threshold}</span>
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
        <div className="border-b border-[var(--border-subtle)] px-3 py-2 text-xs">
          <div className="mb-1 text-[var(--text-faint)]">OCR 结果（点击复制）</div>
          <button
            className="block w-full whitespace-pre-wrap text-left text-[var(--text-normal)] hover:text-[var(--text-strong)]"
            onClick={() => void navigator.clipboard.writeText(ocr.data ?? "")}
          >
            {ocr.data || "（未识别到文字）"}
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-3">
        {slides.length === 0 ? (
          <p className="text-sm text-[var(--text-faint)]">
            还没有课件页，点右上角「提取课件」（按画面亮度变化自动识别换页）。
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {slides.map((s) => (
              <button
                key={s.id}
                onClick={() => requestSeek(s.start_ms)}
                className="group overflow-hidden rounded border border-[var(--border-subtle)] text-left hover:border-primary"
              >
                <SlideImage
                  videoId={videoId}
                  imagePath={s.image_path}
                  alt={`page ${s.page_no}`}
                  className="aspect-video w-full object-cover"
                />
                <div className="px-2 py-1 text-xs text-[var(--text-muted)]">
                  P{s.page_no + 1} · {formatMs(s.start_ms)}
                </div>
              </button>
            ))}
          </div>
        )}

        {shots.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 text-xs text-[var(--text-faint)]">我的截图</div>
            <div className="flex gap-2 overflow-x-auto">
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
                    className="h-16 rounded border border-[var(--border-subtle)] hover:border-primary"
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
