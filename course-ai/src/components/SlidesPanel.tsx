import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Images, ScanText, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { ipc, type SlidesOcrProgress, type SlidesProgress } from "@/lib/ipc";
import { SlideImage } from "@/components/SlideImage";
import { formatMs } from "@/lib/time";
import { getSlidesSensitivity, sensitivityToThreshold } from "@/lib/slides";
import { usePlayer } from "@/stores/player";

/**
 * 提取进度的按钮文案。采样阶段是"通读整段视频"，一节 90 分钟的课要好几分钟，
 * 只写「提取中…」等于让人干等；拿不到时长时退化成不确定态。
 */
function progressLabel(progress: SlidesProgress | null): string {
  if (!progress) return "提取中…";
  if (progress.phase === "capture") return `截图 ${progress.done}/${progress.total}`;
  if (progress.total > 0) {
    return `采样 ${Math.min(99, Math.round((progress.done / progress.total) * 100))}%`;
  }
  return "采样中…";
}

export function SlidesPanel({ videoId }: { videoId: string }) {
  const qc = useQueryClient();
  const requestSeek = usePlayer((s) => s.requestSeek);
  // 不订阅 currentMs（避免播放时每秒 4 次重渲染）；点「截图/OCR」时按需读取当前进度。
  const currentMs = () => usePlayer.getState().currentMs;

  const { data: slides = [] } = useQuery({
    queryKey: ["slides", videoId],
    queryFn: () => ipc.slides.list(videoId),
  });
  const { data: shots = [] } = useQuery({
    queryKey: ["screenshots", videoId],
    queryFn: () => ipc.slides.screenshots(videoId),
  });

  // 进行中那次提取的进度与 requestId（供「停止」定位后台任务）。
  const [progress, setProgress] = useState<SlidesProgress | null>(null);
  const extractRequest = useRef<string | null>(null);
  // 课件页文字识别的进度与 requestId。导入时会自动认一遍，这里是补跑/换引擎重认的入口。
  const [pagesOcrProgress, setPagesOcrProgress] = useState<SlidesOcrProgress | null>(null);
  const pagesOcrRequest = useRef<string | null>(null);

  const extract = useMutation({
    // 灵敏度在「设置 → 课件提取」里调，这里取当前值换算成门槛（"自动"档为 null）。
    mutationFn: () => {
      const requestId = crypto.randomUUID();
      extractRequest.current = requestId;
      setProgress(null);
      return ipc.slides.extract(
        videoId,
        sensitivityToThreshold(getSlidesSensitivity()),
        requestId,
        setProgress,
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slides", videoId] }),
    onSettled: () => {
      extractRequest.current = null;
      setProgress(null);
    },
  });
  const capture = useMutation({
    mutationFn: () => ipc.slides.capture(videoId, Math.floor(currentMs())),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["screenshots", videoId] }),
  });
  const ocr = useMutation<string, unknown, void>({
    mutationFn: () => ipc.tools.ocr(videoId, Math.floor(currentMs())),
  });
  // 整批认课件页上的文字。默认只认还没认过的页；按住 shift 点则全部重认（换了引擎时用）。
  const pagesOcr = useMutation<number, unknown, boolean>({
    mutationFn: (force: boolean) => {
      const requestId = crypto.randomUUID();
      pagesOcrRequest.current = requestId;
      setPagesOcrProgress(null);
      return ipc.slides.ocr(videoId, requestId, force, setPagesOcrProgress);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slides", videoId] }),
    onSettled: () => {
      pagesOcrRequest.current = null;
      setPagesOcrProgress(null);
    },
  });
  const pagesWithText = slides.filter((slide) => (slide.ocr_text ?? "").trim() !== "").length;
  // OCR 结果复制成功的短暂反馈（1.5s）。
  const [copied, setCopied] = useState(false);
  async function copyOcrResult() {
    // clipboard 可能不可用（权限受限等）：静默降级，不显示假的成功。
    try {
      await navigator.clipboard.writeText(ocr.data ?? "");
    } catch {
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex h-full flex-col">
      {/* 学习面板可以被拖得很窄。这一行原来是单行不换行的，一窄就把最右边的
          「提取课件 / 重新提取」挤出可视区——而那正是这个面板唯一的主操作，
          用户根本点不到。改成允许换行：标题占一行，按钮不够宽就自己折下去。 */}
      <div className="flex flex-none flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-b border-[var(--border-subtle)] px-3 py-2.5">
        <span className="flex-none text-sm font-medium text-[var(--text-strong)]">课件页</span>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {slides.length > 0 &&
            (pagesOcr.isPending ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const requestId = pagesOcrRequest.current;
                  if (requestId) void ipc.slides.cancelOcr(requestId);
                }}
                title="停止识别（已认出文字的页留着，下次接着认）"
              >
                <Square className="h-3 w-3" />
                {pagesOcrProgress
                  ? `识别 ${pagesOcrProgress.done}/${pagesOcrProgress.total}`
                  : "识别中…"}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={(event) => pagesOcr.mutate(event.shiftKey)}
                title={
                  pagesWithText === slides.length
                    ? "所有页都认过了。按住 Shift 点可全部重认（换了 OCR 引擎时用）"
                    : `识别课件页上的文字（还有 ${slides.length - pagesWithText} 页没认）。按住 Shift 点可全部重认`
                }
              >
                <ScanText className="h-3.5 w-3.5" />
                {pagesWithText === slides.length ? "重认文字" : "识别文字"}
              </Button>
            ))}
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
          {extract.isPending && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const requestId = extractRequest.current;
                if (requestId) void ipc.slides.cancelExtract(requestId);
              }}
              title="停止提取（库里已有的课件页不会被清掉）"
            >
              <Square className="h-3 w-3" />
              停止
            </Button>
          )}
          <Button
            size="sm"
            disabled={extract.isPending}
            onClick={() => extract.mutate()}
            title="按画面变化自动识别换页（灵敏度在设置里调）"
          >
            <Images className="h-3.5 w-3.5" />
            {extract.isPending
              ? progressLabel(progress)
              : slides.length
                ? "重新提取"
                : "提取课件"}
          </Button>
        </div>
      </div>

      {pagesOcr.isError && (
        <ErrorNote
          className="mx-3 mb-2 flex-none"
          error={pagesOcr.error}
          onRetry={() => pagesOcr.mutate(false)}
        />
      )}
      {extract.isError && (
        <ErrorNote
          className="mx-3 mb-2 flex-none"
          error={extract.error}
          onRetry={() => extract.mutate()}
        />
      )}
      {ocr.isError && (
        <ErrorNote
          className="mx-3 mb-2 flex-none"
          error={ocr.error}
          onRetry={() => ocr.mutate()}
        />
      )}
      {ocr.data !== undefined && (
        <div className="flex-none border-b border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 text-xs">
          <div className="mb-1 flex items-center justify-between">
            <span className="flex items-center gap-2 font-medium text-[var(--text-muted)]">
              OCR 结果（点击复制）
              {copied && (
                <span className="inline-flex items-center rounded-full bg-[var(--status-ok-bg)] px-1.5 py-0.5 font-medium text-[var(--status-ok)]">
                  已复制
                </span>
              )}
            </span>
            <button
              aria-label="关闭 OCR 结果"
              title="关闭"
              onClick={() => ocr.reset()}
              className="ca-touch-44 ca-workbench-touch grid h-9 w-9 place-items-center rounded text-[var(--text-muted)] transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <button
            className="block max-h-40 w-full overflow-y-auto whitespace-pre-wrap text-left text-[var(--text-normal)] hover:text-[var(--text-strong)]"
            onClick={() => void copyOcrResult()}
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
