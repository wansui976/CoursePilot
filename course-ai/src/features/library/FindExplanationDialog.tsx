import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  Camera,
  GraduationCap,
  ImageUp,
  ListVideo,
  LoaderCircle,
  MessageSquareText,
  ScanSearch,
} from "lucide-react";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { displayTitle } from "@/lib/videoTitle";
import { isMobile } from "@/lib/platform";
import { imageFilesFromClipboard, prepareAssistantImage } from "@/lib/assistantImages";
import { cropDataUrl, normalizeCrop, type CropRect } from "@/lib/imageCrop";
import type { ExplanationHit, ExplanationResult } from "@/lib/types";
import { Modal } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { EmptyState } from "@/ui/empty-state";
import { SlideImage } from "@/features/workspace/SlideImage";
import { VideoCover } from "./VideoCover";

/**
 * 拍题找讲解：一道题（拍照 / 截图 / 粘贴 / 手打）→ 框出要找的那道 → 核对识别出的文字 →
 * 这门课里讲它的地方。结果可以依次播放，也可以交给助手的引导模式一起解。
 */

type Step =
  | { kind: "pick" }
  | { kind: "crop"; src: string }
  | { kind: "confirm"; image: string | null }
  | { kind: "results"; image: string | null; result: ExplanationResult };

