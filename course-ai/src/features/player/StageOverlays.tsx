import { useTranslation } from "react-i18next";
import { AudioLines, Pause, Play } from "lucide-react";
import type { GestureHint } from "./playerPrefs";

/** 播放器舞台上的浮层：纯展示，状态都在 VideoPlayer。 */

/** 纯音频源的舞台卡片。pointer-events:none：点按/双击/手势照常落到 <video> 上。 */
export function AudioStage({ playing }: { playing: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="ca-audio-stage" aria-hidden="true">
      <div className="ca-audio-art">
        <AudioLines className="h-12 w-12" />
      </div>
      <div className="ca-audio-eq" data-playing={playing || undefined}>
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <span className="ca-audio-label">{t("videoPlayer.audioOnly")}</span>
    </div>
  );
}

/** 顶部一枚小胶囊：智能倍速、跳停顿的即时提示。 */
export function StageNotice({ children, align }: { children: string; align: "center" | "right" }) {
  return (
    <div
      aria-live="polite"
      className={`pointer-events-none absolute top-6 z-20 rounded-full bg-[var(--surface-stage-overlay)] px-3 py-1 text-xs font-medium text-white ${
        align === "right" ? "right-4" : "left-1/2 -translate-x-1/2"
      }`}
    >
      {children}
    </div>
  );
}

export function GestureHintOverlay({ hint }: { hint: GestureHint }) {
  const { t } = useTranslation();
  return (
    <div
      aria-label={t("videoPlayer.gestureOverlay")}
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[var(--surface-stage-scrim)] text-white"
    >
      <div className="rounded-lg bg-[var(--surface-stage-overlay)] px-4 py-2 text-sm font-medium">
        {hint.kind === "brightness" &&
          t("videoPlayer.brightnessPercent", { percent: (hint.value * 100).toFixed(0) })}
        {hint.kind === "volume" &&
          t("videoPlayer.volumePercent", { percent: (hint.value * 100).toFixed(0) })}
        {hint.kind === "scrub" && t("videoPlayer.scrubbing")}
        {hint.kind === "rate" && t("videoPlayer.fastForwarding", { rate: hint.value })}
        {hint.kind === "rewind" && t("videoPlayer.rewinding")}
      </div>
    </div>
  );
}

export type TranscodeStatus = { state: string; percent: number };

/** 解码失败：说清原因（哪种编码），本机能转码时显示进度与重试。 */
export function DecodeFailureCard({
  codec,
  transcode,
  onRetryTranscode,
}: {
  /** 空串 = 还在查编码；"unknown" = 查不到。 */
  codec: string;
  transcode: TranscodeStatus | null;
  onRetryTranscode: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="absolute inset-x-4 top-1/2 z-30 mx-auto flex max-w-md -translate-y-1/2 flex-col gap-2 rounded-xl bg-[var(--surface-stage-overlay)] px-4 py-3 text-left text-white shadow-[var(--shadow-pop)]"
    >
      <p className="text-sm font-semibold">{t("videoPlayer.decodeFailedTitle")}</p>
      <p className="text-xs leading-relaxed text-white/70">
        {transcode?.state === "running"
          ? t("videoPlayer.transcoding", { percent: transcode.percent })
          : transcode?.state === "done"
            ? t("videoPlayer.transcodeDone")
            : transcode?.state === "failed"
              ? t("videoPlayer.transcodeFailed")
              : codec && codec !== "unknown"
                ? t("videoPlayer.decodeFailedCodec", { codec })
                : t("videoPlayer.decodeFailedGeneric")}
      </p>
      {transcode?.state === "running" && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={transcode.percent}
          className="h-1 w-full overflow-hidden rounded-full bg-white/15"
        >
          <div
            className="h-full rounded-full bg-white/80 transition-[width] duration-300"
            style={{ width: `${transcode.percent}%` }}
          />
        </div>
      )}
      {transcode?.state === "failed" && (
        <button
          type="button"
          onClick={onRetryTranscode}
          className="ca-touch-44 self-start rounded-md bg-white/15 px-2.5 py-1 text-xs font-medium text-white"
        >
          {t("videoPlayer.transcodeRetry")}
        </button>
      )}
    </div>
  );
}

/** 点画面 / 空格切换播放时，画面中央闪一下播放或暂停图标（YouTube 式）。 */
export function PlayFlash({ kind, onDone }: { kind: "play" | "pause"; onDone: () => void }) {
  return (
    <div
      aria-hidden="true"
      className="ca-play-flash pointer-events-none absolute left-1/2 top-1/2 z-20 flex h-16 w-16 items-center justify-center rounded-full bg-black/55 text-white"
      onAnimationEnd={onDone}
    >
      {kind === "play" ? (
        <Play className="h-7 w-7 translate-x-0.5 fill-current" />
      ) : (
        <Pause className="h-7 w-7 fill-current" />
      )}
    </div>
  );
}
