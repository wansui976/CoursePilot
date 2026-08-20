import { Button } from "@/components/ui/button";
import {
  nextSkipPreviewMs,
  prevSkipPreviewMs,
  type SkipRange,
} from "@/lib/silenceSkip";
import { formatMs } from "@/lib/time";
import type { Insets } from "@/lib/blackBars";
import { formatInsetsText } from "./useVideoCrop";
import { usePlayer } from "@/stores/player";
import { useContainerWidth } from "@/lib/useContainerWidth";
import {
  Check,
  Maximize,
  Minimize,
  MoreHorizontal,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";

const SPEEDS = [2, 1.5, 1.25, 1, 0.75, 0.5];
const iconButtonClass =
  "flex h-7 w-7 items-center justify-center rounded-lg text-white/90 transition hover:bg-white/10 hover:text-white";
const textButtonClass =
  "h-7 whitespace-nowrap rounded-lg px-2 text-[13px] font-medium text-white/85 transition hover:bg-white/10 hover:text-white";
const mobileMenuItemClass =
  "flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-sm font-medium text-white transition hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/80 disabled:cursor-not-allowed disabled:opacity-35";

function formatRate(rate: number) {
  const rounded = Math.round(rate * 100) / 100;
  return Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded);
}

export function Controls({
  playing,
  rate,
  effectiveRate,
  volume,
  muted,
  captionsOn,
  smartRate,
  smartRateAvailable,
  skipSilence,
  skipSilenceAvailable,
  skipSilenceLoading,
  skipRanges,
  cropOn,
  cropInsets,
  fullscreen,
  onToggleCrop,
  onToggleCaptions,
  onToggleSkipSilence,
  onToggleSmartRate,
  onPreviewSkip,
  onPlayPause,
  onRate,
  onVolume,
  onMuteToggle,
  onFullscreenToggle,
}: {
  playing: boolean;
  /** 常态实际播放速度；智能倍速开启时可能高于用户选择的基础倍速。 */
  effectiveRate: number;
  rate: number;
  volume: number;
  muted: boolean;
  captionsOn: boolean;
  smartRate: boolean;
  smartRateAvailable: boolean;
  skipSilence: boolean;
  skipSilenceAvailable: boolean;
  skipSilenceLoading: boolean;
  skipRanges: SkipRange[];
  cropOn: boolean;
  cropInsets: Insets;
  fullscreen: boolean;
  onToggleCrop: () => void;
  onToggleCaptions: () => void;
  onToggleSkipSilence: () => void;
  onToggleSmartRate: () => void;
  onPreviewSkip: (ms: number) => void;
  onPlayPause: () => void;
  onRate: (rate: number) => void;
  onVolume: (volume: number) => void;
  onMuteToggle: () => void;
  onFullscreenToggle: () => void;
}) {
  const { t } = useTranslation();
  // 只让这个小组件订阅进度（每秒约 4 次重渲染），不波及整个播放器。
  const currentMs = usePlayer((s) => s.currentMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreMenuId = useId();
  const speedTriggerRef = useRef<HTMLButtonElement>(null);
  const speedItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const controlsRootRef = useRef<HTMLDivElement>(null);
  // 分栏会让播放器远窄于窗口；控制组必须按自身可用宽度收起，而不是按 viewport 猜测。
  const compactControls = useContainerWidth(controlsRootRef) !== "wide";
  // 首次开启要扫一遍音轨，几秒内还跳不了；按钮上直说，别让人以为已经在跳了。
  const skipSilenceLabel = skipSilenceLoading
    ? t("videoPlayer.skipSilenceAnalyzingShort")
    : t("videoPlayer.skipSilenceEnabledShort");
  // 试跳：直接送到下一处/上一处停顿前 1.5 秒并接着播，不用守着整段视频等它跳。
  const prevSkipMs = prevSkipPreviewMs(skipRanges, currentMs);
  const nextSkipMs = nextSkipPreviewMs(skipRanges, currentMs);
  const showSkipNav = skipSilence && skipRanges.length > 0;
  // 一条边都没检测到时开关没有意义（也是「源片本来就带边」的线索）。
  // 但按钮不置灰：探测只在播放中才跑，没测到不等于没有。
  const hasCrop = Object.values(cropInsets).some((v) => v > 0);

  useEffect(() => {
    if (speedOpen) speedItemRefs.current[0]?.focus();
  }, [speedOpen]);

  useEffect(() => {
    if (!moreOpen) return;
    moreMenuRef.current
      ?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')
      ?.focus();
  }, [moreOpen]);

  useEffect(() => {
    // 模式切换会让其中一组控件变为 inert；同时清掉它的菜单状态，避免切回来后意外重开。
    if (compactControls) setSpeedOpen(false);
    else setMoreOpen(false);
  }, [compactControls]);

  // 倍速菜单：点菜单与触发按钮之外即收起；Esc 收起后把焦点还给触发按钮。
  useEffect(() => {
    if (!speedOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-speed-menu]")) return;
      setSpeedOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSpeedOpen(false);
      speedTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [speedOpen]);

  // 窄屏「更多」是一个真正的菜单：Esc 返回触发按钮，Tab 则正常离开菜单。
  useEffect(() => {
    if (!moreOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMoreOpen(false);
      moreTriggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [moreOpen]);

  const handleSpeedMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentIndex = speedItemRefs.current.findIndex(
      (item) => item === document.activeElement,
    );
    let nextIndex: number | null = null;

    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % SPEEDS.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        nextIndex = currentIndex <= 0 ? SPEEDS.length - 1 : currentIndex - 1;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = SPEEDS.length - 1;
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        setSpeedOpen(false);
        speedTriggerRef.current?.focus();
        return;
      default:
        return;
    }

    event.preventDefault();
    speedItemRefs.current[nextIndex]?.focus();
  };

  const closeMoreMenu = (restoreFocus = true) => {
    setMoreOpen(false);
    if (restoreFocus) moreTriggerRef.current?.focus();
  };

  const runMoreAction = (action: () => void) => {
    action();
    closeMoreMenu();
  };

  const handleMoreMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not([disabled])',
      ),
    );
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    let nextIndex: number | null = null;

    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = items.length - 1;
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeMoreMenu();
        return;
      case "Tab":
        setMoreOpen(false);
        return;
      default:
        return;
    }

    if (nextIndex == null || items.length === 0) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  };
  const displayedRate = effectiveRate;
  const volumePercent = muted ? 0 : Math.min(100, Math.max(0, volume * 100));

  return (
    <div
      ref={controlsRootRef}
      data-controls-layout={compactControls ? "compact" : "full"}
      className="ca-player-controls mt-1 flex items-center gap-1.5 text-sm text-white/75"
    >
      <Button
        size="icon"
        variant="ghost"
        onClick={onPlayPause}
        aria-label={playing ? t("videoPlayer.pause") : t("videoPlayer.play")}
        title={playing ? t("videoPlayer.pause") : t("videoPlayer.play")}
        className="h-7 w-7 rounded-lg text-white hover:bg-white/10 hover:text-white"
      >
        {playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
      </Button>
      <span className="ca-player-controls-time whitespace-nowrap text-sm font-medium tabular-nums tracking-wide text-white/85">
        {formatMs(currentMs)} / {formatMs(durationMs)}
      </span>

      <div className="min-w-2 flex-1" />

      <div
        className="ca-player-controls-desktop"
        aria-hidden={compactControls || undefined}
        inert={compactControls ? true : undefined}
      >
      <div className="relative" data-speed-menu>
        <button
          ref={speedTriggerRef}
          type="button"
          className={`${textButtonClass} ${displayedRate !== 1 ? "text-[var(--video-accent)]" : ""}`}
          aria-haspopup="menu"
          aria-expanded={speedOpen}
          aria-label={t("videoPlayer.rateCurrent", { rate: formatRate(displayedRate) })}
          onClick={() => setSpeedOpen((open) => !open)}
        >
          {/* 菜单勾选基础倍速，触发按钮显示智能调速后的常态实际速度。 */}
          {displayedRate === 1 ? t("videoPlayer.rate") : `${formatRate(displayedRate)}x`}
        </button>
        {speedOpen && (
          <div
            role="menu"
            aria-label={t("videoPlayer.rate")}
            onKeyDown={handleSpeedMenuKeyDown}
            className="absolute bottom-full left-1/2 mb-2 w-24 -translate-x-1/2 overflow-hidden rounded-md bg-black/90 py-1.5 shadow-2xl ring-1 ring-white/12 backdrop-blur"
          >
            {SPEEDS.map((speed, index) => (
              <button
                key={speed}
                ref={(item) => {
                  speedItemRefs.current[index] = item;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={rate === speed}
                tabIndex={-1}
                className={`flex w-full items-center justify-center gap-1.5 px-4 py-1.5 text-sm font-medium ${
                  rate === speed ? "text-[var(--video-accent)]" : "text-white"
                } hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/80`}
                onClick={() => {
                  onRate(speed);
                  setSpeedOpen(false);
                  speedTriggerRef.current?.focus();
                }}
              >
                <span className="flex w-3.5 flex-none justify-center">
                  {rate === speed && <Check className="h-3.5 w-3.5" />}
                </span>
                {formatRate(speed)}x
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onToggleSmartRate}
        aria-pressed={smartRate}
        aria-label={
          smartRate ? t("videoPlayer.smartRateOn") : t("videoPlayer.smartRateOff")
        }
        disabled={!smartRateAvailable && !smartRate}
        title={
          smartRateAvailable
            ? t("videoPlayer.smartRateHint")
            : smartRate
              ? t("videoPlayer.smartRateCloseNoTranscript")
              : t("videoPlayer.smartRateUnavailable")
        }
        className={`${textButtonClass} disabled:opacity-35 ${
          smartRate ? "bg-white/10 text-[var(--video-accent)] ring-1 ring-inset ring-[var(--video-accent)]/60" : ""
        }`}
      >
        {t("videoPlayer.smartRateLabel", {
          state: smartRate ? t("videoPlayer.smartRateEnabledState") : "",
        })}
      </button>
      <button
        type="button"
        onClick={onToggleSkipSilence}
        aria-pressed={skipSilence}
        aria-label={
          skipSilence
            ? t("videoPlayer.skipSilenceOn")
            : t("videoPlayer.skipSilenceOff")
        }
        disabled={!skipSilenceAvailable}
        title={
          !skipSilenceAvailable
            ? t("videoPlayer.skipSilenceUnsupported")
            : skipSilence
              ? skipSilenceLoading
                ? t("videoPlayer.skipSilenceAnalyzing")
                : t("videoPlayer.skipSilenceDisable")
              : t("videoPlayer.skipSilenceHint")
        }
        // 只靠文字变个色，开没开一眼看不出来（用户反馈「点了没反馈」）：
        // 开启时给一层强调色底＋描边，并在文字后面直接写「开」。
        className={`${textButtonClass} disabled:opacity-35 ${
          skipSilence
            ? "bg-white/10 text-[var(--video-accent)] ring-1 ring-inset ring-[var(--video-accent)]/60"
            : ""
        }`}
      >
        {t("videoPlayer.skipSilenceLabel", {
          state: skipSilence ? ` · ${skipSilenceLabel}` : "",
        })}
      </button>
      {showSkipNav && (
        <>
          <button
            type="button"
            onClick={() => prevSkipMs != null && onPreviewSkip(prevSkipMs)}
            disabled={prevSkipMs == null}
            aria-label={t("videoPlayer.previousPause")}
            title={t("videoPlayer.previousPauseHint")}
            className={`${iconButtonClass} disabled:opacity-35`}
          >
            <SkipBack className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => nextSkipMs != null && onPreviewSkip(nextSkipMs)}
            disabled={nextSkipMs == null}
            aria-label={t("videoPlayer.nextPause")}
            title={t("videoPlayer.nextPauseHint")}
            className={`${iconButtonClass} disabled:opacity-35`}
          >
            <SkipForward className="h-4 w-4" />
          </button>
        </>
      )}
      <button
        type="button"
        onClick={onToggleCrop}
        aria-pressed={cropOn}
        aria-label={cropOn ? t("videoPlayer.cropOn") : t("videoPlayer.cropOff")}
        title={
          hasCrop
            ? `${t("videoPlayer.cropDetected")}：${formatInsetsText(t, cropInsets)}。${
                cropOn ? t("videoPlayer.cropTurnOff") : t("videoPlayer.cropTurnOn")
              }`
            : cropOn
              ? t("videoPlayer.cropNoBars")
              : t("videoPlayer.cropHint")
        }
        className={`${textButtonClass} ${
          cropOn && hasCrop
            ? "bg-white/10 text-[var(--video-accent)] ring-1 ring-inset ring-[var(--video-accent)]/60"
            : ""
        }`}
      >
        {t("videoPlayer.cropBlackBars")}
      </button>
      <button
        type="button"
        onClick={onToggleCaptions}
        aria-pressed={captionsOn}
        title={captionsOn ? t("videoPlayer.captionsOff") : t("videoPlayer.captionsOn")}
        className={`${textButtonClass} ${
          captionsOn
            ? "bg-white/10 text-[var(--video-accent)] ring-1 ring-inset ring-[var(--video-accent)]/60"
            : ""
        }`}
      >
        {t("videoPlayer.captions")}
      </button>
      <Button
        size="icon"
        variant="ghost"
        onClick={onMuteToggle}
        title={muted ? t("videoPlayer.unmute") : t("videoPlayer.mute")}
        className={iconButtonClass}
      >
        {muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
      </Button>
      <input
        aria-label={t("videoPlayer.volume")}
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={muted ? 0 : volume}
        onChange={(event) => onVolume(Number(event.target.value))}
        className="course-video-volume hidden w-16 sm:block"
        style={
          {
            "--progress-percent": `${volumePercent}%`,
            "--video-control-color": "var(--video-accent)",
          } as CSSProperties
        }
      />
      </div>

      <div
        className="ca-player-mobile-more"
        data-player-more-menu
        aria-hidden={!compactControls || undefined}
        inert={!compactControls ? true : undefined}
      >
        <button
          ref={moreTriggerRef}
          type="button"
          className={iconButtonClass}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          aria-controls={moreOpen ? moreMenuId : undefined}
          aria-label={t("studyTab.more")}
          title={t("studyTab.more")}
          onClick={() => {
            setSpeedOpen(false);
            setMoreOpen((open) => !open);
          }}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>

        {moreOpen && (
          <>
            <button
              type="button"
              tabIndex={-1}
              aria-label={t("common.close")}
              className="ca-player-mobile-menu-backdrop"
              onClick={() => closeMoreMenu(false)}
            />
            <div
              ref={moreMenuRef}
              id={moreMenuId}
              role="menu"
              aria-label={t("studyTab.more")}
              onKeyDown={handleMoreMenuKeyDown}
              className="ca-player-mobile-menu"
            >
              <div
                role="presentation"
                className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase text-white/55"
              >
                {t("videoPlayer.rate")}
              </div>
              <div role="group" aria-label={t("videoPlayer.rate")}>
                {SPEEDS.map((speed) => (
                  <button
                    key={speed}
                    type="button"
                    role="menuitemradio"
                    aria-checked={rate === speed}
                    tabIndex={-1}
                    className={`${mobileMenuItemClass} ${
                      rate === speed ? "text-[var(--video-accent)]" : ""
                    }`}
                    onClick={() => runMoreAction(() => onRate(speed))}
                  >
                    <span className="flex w-4 flex-none justify-center">
                      {rate === speed && <Check className="h-4 w-4" />}
                    </span>
                    {formatRate(speed)}x
                  </button>
                ))}
              </div>

              <div role="separator" className="my-1 h-px bg-white/10" />

              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={smartRate}
                tabIndex={-1}
                disabled={!smartRateAvailable && !smartRate}
                title={
                  smartRateAvailable
                    ? t("videoPlayer.smartRateHint")
                    : smartRate
                      ? t("videoPlayer.smartRateCloseNoTranscript")
                      : t("videoPlayer.smartRateUnavailable")
                }
                className={`${mobileMenuItemClass} ${
                  smartRate ? "text-[var(--video-accent)]" : ""
                }`}
                onClick={() => runMoreAction(onToggleSmartRate)}
              >
                <span className="flex w-4 flex-none justify-center">
                  {smartRate && <Check className="h-4 w-4" />}
                </span>
                {t("videoPlayer.smartRateLabel", { state: "" })}
              </button>

              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={skipSilence}
                tabIndex={-1}
                disabled={!skipSilenceAvailable}
                title={
                  !skipSilenceAvailable
                    ? t("videoPlayer.skipSilenceUnsupported")
                    : skipSilence
                      ? skipSilenceLoading
                        ? t("videoPlayer.skipSilenceAnalyzing")
                        : t("videoPlayer.skipSilenceDisable")
                      : t("videoPlayer.skipSilenceHint")
                }
                className={`${mobileMenuItemClass} ${
                  skipSilence ? "text-[var(--video-accent)]" : ""
                }`}
                onClick={() => runMoreAction(onToggleSkipSilence)}
              >
                <span className="flex w-4 flex-none justify-center">
                  {skipSilence && <Check className="h-4 w-4" />}
                </span>
                {t("videoPlayer.skipSilenceLabel", {
                  state: skipSilence ? ` · ${skipSilenceLabel}` : "",
                })}
              </button>

              {showSkipNav && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    disabled={prevSkipMs == null}
                    title={t("videoPlayer.previousPauseHint")}
                    className={mobileMenuItemClass}
                    onClick={() => {
                      if (prevSkipMs != null) {
                        runMoreAction(() => onPreviewSkip(prevSkipMs));
                      }
                    }}
                  >
                    <span className="w-4 flex-none" />
                    {t("videoPlayer.previousPause")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    disabled={nextSkipMs == null}
                    title={t("videoPlayer.nextPauseHint")}
                    className={mobileMenuItemClass}
                    onClick={() => {
                      if (nextSkipMs != null) {
                        runMoreAction(() => onPreviewSkip(nextSkipMs));
                      }
                    }}
                  >
                    <span className="w-4 flex-none" />
                    {t("videoPlayer.nextPause")}
                  </button>
                </>
              )}

              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={cropOn}
                tabIndex={-1}
                title={
                  hasCrop
                    ? `${t("videoPlayer.cropDetected")}：${formatInsetsText(t, cropInsets)}。${
                        cropOn
                          ? t("videoPlayer.cropTurnOff")
                          : t("videoPlayer.cropTurnOn")
                      }`
                    : cropOn
                      ? t("videoPlayer.cropNoBars")
                      : t("videoPlayer.cropHint")
                }
                className={`${mobileMenuItemClass} ${
                  cropOn ? "text-[var(--video-accent)]" : ""
                }`}
                onClick={() => runMoreAction(onToggleCrop)}
              >
                <span className="flex w-4 flex-none justify-center">
                  {cropOn && <Check className="h-4 w-4" />}
                </span>
                {t("videoPlayer.cropBlackBars")}
              </button>

              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={captionsOn}
                tabIndex={-1}
                className={`${mobileMenuItemClass} ${
                  captionsOn ? "text-[var(--video-accent)]" : ""
                }`}
                onClick={() => runMoreAction(onToggleCaptions)}
              >
                <span className="flex w-4 flex-none justify-center">
                  {captionsOn && <Check className="h-4 w-4" />}
                </span>
                {t("videoPlayer.captions")}
              </button>

              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={muted || volume === 0}
                tabIndex={-1}
                className={`${mobileMenuItemClass} ${
                  muted || volume === 0 ? "text-[var(--video-accent)]" : ""
                }`}
                onClick={() => runMoreAction(onMuteToggle)}
              >
                <span className="flex w-4 flex-none justify-center">
                  {(muted || volume === 0) && <Check className="h-4 w-4" />}
                </span>
                {t("videoPlayer.mute")}
              </button>
            </div>
          </>
        )}
      </div>
      <Button
        size="icon"
        variant="ghost"
        onClick={onFullscreenToggle}
        aria-label={
          fullscreen ? t("videoPlayer.exitFullscreen") : t("videoPlayer.fullscreen")
        }
        title={fullscreen ? t("videoPlayer.exitFullscreen") : t("videoPlayer.fullscreen")}
        className={iconButtonClass}
      >
        {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
      </Button>
    </div>
  );
}
