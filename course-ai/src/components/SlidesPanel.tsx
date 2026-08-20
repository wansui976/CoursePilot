import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { Camera, Images, ScanText, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PanelEmptyState } from "@/components/ui/empty-state";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { TextSkeleton } from "@/components/ui/skeleton";
import { humanizeError } from "@/lib/errors";
import {
  ipc,
  type SlidesOcrOutcome,
  type SlidesOcrProgress,
  type SlidesProgress,
} from "@/lib/ipc";
import { SlideImage } from "@/components/SlideImage";
import { formatMs } from "@/lib/time";
import { getSlidesSensitivity, sensitivityToThreshold } from "@/lib/slides";
import { silenceSkipQueryKey } from "@/lib/silenceSkip";
import { usePlayer } from "@/stores/player";

/**
 * 提取进度的按钮文案。采样阶段是"通读整段视频"，一节 90 分钟的课要好几分钟，
 * 只写「提取中…」等于让人干等；拿不到时长时退化成不确定态。
 */
function progressLabel(progress: SlidesProgress | null, t: TFunction): string {
  if (!progress) return t("slides.extracting");
  if (progress.phase === "capture") return t("slides.captureProgress", { done: progress.done, total: progress.total });
  if (progress.total > 0) {
    return t("slides.samplingPercent", { percent: Math.min(99, Math.round((progress.done / progress.total) * 100)) });
  }
  return t("slides.sampling");
}

/**
 * 一次批量识别结束后说什么。
 *
 * 三件事必须分得开：中途叫停、部分失败、正常跑完。原来只有一句「已识别 N 页」，
 * 按下停止是它，额度耗尽后 90 页全挂也是它——用户没有任何线索。
 */
function ocrFeedbackText(outcome: SlidesOcrOutcome, t: TFunction): string {
  if (outcome.canceled) return t("slides.stoppedRecognized", { count: outcome.recognized });
  if (outcome.stoppedEarly) {
    const remaining = Math.max(0, outcome.total - outcome.attempted);
    const reason = outcome.error ? `：${humanizeError(outcome.error)}` : "";
    return t("slides.ocrPartialStop", { attempted: outcome.attempted, total: outcome.total, remaining, reason });
  }
  if (outcome.failed > 0) {
    const reason = outcome.error ? `：${humanizeError(outcome.error)}` : "";
    return t("slides.ocrPartialFail", { recognized: outcome.recognized, failed: outcome.failed, reason });
  }
  return outcome.recognized > 0 ? t("slides.recognized", { count: outcome.recognized }) : t("slides.ocrNoText");
}

type SlidesOperation = "extract" | "pages-ocr" | "capture" | "frame-ocr";
type RequestOperation = { requestId: string };
type PagesOcrRequest = RequestOperation & { force: boolean };
type FrameRequest = { atMs: number };

type OperationSnapshot<TData, TVariables> = {
  status: "idle" | "pending" | "error" | "success";
  submittedAt: number;
  data: TData | undefined;
  error: unknown;
  variables: TVariables | undefined;
};

function operationKey(videoId: string, operation: SlidesOperation) {
  return ["slides-panel", videoId, operation] as const;
}

/**
 * useMutation 的 observer 会随面板卸载而消失，但 MutationCache 中的任务仍在运行。
 * 从 cache 取同一视频、同一操作最近一次状态，让二级页切走再回来不会误回 idle。
 */
function useLatestOperation<TData, TVariables>(
  mutationKey: ReturnType<typeof operationKey>,
): OperationSnapshot<TData, TVariables> | undefined {
  const snapshots = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => ({
      status: mutation.state.status,
      submittedAt: mutation.state.submittedAt,
      data: mutation.state.data as TData | undefined,
      error: mutation.state.error,
      variables: mutation.state.variables as TVariables | undefined,
    }),
  });
  return snapshots.reduce<OperationSnapshot<TData, TVariables> | undefined>(
    (latest, snapshot) =>
      !latest || snapshot.submittedAt >= latest.submittedAt ? snapshot : latest,
    undefined,
  );
}

