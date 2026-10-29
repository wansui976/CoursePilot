import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  GraduationCap,
  Keyboard,
  LoaderCircle,
  Mic,
  Plus,
  RotateCcw,
  Square,
} from "lucide-react";
import { feynmanTopicKey, ipc } from "@/lib/ipc";
import { coverage, filledGaps, markExplanation } from "@/lib/feynman";
import { formatMs } from "@/lib/time";
import type { FeynmanAttempt, FeynmanTopic } from "@/lib/types";
import { canRecord, MAX_RECORDING_MS, useRecorder } from "@/lib/useRecorder";
import { Modal } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { ProgressRing } from "@/ui/ProgressRing";

/**
 * 费曼复述：把一个知识点用自己的话讲一遍（对着麦克风，或者打字），
 * 拿课程原文对照，看讲到了几点、漏了什么、哪里讲错了——漏和错都能一键回看原片。
 */
export function FeynmanDialog({
  topic,
  title,
  /** 建复习卡要挂在一个视频上：知识点没有固定视频时用它最早出现的那个。 */
  cardVideoId,
  onClose,
  onOpenAt,
  onGuide,
}: {
  topic: FeynmanTopic;
  title: string;
  cardVideoId: string | null;
  onClose: () => void;
  onOpenAt: (videoId: string, ms: number) => void;
  onGuide: (text: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const topicKey = feynmanTopicKey(topic);
  const [mode, setMode] = useState<"speak" | "type">(() => (canRecord() ? "speak" : "type"));
  const [text, setText] = useState("");
  const [attempt, setAttempt] = useState<FeynmanAttempt | null>(null);
  const history = useQuery({
    queryKey: ["feynman-attempts", topicKey],
    queryFn: () => ipc.feynman.attempts(topicKey),
  });
  /** 进入这次复述之前的最近一次：「再讲一遍」后拿来对比补上了什么。 */
  const [previous, setPrevious] = useState<FeynmanAttempt | null>(null);
  useEffect(() => {
    if (history.data && previous === null && !attempt) setPrevious(history.data[0] ?? null);
  }, [attempt, history.data, previous]);

  const transcribe = useMutation({
    mutationFn: (audio: string) => ipc.feynman.transcribe(audio),
    onSuccess: (recognized) => setText((current) => [current.trim(), recognized.trim()].filter(Boolean).join("\n")),
  });
  const evaluate = useMutation({
    mutationFn: () => ipc.feynman.evaluate(topic, text),
    onSuccess: (result) => {
      setAttempt(result);
      void queryClient.invalidateQueries({ queryKey: ["feynman-attempts", topicKey] });
      void queryClient.invalidateQueries({ queryKey: ["feynman-mastered"] });
    },
  });

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("feynman.title", { topic: title })}
      icon={<GraduationCap className="h-4 w-4 text-[var(--accent-text)]" />}
      size="lg"
    >
      {attempt ? (
        <FeynmanResultView
          attempt={attempt}
          previous={previous}
          cardVideoId={cardVideoId}
          onOpenAt={(videoId, ms) => {
            onOpenAt(videoId, ms);
            onClose();
          }}
          onRetry={() => {
            setPrevious(attempt);
            setAttempt(null);
            setText("");
            evaluate.reset();
          }}
          onGuide={() => {
            const wrong = attempt.result.wrong.map((item) => item.quote).join("；");
            onGuide(t("feynman.guidePrompt", { topic: title, wrong }));
            onClose();
          }}
        />
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-[var(--text-normal)]">{t("feynman.prompt", { topic: title })}</p>
          {mode === "speak" ? (
            <SpeakInput
              transcribing={transcribe.isPending}
              onClip={(audio) => transcribe.mutate(audio)}
              onTypeInstead={() => setMode("type")}
            />
          ) : (
            canRecord() && (
              <button
                type="button"
                onClick={() => setMode("speak")}
                className="ca-touch-44 inline-flex items-center gap-1 text-xs text-[var(--accent-text)] hover:underline"
              >
                <Mic className="h-3.5 w-3.5" />
                {t("feynman.speakInstead")}
              </button>
            )
          )}
          {transcribe.isError && <ErrorNote error={transcribe.error} />}
          {(mode === "type" || text) && (
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={6}
              autoFocus={mode === "type"}
              placeholder={t("feynman.placeholder")}
              aria-label={t("feynman.yourExplanation")}
              className="ca-prose w-full resize-y rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-strong)] outline-none focus:border-[var(--focus-ring)]"
            />
          )}
          {evaluate.isError && <ErrorNote error={evaluate.error} />}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-[var(--text-faint)]">
              {previous ? t("feynman.lastTime", { count: previous.result.covered.length, total: previous.result.covered.length + previous.result.missed.length }) : ""}
            </span>
            <Button
              variant="primary"
              disabled={text.trim().length < 4 || evaluate.isPending || transcribe.isPending}
              onClick={() => evaluate.mutate()}
              className="gap-1.5"
            >
              {evaluate.isPending && <LoaderCircle className="h-4 w-4 animate-spin" />}
              {evaluate.isPending ? t("feynman.checking") : t("feynman.check")}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function SpeakInput({
  transcribing,
  onClip,
  onTypeInstead,
}: {
  transcribing: boolean;
  onClip: (audio: string) => void;
  onTypeInstead: () => void;
}) {
  const { t } = useTranslation();
  const recorder = useRecorder();
  const recording = recorder.state.status === "recording";
  const elapsed = recorder.state.status === "recording" ? recorder.state.elapsedMs : 0;
  const { autoClip, takeAutoClip } = recorder;
  useEffect(() => {
    if (!autoClip) return;
    const clip = takeAutoClip();
    if (clip) onClip(clip);
  }, [autoClip, onClip, takeAutoClip]);

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--border-subtle)] px-4 py-5">
      <div aria-hidden="true" className="flex h-8 items-center gap-[3px]">
        {recorder.levels.map((level, index) => (
          <span
            key={index}
            className="w-1 rounded-full bg-[var(--accent)] transition-[height] duration-75"
            style={{ height: `${Math.max(3, level * 32)}px`, opacity: recording ? 1 : 0.25 }}
          />
        ))}
      </div>
      <button
        type="button"
        aria-pressed={recording}
        disabled={transcribing}
        onClick={async () => {
          if (recording) {
            const clip = await recorder.stop();
            if (clip) onClip(clip);
          } else {
            void recorder.start();
          }
        }}
        className={`ca-touch-44 grid h-16 w-16 place-items-center rounded-full text-white shadow-[var(--shadow-raise)] transition ${
          recording ? "bg-[var(--status-err)]" : "ca-fill-brand hover:opacity-90"
        } disabled:opacity-50`}
        aria-label={recording ? t("feynman.stopRecording") : t("feynman.startRecording")}
      >
        {transcribing ? (
          <LoaderCircle className="h-6 w-6 animate-spin" />
        ) : recording ? (
          <Square className="h-5 w-5 fill-current" />
        ) : (
          <Mic className="h-6 w-6" />
        )}
      </button>
      <p className="text-xs tabular-nums text-[var(--text-muted)]" aria-live="polite">
        {transcribing
          ? t("feynman.transcribing")
          : recording
            ? t("feynman.recording", { elapsed: formatMs(elapsed), max: formatMs(MAX_RECORDING_MS) })
            : t("feynman.tapToSpeak")}
      </p>
      {recorder.state.status === "error" && (
        <p role="alert" className="text-center text-xs text-[var(--status-err)]">
          {t(`feynman.micError.${recorder.state.reason}`)}
        </p>
      )}
      <button
        type="button"
        onClick={onTypeInstead}
        className="ca-touch-44 inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]"
      >
        <Keyboard className="h-3.5 w-3.5" />
        {t("feynman.typeInstead")}
      </button>
    </div>
  );
}

function FeynmanResultView({
  attempt,
  previous,
  cardVideoId,
  onOpenAt,
  onRetry,
  onGuide,
}: {
  attempt: FeynmanAttempt;
  previous: FeynmanAttempt | null;
  cardVideoId: string | null;
  onOpenAt: (videoId: string, ms: number) => void;
  onRetry: () => void;
  onGuide: () => void;
}) {
  const { t } = useTranslation();
  const { result } = attempt;
  const total = result.covered.length + result.missed.length;
  const filled = previous ? filledGaps(previous.result, result) : [];
  const pieces = markExplanation(attempt.explanation, result);
  const [cards, setCards] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  const jump = (videoId: string | null, ms: number | null) =>
    videoId && ms != null ? (
      <button
        type="button"
        onClick={() => onOpenAt(videoId, Math.max(0, ms - 3000))}
        className="ca-touch-44 flex-none text-xs text-[var(--accent-text)] hover:underline"
      >
        {t("feynman.rewatch", { time: formatMs(ms) })}
      </button>
    ) : null;

  return (
    <div className="mt-3 space-y-3">
      <div className="flex items-center gap-3">
        <ProgressRing value={coverage(result)} size={52} stroke={5}>
          <span className="text-xs font-semibold tabular-nums text-[var(--text-strong)]">
            {result.covered.length}/{total}
          </span>
        </ProgressRing>
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--text-strong)]">
            {t("feynman.coverage", { count: result.covered.length, total })}
          </p>
          {result.comment && <p className="ca-prose text-xs text-[var(--text-muted)]">{result.comment}</p>}
          {filled.length > 0 && (
            <p className="mt-0.5 text-xs font-medium text-[var(--status-ok)]">
              {t("feynman.filled", { count: filled.length })}
            </p>
          )}
        </div>
      </div>

      <section aria-label={t("feynman.yourExplanation")} className="ca-prose rounded-lg bg-[var(--surface-card)] px-3 py-2 text-sm leading-relaxed text-[var(--text-normal)]">
        {pieces.map((piece, index) =>
          piece.kind === "covered" ? (
            <mark key={index} className="rounded bg-[var(--status-ok-bg)] px-0.5 text-inherit">
              {piece.text}
            </mark>
          ) : piece.kind === "wrong" ? (
            <span
              key={index}
              title={piece.note}
              className="underline decoration-[var(--status-err)] decoration-wavy underline-offset-4"
            >
              {piece.text}
            </span>
          ) : (
            <span key={index}>{piece.text}</span>
          ),
        )}
      </section>

      {result.wrong.length > 0 && (
        <ul className="space-y-1.5" aria-label={t("feynman.wrongTitle")}>
          {result.wrong.map((item) => (
            <li key={item.quote} className="flex items-start gap-2 rounded-lg border border-[var(--status-err)]/30 px-3 py-2 text-xs">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 flex-none text-[var(--status-err)]" />
              <span className="ca-prose min-w-0 flex-1">
                <span className="text-[var(--text-muted)] line-through">{item.quote}</span>
                <span className="block text-[var(--text-normal)]">{item.correction}</span>
              </span>
              {jump(item.video_id, item.ref_ms)}
            </li>
          ))}
        </ul>
      )}
      {result.missed.length > 0 && (
        <ul className="space-y-1.5" aria-label={t("feynman.missedTitle")}>
          {result.missed.map((item) => (
            <li key={item.point} className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--border-strong)] px-3 py-2 text-xs">
              <CircleDashed className="h-3.5 w-3.5 flex-none text-[var(--text-muted)]" />
              <span className="ca-prose min-w-0 flex-1 text-[var(--text-normal)]">{t("feynman.missed", { point: item.point })}</span>
              {jump(item.video_id, item.ref_ms)}
            </li>
          ))}
        </ul>
      )}
      {result.missed.length === 0 && result.wrong.length === 0 && (
        <p className="flex items-center gap-1.5 text-sm text-[var(--status-ok)]">
          <CircleCheck className="h-4 w-4" />
          {t("feynman.allClear")}
        </p>
      )}

      <div className="flex flex-wrap gap-2 border-t border-[var(--border-faint)] pt-3">
        <Button variant="secondary" className="gap-1.5" onClick={onRetry}>
          <RotateCcw className="h-4 w-4" />
          {t("feynman.retry")}
        </Button>
        {result.missed.length > 0 && cardVideoId && (
          <Button
            variant="secondary"
            className="gap-1.5"
            disabled={cards === "saving" || cards === "saved"}
            onClick={async () => {
              setCards("saving");
              try {
                for (const item of result.missed) {
                  await ipc.srs.addCard(
                    item.video_id ?? cardVideoId,
                    "feynman",
                    t("feynman.cardFront", { point: item.point }),
                    item.point,
                    item.ref_ms,
                  );
                }
                setCards("saved");
              } catch {
                setCards("failed");
              }
            }}
          >
            <Plus className="h-4 w-4" />
            {cards === "saved"
              ? t("feynman.cardsSaved", { count: result.missed.length })
              : cards === "failed"
                ? t("feynman.cardsFailed")
                : t("feynman.makeCards", { count: result.missed.length })}
          </Button>
        )}
        {result.wrong.length > 0 && (
          <Button variant="secondary" className="gap-1.5" onClick={onGuide}>
            <GraduationCap className="h-4 w-4" />
            {t("feynman.guideMe")}
          </Button>
        )}
      </div>
    </div>
  );
}