export function FindExplanationDialog({
  courseId,
  initialImage,
  onClose,
  onOpenAt,
  onPlayInOrder,
  onSolveWithGuide,
  onAskAssistant,
}: {
  courseId: string;
  initialImage?: string;
  onClose: () => void;
  onOpenAt: (videoId: string, ms: number) => void;
  onPlayInOrder: (hits: ExplanationHit[]) => void;
  onSolveWithGuide: (text: string, image: string | null) => void;
  onAskAssistant: (text: string, image: string | null) => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>(() =>
    initialImage ? { kind: "crop", src: initialImage } : { kind: "pick" },
  );
  const [text, setText] = useState("");
  const [pickError, setPickError] = useState<unknown>(null);

  const ocr = useMutation({
    mutationFn: (image: string) => ipc.tools.ocrImage(image),
    onSuccess: (recognized) => setText((current) => (current.trim() ? current : recognized.trim())),
  });
  const search = useMutation({
    mutationFn: ({ image }: { image: string | null }) => ipc.tools.findExplanations(courseId, text, image),
    onSuccess: (result, { image }) => setStep({ kind: "results", image, result }),
  });

  async function acceptFile(file: File) {
    setPickError(null);
    try {
      setStep({ kind: "crop", src: await prepareAssistantImage(file) });
    } catch (error) {
      setPickError(error);
    }
  }

  // 选图这一步：直接 ⌘V 粘贴截图。
  useEffect(() => {
    if (step.kind !== "pick") return;
    const onPaste = (event: ClipboardEvent) => {
      const file = imageFilesFromClipboard(event.clipboardData)[0];
      if (!file) return;
      event.preventDefault();
      void acceptFile(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [step.kind]);

  function toConfirm(image: string | null) {
    setStep({ kind: "confirm", image });
    if (image) ocr.mutate(image);
  }

  const title = t("findExplanation.title");
  const back =
    step.kind === "crop" || step.kind === "confirm" || step.kind === "results" ? (
      <button
        type="button"
        aria-label={t("findExplanation.back")}
        onClick={() => {
          if (step.kind === "results") setStep({ kind: "confirm", image: step.image });
          else setStep({ kind: "pick" });
        }}
        className="ca-touch-44 grid h-7 w-7 place-items-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
    ) : undefined;

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      icon={<ScanSearch className="h-4 w-4 text-[var(--accent-text)]" />}
      headerAction={back}
      size="lg"
    >
      {step.kind === "pick" && (
        <PickStep onFile={(file) => void acceptFile(file)} error={pickError} onTypeInstead={() => toConfirm(null)} />
      )}
      {step.kind === "crop" && (
        <CropStep
          src={step.src}
          onDone={async (rect) => {
            const image = rect ? await cropDataUrl(step.src, rect) : step.src;
            toConfirm(image);
          }}
        />
      )}
      {step.kind === "confirm" && (
        <div className="mt-3 space-y-3">
          {step.image && (
            <img src={step.image} alt={t("findExplanation.problemImage")} className="max-h-40 rounded-lg border border-[var(--border-subtle)] object-contain" />
          )}
          <label className="block">
            <span className="mb-1 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
              {t("findExplanation.problemText")}
              {ocr.isPending && (
                <>
                  <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
                  {t("findExplanation.recognizing")}
                </>
              )}
            </span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={5}
              placeholder={t("findExplanation.textPlaceholder")}
              className="ca-prose w-full resize-y rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-strong)] outline-none focus:border-[var(--focus-ring)]"
            />
          </label>
          {ocr.isSuccess && (
            <p className="text-xs text-[var(--text-muted)]">{t("findExplanation.checkText")}</p>
          )}
          {ocr.isError && <ErrorNote error={ocr.error} onRetry={() => step.image && ocr.mutate(step.image)} />}
          {search.isError && <ErrorNote error={search.error} />}
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={(!text.trim() && !step.image) || search.isPending}
              onClick={() => search.mutate({ image: step.image })}
              className="gap-1.5"
            >
              {search.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
              {t("findExplanation.search")}
            </Button>
          </div>
        </div>
      )}
      {step.kind === "results" && (
        <ResultsStep
          result={step.result}
          onOpen={(hit) => {
            onOpenAt(hit.video_id, hit.start_ms);
            onClose();
          }}
          onOpenConcept={(videoId, ms) => {
            onOpenAt(videoId, ms);
            onClose();
          }}
          onPlayInOrder={(hits) => {
            onPlayInOrder(hits);
            onClose();
          }}
          onSolveWithGuide={() => {
            onSolveWithGuide(text, step.image);
            onClose();
          }}
          onAskAssistant={() => {
            onAskAssistant(text, step.image);
            onClose();
          }}
        />
      )}
    </Modal>
  );
}

function PickStep({
  onFile,
  error,
  onTypeInstead,
}: {
  onFile: (file: File) => void;
  error: unknown;
  onTypeInstead: () => void;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const mobile = isMobile();
  const take = (files: FileList | null) => {
    const file = Array.from(files ?? []).find((item) => item.type.startsWith("image/"));
    if (file) onFile(file);
  };
  return (
    <div className="mt-3 space-y-3">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          take(event.dataTransfer.files);
        }}
        className={`flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-8 text-center transition-colors ${
          dragging ? "border-[var(--accent)] bg-[var(--accent-weak)]" : "border-[var(--border-strong)]"
        }`}
      >
        <p className="text-sm text-[var(--text-normal)]">
          {mobile ? t("findExplanation.pickMobile") : t("findExplanation.pickDesktop")}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {mobile && (
            <Button variant="primary" className="gap-1.5" onClick={() => cameraRef.current?.click()}>
              <Camera className="h-4 w-4" />
              {t("findExplanation.takePhoto")}
            </Button>
          )}
          <Button variant={mobile ? "secondary" : "primary"} className="gap-1.5" onClick={() => fileRef.current?.click()}>
            <ImageUp className="h-4 w-4" />
            {mobile ? t("findExplanation.fromAlbum") : t("findExplanation.chooseImage")}
          </Button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden data-testid="find-image-input" onChange={(event) => take(event.target.files)} />
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(event) => take(event.target.files)} />
      </div>
      {error != null && <ErrorNote error={error} />}
      <button type="button" onClick={onTypeInstead} className="ca-touch-44 text-xs text-[var(--accent-text)] hover:underline">
        {t("findExplanation.typeInstead")}
      </button>
    </div>
  );
}

/** 在图上拖一个框，框出要找的那道题；不框就用整张图。 */
function CropStep({ src, onDone }: { src: string; onDone: (rect: CropRect | null) => Promise<void> }) {
  const { t } = useTranslation();
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; id: number } | null>(null);
  const [rect, setRect] = useState<CropRect | null>(null);
  const [busy, setBusy] = useState(false);

  const point = (event: ReactPointerEvent) => {
    const box = boxRef.current!.getBoundingClientRect();
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
  };
  const finish = async (crop: CropRect | null) => {
    setBusy(true);
    try {
      await onDone(crop);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-3">
      <p className="text-xs text-[var(--text-muted)]">{t("findExplanation.cropHint")}</p>
      <div
        ref={boxRef}
        className="relative mx-auto w-fit touch-none select-none overflow-hidden rounded-lg border border-[var(--border-subtle)]"
        onPointerDown={(event) => {
          const p = point(event);
          dragRef.current = { ...p, id: event.pointerId };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setRect(null);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.id !== event.pointerId) return;
          const p = point(event);
          setRect(normalizeCrop(drag.x, drag.y, p.x, p.y));
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
      >
        <img src={src} alt={t("findExplanation.problemImage")} draggable={false} className="block max-h-[50dvh] max-w-full" />
        {rect && (
          <div
            data-testid="crop-rect"
            className="pointer-events-none absolute border-2 border-[var(--accent)] shadow-[0_0_0_9999px_rgb(0_0_0/0.45)]"
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.w * 100}%`,
              height: `${rect.h * 100}%`,
            }}
          />
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => void finish(null)}>
          {t("findExplanation.useWhole")}
        </Button>
        <Button variant="primary" disabled={busy || !rect} onClick={() => void finish(rect)}>
          {t("findExplanation.useSelection")}
        </Button>
      </div>
    </div>
  );
}

function ResultsStep({
  result,
  onOpen,
  onOpenConcept,
  onPlayInOrder,
  onSolveWithGuide,
  onAskAssistant,
}: {
  result: ExplanationResult;
  onOpen: (hit: ExplanationHit) => void;
  onOpenConcept: (videoId: string, ms: number) => void;
  onPlayInOrder: (hits: ExplanationHit[]) => void;
  onSolveWithGuide: () => void;
  onAskAssistant: () => void;
}) {
  const { t } = useTranslation();
  const strong = result.hits.filter((hit) => hit.strong);
  const queue = (strong.length >= 2 ? strong : result.hits).slice(0, 4);

  if (result.hits.length === 0) {
    return (
      <div className="mt-3 space-y-3">
        <EmptyState
          title={t("findExplanation.emptyTitle")}
          description={t("findExplanation.emptyDescription")}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" className="gap-1.5" onClick={onSolveWithGuide}>
                <GraduationCap className="h-4 w-4" />
                {t("findExplanation.solveWithGuide")}
              </Button>
              <Button variant="secondary" className="gap-1.5" onClick={onAskAssistant}>
                <MessageSquareText className="h-4 w-4" />
                {t("findExplanation.askAssistant")}
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      {queue.length >= 2 && (
        <Button variant="primary" className="w-full gap-1.5" onClick={() => onPlayInOrder(queue)}>
          <ListVideo className="h-4 w-4" />
          {t("findExplanation.playInOrder", {
            count: queue.length,
            minutes: Math.max(1, Math.round(queue.reduce((sum, hit) => sum + Math.max(60_000, hit.end_ms - hit.start_ms + 30_000), 0) / 60_000)),
          })}
        </Button>
      )}
      {result.concepts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-[var(--text-muted)]">{t("findExplanation.concepts")}</span>
          {result.concepts.map((concept) =>
            concept.video_id != null && concept.start_ms != null ? (
              <button
                key={concept.concept_id}
                type="button"
                onClick={() => onOpenConcept(concept.video_id!, concept.start_ms!)}
                className="ca-touch-44 rounded-full bg-[var(--accent-weak)] px-2 py-0.5 text-[var(--accent-text)] hover:bg-[var(--accent-weak-2)]"
              >
                {concept.name}
              </button>
            ) : (
              <span key={concept.concept_id} className="rounded-full bg-[var(--surface-card)] px-2 py-0.5 text-[var(--text-normal)]">
                {concept.name}
              </span>
            ),
          )}
        </div>
      )}
      <ul className="space-y-2" aria-label={t("findExplanation.results")}>
        {result.hits.map((hit) => (
          <li key={`${hit.video_id}-${hit.start_ms}-${hit.matched_by}`}>
            <button
              type="button"
              onClick={() => onOpen(hit)}
              className="ca-touch-44 flex w-full gap-3 rounded-xl border border-[var(--border-subtle)] p-2 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-card-hover)]"
            >
              <span className="relative h-16 w-28 flex-none overflow-hidden rounded-md bg-[var(--surface-stage)]">
                {hit.slide_image ? (
                  <SlideImage
                    videoId={hit.video_id}
                    imagePath={hit.slide_image}
                    alt={t("findExplanation.slidePage", { page: (hit.slide_page ?? 0) + 1 })}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <VideoCover videoId={hit.video_id} className="absolute inset-0 h-full w-full" />
                )}
                <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 font-mono text-[10px] text-white">
                  {formatMs(hit.start_ms)}
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-[var(--text-strong)]">
                  {displayTitle(hit.video_title)}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-1.5 ca-t-2xs">
                  <span
                    className={`rounded-full px-1.5 ${
                      hit.strong
                        ? "bg-[var(--accent-weak)] font-medium text-[var(--accent-text)]"
                        : "bg-[var(--surface-card)] text-[var(--text-muted)]"
                    }`}
                  >
                    {hit.strong ? t("findExplanation.strong") : t("findExplanation.possible")}
                  </span>
                  <span className="text-[var(--text-faint)]">
                    {hit.matched_by === "picture"
                      ? t("findExplanation.byPicture", { page: (hit.slide_page ?? 0) + 1 })
                      : hit.slide_page != null
                        ? t("findExplanation.bySlideText", { page: hit.slide_page + 1 })
                        : t("findExplanation.byTranscript")}
                  </span>
                </span>
                {hit.snippet && (
                  <span className="ca-prose mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">{hit.snippet}</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2 border-t border-[var(--border-faint)] pt-3">
        <Button variant="secondary" className="gap-1.5" onClick={onSolveWithGuide}>
          <GraduationCap className="h-4 w-4" />
          {t("findExplanation.solveWithGuide")}
        </Button>
      </div>
    </div>
  );
}