export function SlidesPanel({ videoId }: { videoId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const requestSeek = usePlayer((s) => s.requestSeek);
  // 不订阅 currentMs（避免播放时每秒 4 次重渲染）；点「截图/OCR」时按需读取当前进度。
  const currentMs = () => usePlayer.getState().currentMs;

  const slidesQuery = useQuery({
    queryKey: ["slides", videoId],
    queryFn: () => ipc.slides.list(videoId),
  });
  const shotsQuery = useQuery({
    queryKey: ["screenshots", videoId],
    queryFn: () => ipc.slides.screenshots(videoId),
  });
  const slides = slidesQuery.data ?? [];
  const shots = shotsQuery.data ?? [];

  const extractKey = operationKey(videoId, "extract");
  const pagesOcrKey = operationKey(videoId, "pages-ocr");
  const captureKey = operationKey(videoId, "capture");
  const frameOcrKey = operationKey(videoId, "frame-ocr");

  const extractState = useLatestOperation<number, RequestOperation>(extractKey);
  const pagesOcrState = useLatestOperation<SlidesOcrOutcome, PagesOcrRequest>(pagesOcrKey);
  const captureState = useLatestOperation<unknown, FrameRequest>(captureKey);
  const frameOcrState = useLatestOperation<string, FrameRequest>(frameOcrKey);

  const extractPending = extractState?.status === "pending";
  const pagesOcrPending = pagesOcrState?.status === "pending";
  const capturePending = captureState?.status === "pending";
  const frameOcrPending = frameOcrState?.status === "pending";

  // 进行中那次提取的进度与 requestId（供「停止」定位后台任务）。
  const [progress, setProgress] = useState<SlidesProgress | null>(null);
  const extractRequest = useRef<string | null>(null);
  // 课件页文字识别的进度与 requestId。导入时会自动认一遍，这里是补跑/换引擎重认的入口。
  const [pagesOcrProgress, setPagesOcrProgress] = useState<SlidesOcrProgress | null>(null);
  const startingOperations = useRef(new Set<SlidesOperation>());

  const extract = useMutation<number, unknown, RequestOperation>({
    mutationKey: extractKey,
    // 灵敏度在「设置 → 课件提取」里调，这里取当前值换算成门槛（"自动"档为 null）。
    mutationFn: ({ requestId }) => {
      extractRequest.current = requestId;
      setProgress(null);
      return ipc.slides.extract(
        videoId,
        sensitivityToThreshold(getSlidesSensitivity()),
        requestId,
        setProgress,
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["slides", videoId] });
      void qc.invalidateQueries({ queryKey: silenceSkipQueryKey(videoId) });
    },
    onSettled: () => {
      extractRequest.current = null;
      setProgress(null);
    },
  });
  const capture = useMutation<unknown, unknown, FrameRequest>({
    mutationKey: captureKey,
    mutationFn: ({ atMs }) => ipc.slides.capture(videoId, atMs),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["screenshots", videoId] }),
  });
  const ocr = useMutation<string, unknown, FrameRequest>({
    mutationKey: frameOcrKey,
    mutationFn: ({ atMs }) => ipc.tools.ocr(videoId, atMs),
  });
  // 整批认课件页上的文字。默认只认还没认过的页；按住 shift 点则全部重认（换了引擎时用）。
  const pagesOcr = useMutation<SlidesOcrOutcome, unknown, PagesOcrRequest>({
    mutationKey: pagesOcrKey,
    mutationFn: ({ force, requestId }) => {
      setPagesOcrProgress(null);
      return ipc.slides.ocr(videoId, requestId, force, setPagesOcrProgress);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["slides", videoId] });
      setPagesOcrProgress(null);
    },
  });
  // 「还没认过」是 ocr_text 为 null；认过但没认出可用文字的页记的是空串。
  // 按「有没有文字」来数的话，纯图页、封面页会永远算在「还没认」里，重认按钮永远出不来，
  // 而且每次重跑都要把它们再认一遍（云端 OCR 就是重复付费）。
  const pending = slides.filter((slide) => slide.ocr_text === null).length;
  // OCR 结果复制成功的短暂反馈（1.5s）。
  const [copied, setCopied] = useState(false);
  async function copyOcrResult() {
    // clipboard 可能不可用（权限受限等）：静默降级，不显示假的成功。
    try {
      await navigator.clipboard.writeText(ocrResult ?? "");
    } catch {
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function startOnce(operation: SlidesOperation, start: () => void) {
    if (startingOperations.current.has(operation)) return;
    startingOperations.current.add(operation);
    start();
  }

  function releaseStart(operation: SlidesOperation) {
    startingOperations.current.delete(operation);
  }

  function startExtract() {
    if (slidesQuery.isPending || slidesQuery.isError || extractPending || pagesOcrPending) return;
    startOnce("extract", () =>
      extract.mutate(
        { requestId: crypto.randomUUID() },
        { onSettled: () => releaseStart("extract") },
      ),
    );
  }

  function startPagesOcr(force: boolean) {
    if (slidesQuery.isPending || slidesQuery.isError || pagesOcrPending || extractPending) return;
    startOnce("pages-ocr", () =>
      pagesOcr.mutate(
        { force, requestId: crypto.randomUUID() },
        { onSettled: () => releaseStart("pages-ocr") },
      ),
    );
  }

  function startCapture() {
    if (capturePending) return;
    startOnce("capture", () =>
      capture.mutate(
        { atMs: Math.floor(currentMs()) },
        { onSettled: () => releaseStart("capture") },
      ),
    );
  }

  function clearSettledFrameOcr() {
    ocr.reset();
    const cache = qc.getMutationCache();
    for (const mutation of cache.findAll({ mutationKey: frameOcrKey, exact: true })) {
      if (mutation.state.status !== "pending") cache.remove(mutation);
    }
  }

  function startFrameOcr() {
    if (frameOcrPending) return;
    clearSettledFrameOcr();
    startOnce("frame-ocr", () =>
      ocr.mutate(
        { atMs: Math.floor(currentMs()) },
        { onSettled: () => releaseStart("frame-ocr") },
      ),
    );
  }

  const pagesOcrFeedback =
    pagesOcrState?.status === "success" ? pagesOcrState.data ?? null : null;
  const ocrResult = frameOcrState?.status === "success" ? frameOcrState.data : undefined;

  return (
    <div className="flex h-full flex-col">
      {/* 学习面板可以被拖得很窄。这一行原来是单行不换行的，一窄就把最右边的
          「提取课件 / 重新提取」挤出可视区——而那正是这个面板唯一的主操作，
          用户根本点不到。改成允许换行：按钮不够宽就自己折下去。
          标题去掉了：外层标签已经写着「课件」，再写一遍「课件页」纯属占宽度。 */}
      <div className="flex flex-none flex-wrap items-center justify-end gap-x-2 gap-y-1.5 border-b border-[var(--border-subtle)] px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {!slidesQuery.isPending && !slidesQuery.isError && slides.length > 0 &&
            (pagesOcrPending ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const requestId = pagesOcrState.variables?.requestId;
                  if (requestId) void ipc.slides.cancelOcr(requestId);
                }}
                title={t("slides.stopOcrTitle")}
              >
                <Square className="h-3 w-3" />
                {pagesOcrProgress
                  ? t("slides.ocrProgress", { done: pagesOcrProgress.done, total: pagesOcrProgress.total })
                  : t("slides.ocrBusy")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={extractPending}
                onClick={(event) => startPagesOcr(event.shiftKey)}
                title={
                  pending === 0
                    ? t("slides.allRecognized")
                    : t("slides.ocrPending", { count: pending })
                }
              >
                <ScanText className="h-3.5 w-3.5" />
                {pending === 0 ? t("slides.reRecognize") : t("slides.recognizeText")}
              </Button>
            ))}
          <Button
            size="sm"
            variant="ghost"
            disabled={frameOcrPending}
            onClick={startFrameOcr}
            title={t("slides.screenshotOcrTitle")}
          >
            <ScanText className="h-3.5 w-3.5" />
            {frameOcrPending ? t("slides.screenshotOcrBusy") : t("slides.screenshotOcr")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={capturePending}
            onClick={startCapture}
            title={t("slides.screenshotTitle")}
          >
            <Camera className="h-3.5 w-3.5" />
            {capturePending ? t("slides.screenshotBusy") : t("slides.screenshot")}
          </Button>
          {extractPending && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const requestId = extractState.variables?.requestId ?? extractRequest.current;
                if (requestId) void ipc.slides.cancelExtract(requestId);
              }}
              title={t("slides.stopExtractTitle")}
            >
              <Square className="h-3 w-3" />
              {t("slides.stopExtract")}
            </Button>
          )}
          {!slidesQuery.isPending && !slidesQuery.isError && (
            <Button
              size="sm"
              disabled={extractPending || pagesOcrPending}
              onClick={startExtract}
              title={t("slides.extractTitle")}
            >
              <Images className="h-3.5 w-3.5" />
              {extractPending
                ? progressLabel(progress, t)
                : slides.length
                  ? t("slides.reExtract")
                  : t("slides.extract")}
            </Button>
          )}
        </div>
      </div>

      {pagesOcrState?.status === "error" && (
        <ErrorNote
          className="mx-3 mb-2 flex-none"
          error={pagesOcrState.error}
          onRetry={() => startPagesOcr(pagesOcrState.variables?.force ?? false)}
        />
      )}
      {pagesOcrFeedback && (
        // 有页失败就不能用绿色的成功样式：识别出来的页确实写进库了，可另外那些没有，
        // 而额度耗尽、鉴权失效正是从半路开始一页页失败的样子。
        <div
          role="status"
          className={`mx-3 mb-2 flex-none rounded-md px-3 py-2 text-xs ${
            pagesOcrFeedback.failed > 0 ||
            pagesOcrFeedback.canceled ||
            pagesOcrFeedback.stoppedEarly
              ? "bg-[var(--status-warn-bg)] text-[var(--status-warn)]"
              : "bg-[var(--status-ok-bg)] text-[var(--status-ok)]"
          }`}
        >
          {ocrFeedbackText(pagesOcrFeedback, t)}
        </div>
      )}
      {extractState?.status === "error" && (
        <ErrorNote
          className="mx-3 mb-2 flex-none"
          error={extractState.error}
          onRetry={startExtract}
        />
      )}
      {slidesQuery.isError && (
        <ErrorNote
          className="mx-3 mb-2 flex-none"
          error={slidesQuery.error}
          onRetry={() => void slidesQuery.refetch()}
        />
      )}
      {shotsQuery.isError && (
        <ErrorNote
          className="mx-3 mb-2 flex-none"
          error={shotsQuery.error}
          onRetry={() => void shotsQuery.refetch()}
        />
      )}
      {captureState?.status === "error" && (
        <ErrorNote
          className="mx-3 mb-2 flex-none"
          error={captureState.error}
          onRetry={startCapture}
        />
      )}
      {frameOcrState?.status === "error" && (
        <ErrorNote
          className="mx-3 mb-2 flex-none"
          error={frameOcrState.error}
          onRetry={startFrameOcr}
        />
      )}
      {ocrResult !== undefined && (
        <div className="flex-none border-b border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 text-xs">
          <div className="mb-1 flex items-center justify-between">
            <span className="flex items-center gap-2 font-medium text-[var(--text-muted)]">
              {t("slides.ocrResultTitle")}
              {copied && (
                <span className="inline-flex items-center rounded-full bg-[var(--status-ok-bg)] px-1.5 py-0.5 font-medium text-[var(--status-ok)]">
                  {t("slides.copied")}
                </span>
              )}
            </span>
            <button
              aria-label={t("slides.closeOcr")}
              title={t("slides.close")}
              onClick={clearSettledFrameOcr}
              className="ca-touch-44 ca-workbench-touch grid h-9 w-9 place-items-center rounded text-[var(--text-muted)] transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <button
            className="block max-h-40 w-full overflow-y-auto whitespace-pre-wrap text-left text-[var(--text-normal)] hover:text-[var(--text-strong)]"
            onClick={() => void copyOcrResult()}
          >
            {ocrResult || t("slides.noOcrText")}
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {slidesQuery.isPending ? (
          <div className="p-1">
            <TextSkeleton lines={5} />
          </div>
        ) : slidesQuery.isError ? null : slides.length === 0 ? (
          <PanelEmptyState
            icon={<Images className="h-7 w-7" />}
            title={t("slides.emptyTitle")}
            description={t("slides.emptyDescription")}
          />
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
              {t("slides.myScreenshots")}
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
