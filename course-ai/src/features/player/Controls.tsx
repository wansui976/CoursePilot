import {
  nextSkipPreviewMs,
  prevSkipPreviewMs,
  type SkipRange,
} from "@/lib/silenceSkip";
import { formatMs } from "@/lib/time";
import type { Insets } from "@/lib/blackBars";
import type { Chapter } from "@/lib/types";
import { formatInsetsText } from "./useVideoCrop";
import { usePlayer } from "@/stores/player";
import { useContainerWidth } from "@/lib/useContainerWidth";
import {
  CAPTION_BACKGROUNDS,
  CAPTION_SIZES,
  useCaptionPrefs,
  type CaptionMode,
} from "@/stores/captionPrefs";
import {
  Captions,
  Check,
  Maximize,
  MessageSquareOff,
  MessageSquareText,
  Minimize,
  Pause,
  Play,
  Settings,
  SkipBack,
  SkipForward,
  Volume1,
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
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

const SPEEDS = [2, 1.5, 1.25, 1, 0.75, 0.5];
const CAPTION_MODES: CaptionMode[] = ["original", "bilingual", "translation"];
const NO_CHAPTERS: Chapter[] = [];

// 控制栏浮在画面上（底部有一层黑色渐变托底），所以无论应用是浅色还是深色主题，
// 按钮一律白色——和 YouTube / B 站一样，跟着画面走，不跟着应用主题走。
const iconButtonClass =
  "relative flex h-9 w-9 flex-none items-center justify-center rounded-full text-white/90 transition hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-35";
const textButtonClass =
  "h-9 flex-none whitespace-nowrap rounded-full px-2.5 text-[13px] font-semibold tabular-nums text-white/90 transition hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";
const menuItemClass =
  "flex min-h-9 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-[13px] font-medium text-white transition hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40";
const popoverClass =
  "ca-player-popover absolute bottom-full mb-2 overflow-y-auto overscroll-contain rounded-xl p-1.5 text-white";

function chipClass(selected: boolean) {
  return `min-h-8 min-w-0 flex-1 rounded-md px-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
    selected ? "bg-white text-black" : "bg-white/10 text-white/85 hover:bg-white/20"
  }`;
}

function formatRate(rate: number) {
  const rounded = Math.round(rate * 100) / 100;
  return Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded);
}

/** 菜单里的开关外观；语义由外层 menuitemcheckbox 的 aria-checked 承担。 */
function SwitchMark({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative ml-auto h-4 w-7 flex-none rounded-full transition-colors ${
        on ? "bg-[var(--video-accent)]" : "bg-white/25"
      }`}
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.3)] transition-[left] ${
          on ? "left-3.5" : "left-0.5"
        }`}
      />
    </span>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      role="presentation"
      className="px-3 pb-1 pt-2 text-[11px] font-semibold tracking-wide text-white/50"
    >
      {children}
    </div>
  );
}

/** 一行分段选择（字号、底色…）：左边标签，右边一排 menuitemradio 小块。 */
function ChoiceRow<T extends string>({
  label,
  options,
  value,
  optionLabel,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  optionLabel: (option: T) => string;
  onChange: (option: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-2 px-3 py-1">
      <span className="w-12 flex-none text-xs text-white/60">{label}</span>
      <div className="flex flex-1 gap-1">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="menuitemradio"
            aria-checked={value === option}
            tabIndex={-1}
            className={chipClass(value === option)}
            onClick={() => onChange(option)}
          >
            {optionLabel(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 菜单里方向键 / Home / End 在所有可用项之间移动，Esc 关闭并把焦点还给触发按钮。 */
function moveMenuFocus(
  event: ReactKeyboardEvent<HTMLDivElement>,
  onEscape: () => void,
  onTab?: () => void,
) {
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])'),
  );
  const currentIndex = items.findIndex((item) => item === document.activeElement);
  let nextIndex: number;

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
      onEscape();
      return;
    case "Tab":
      onTab?.();
      return;
    default:
      return;
  }

  if (items.length === 0) return;
  event.preventDefault();
  items[nextIndex]?.focus();
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
  danmakuAvailable,
  danmakuOn,
  translationAvailable = false,
  chapters = NO_CHAPTERS,
  onToggleCrop,
  onToggleCaptions,
  onToggleDanmaku,
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
  /** 有弹幕数据（B 站视频且抓到了）才出弹幕开关。 */
  danmakuAvailable: boolean;
  danmakuOn: boolean;
  /** 有当前语言的译文才在设置里出「原文 / 双语 / 译文」。 */
  translationAvailable?: boolean;
  /** 章节：时间后面跟着显示当前所在章节名（YouTube 式）。 */
  chapters?: Chapter[];
  onToggleCrop: () => void;
  onToggleCaptions: () => void;
  onToggleDanmaku: () => void;
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
  const captionMode = useCaptionPrefs((s) => s.mode);
  const captionSize = useCaptionPrefs((s) => s.size);
  const captionBackground = useCaptionPrefs((s) => s.background);
  const setCaptionMode = useCaptionPrefs((s) => s.setMode);
  const setCaptionSize = useCaptionPrefs((s) => s.setSize);
  const setCaptionBackground = useCaptionPrefs((s) => s.setBackground);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuMaxHeight, setMenuMaxHeight] = useState<number | undefined>(undefined);
  const settingsMenuId = useId();
  const speedTriggerRef = useRef<HTMLButtonElement>(null);
  const speedMenuRef = useRef<HTMLDivElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const controlsRootRef = useRef<HTMLDivElement>(null);
  // 分栏会让播放器远窄于窗口；控制组必须按自身可用宽度收起，而不是按 viewport 猜测。
  // 只有真正窄（compact <600px，手机分栏/极窄）才把倍速、弹幕也收进设置菜单；
  // medium（600–899）在工作台分栏下完全放得下整排按钮，应继续平铺。
  const compactControls = useContainerWidth(controlsRootRef) === "compact";
  // 首次开启要扫一遍音轨，几秒内还跳不了；直说，别让人以为已经在跳了。
  const skipSilenceStatus = skipSilence
    ? skipSilenceLoading
      ? t("videoPlayer.skipSilenceAnalyzingShort")
      : t("videoPlayer.skipSilenceEnabledShort")
    : null;
  // 试跳：直接送到下一处/上一处停顿前 1.5 秒并接着播，不用守着整段视频等它跳。
  const prevSkipMs = prevSkipPreviewMs(skipRanges, currentMs);
  const nextSkipMs = nextSkipPreviewMs(skipRanges, currentMs);
  const showSkipNav = skipSilence && skipRanges.length > 0;
  // 一条边都没检测到时开关没有意义（也是「源片本来就带边」的线索）。
  // 但开关不置灰：探测只在播放中才跑，没测到不等于没有。
  const hasCrop = Object.values(cropInsets).some((v) => v > 0);
  const currentChapter =
    chapters.length > 0
      ? ([...chapters].reverse().find((chapter) => chapter.start_ms <= currentMs) ?? null)
      : null;
  // 设置齿轮上的小圆点：有「会改变播放行为」的开关开着，提醒一眼。
  const playbackTweaked = smartRate || skipSilence || (cropOn && hasCrop);
  const audible = !muted && volume > 0;
  const volumePercent = audible ? Math.min(100, Math.max(0, volume * 100)) : 0;

  const smartRateTitle = smartRateAvailable
    ? t("videoPlayer.smartRateHint")
    : smartRate
      ? t("videoPlayer.smartRateCloseNoTranscript")
      : t("videoPlayer.smartRateUnavailable");
  const skipSilenceTitle = !skipSilenceAvailable
    ? t("videoPlayer.skipSilenceUnsupported")
    : skipSilence
      ? skipSilenceLoading
        ? t("videoPlayer.skipSilenceAnalyzing")
        : t("videoPlayer.skipSilenceDisable")
      : t("videoPlayer.skipSilenceHint");
  const cropTitle = hasCrop
    ? `${t("videoPlayer.cropDetected")}：${formatInsetsText(t, cropInsets)}。${
        cropOn ? t("videoPlayer.cropTurnOff") : t("videoPlayer.cropTurnOn")
      }`
    : cropOn
      ? t("videoPlayer.cropNoBars")
      : t("videoPlayer.cropHint");

  useEffect(() => {
    if (speedOpen) {
      speedMenuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus();
    }
  }, [speedOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    settingsMenuRef.current
      ?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')
      ?.focus();
  }, [settingsOpen]);

  useEffect(() => {
    // 换布局时把菜单收起：倍速菜单只在宽布局有，设置菜单两种布局的摆法也不同。
    setSpeedOpen(false);
    setSettingsOpen(false);
  }, [compactControls]);

  // 菜单开着时：点菜单与触发按钮之外即收起；Esc 收起后把焦点还给触发按钮。
  useEffect(() => {
    if (!speedOpen && !settingsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (speedOpen && !target?.closest("[data-speed-menu]")) setSpeedOpen(false);
      // 窄布局的设置菜单有自己的遮罩，点遮罩收起，这里不管。
      if (settingsOpen && !compactControls && !target?.closest("[data-settings-menu]")) {
        setSettingsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (speedOpen) {
        setSpeedOpen(false);
        speedTriggerRef.current?.focus();
      }
      if (settingsOpen) {
        setSettingsOpen(false);
        settingsTriggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [speedOpen, settingsOpen, compactControls]);

  // 弹出菜单向上展开，高度不能超过播放器本身（矮的分栏播放器里会顶出去被裁掉）。
  function measureMenuMaxHeight() {
    const player = controlsRootRef.current?.closest<HTMLElement>("[data-video-player]");
    const height = player?.clientHeight ?? 0;
    setMenuMaxHeight(height > 0 ? Math.max(160, height - 72) : undefined);
  }

  const closeSpeedMenu = () => {
    setSpeedOpen(false);
    speedTriggerRef.current?.focus();
  };

  const closeSettingsMenu = (restoreFocus = true) => {
    setSettingsOpen(false);
    if (restoreFocus) settingsTriggerRef.current?.focus();
  };

  const speedChoices = (variant: "list" | "grid") =>
    SPEEDS.map((speed) => (
      <button
        key={speed}
        type="button"
        role="menuitemradio"
        aria-checked={rate === speed}
        tabIndex={-1}
        className={
          variant === "list"
            ? `${menuItemClass} justify-center ${rate === speed ? "text-[var(--video-accent)]" : ""}`
            : chipClass(rate === speed)
        }
        onClick={() => {
          onRate(speed);
          if (variant === "list") closeSpeedMenu();
        }}
      >
        {variant === "list" && (
          <span className="flex w-3.5 flex-none justify-center">
            {rate === speed && <Check className="h-3.5 w-3.5" />}
          </span>
        )}
        {formatRate(speed)}x
        {variant === "list" && <span className="w-3.5 flex-none" />}
      </button>
    ));

  const settingsMenu = (
    <div
      ref={settingsMenuRef}
      id={settingsMenuId}
      role="menu"
      data-player-menu=""
      aria-label={t("videoPlayer.settings")}
      onKeyDown={(event) =>
        moveMenuFocus(event, () => closeSettingsMenu(), () => setSettingsOpen(false))
      }
      className={
        compactControls ? "ca-player-mobile-menu" : `${popoverClass} right-0 w-72`
      }
      style={!compactControls && menuMaxHeight ? { maxHeight: menuMaxHeight } : undefined}
    >
      {compactControls && (
        <>
          <SectionLabel>{t("videoPlayer.rate")}</SectionLabel>
          <div role="group" aria-label={t("videoPlayer.rate")} className="grid grid-cols-3 gap-1 px-3 pb-1">
            {speedChoices("grid")}
          </div>
        </>
      )}

      <SectionLabel>{t("videoPlayer.settingsPlayback")}</SectionLabel>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={smartRate}
        tabIndex={-1}
        disabled={!smartRateAvailable && !smartRate}
        title={smartRateTitle}
        className={menuItemClass}
        onClick={onToggleSmartRate}
      >
        {t("videoPlayer.smartRateLabel", { state: "" })}
        <SwitchMark on={smartRate} />
      </button>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={skipSilence}
        tabIndex={-1}
        disabled={!skipSilenceAvailable}
        title={skipSilenceTitle}
        className={menuItemClass}
        onClick={onToggleSkipSilence}
      >
        {t("videoPlayer.skipSilenceLabel", { state: "" })}
        {skipSilenceLoading && skipSilenceStatus && (
          <span className="text-xs font-normal text-white/55">{skipSilenceStatus}</span>
        )}
        <SwitchMark on={skipSilence} />
      </button>
      {compactControls && showSkipNav && (
        <div className="flex gap-1 px-3 pb-1">
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={prevSkipMs == null}
            title={t("videoPlayer.previousPauseHint")}
            className={`${chipClass(false)} flex items-center justify-center gap-1.5 disabled:opacity-35`}
            onClick={() => {
              if (prevSkipMs != null) onPreviewSkip(prevSkipMs);
            }}
          >
            <SkipBack className="h-3.5 w-3.5" />
            {t("videoPlayer.previousPause")}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={nextSkipMs == null}
            title={t("videoPlayer.nextPauseHint")}
            className={`${chipClass(false)} flex items-center justify-center gap-1.5 disabled:opacity-35`}
            onClick={() => {
              if (nextSkipMs != null) onPreviewSkip(nextSkipMs);
            }}
          >
            {t("videoPlayer.nextPause")}
            <SkipForward className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={cropOn}
        tabIndex={-1}
        title={cropTitle}
        className={menuItemClass}
        onClick={onToggleCrop}
      >
        {t("videoPlayer.cropBlackBars")}
        <SwitchMark on={cropOn} />
      </button>
      {compactControls && danmakuAvailable && (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={danmakuOn}
          tabIndex={-1}
          className={menuItemClass}
          onClick={onToggleDanmaku}
        >
          {t("videoPlayer.danmaku")}
          <SwitchMark on={danmakuOn} />
        </button>
      )}

      <div role="separator" className="mx-3 my-1.5 h-px bg-white/10" />
      <SectionLabel>{t("videoPlayer.settingsCaptions")}</SectionLabel>
      {translationAvailable && (
        <ChoiceRow
          label={t("videoPlayer.captionContent")}
          options={CAPTION_MODES}
          value={captionMode}
          optionLabel={(mode) => t(`videoPlayer.captionMode.${mode}`)}
          onChange={setCaptionMode}
        />
      )}
      <ChoiceRow
        label={t("videoPlayer.captionSize")}
        options={CAPTION_SIZES}
        value={captionSize}
        optionLabel={(size) => t(`videoPlayer.captionSizes.${size}`)}
        onChange={setCaptionSize}
      />
      <ChoiceRow
        label={t("videoPlayer.captionBackground")}
        options={CAPTION_BACKGROUNDS}
        value={captionBackground}
        optionLabel={(background) => t(`videoPlayer.captionBackgrounds.${background}`)}
        onChange={setCaptionBackground}
      />
    </div>
  );

  return (
    <div
      ref={controlsRootRef}
      data-controls-layout={compactControls ? "compact" : "full"}
      className="ca-player-controls flex items-center gap-0.5 text-sm text-white"
    >
      <button
        type="button"
        onClick={onPlayPause}
        aria-label={playing ? t("videoPlayer.pause") : t("videoPlayer.play")}
        title={playing ? t("videoPlayer.pause") : t("videoPlayer.play")}
        className={iconButtonClass}
      >
        {playing ? (
          <Pause className="h-5 w-5 fill-current" />
        ) : (
          <Play className="h-5 w-5 translate-x-px fill-current" />
        )}
      </button>

      {/* 音量：喇叭常显，滑块在悬停 / 键盘聚焦时向右展开（YouTube 式）。 */}
      <div className="ca-player-volume group/volume flex flex-none items-center">
        <button
          type="button"
          onClick={onMuteToggle}
          aria-label={audible ? t("videoPlayer.mute") : t("videoPlayer.unmute")}
          title={audible ? t("videoPlayer.mute") : t("videoPlayer.unmute")}
          className={iconButtonClass}
        >
          {!audible ? (
            <VolumeX className="h-5 w-5" />
          ) : volume < 0.5 ? (
            <Volume1 className="h-5 w-5" />
          ) : (
            <Volume2 className="h-5 w-5" />
          )}
        </button>
        <div className="flex w-0 items-center overflow-hidden opacity-0 transition-[width,opacity] duration-200 group-focus-within/volume:w-[72px] group-focus-within/volume:opacity-100 group-hover/volume:w-[72px] group-hover/volume:opacity-100">
          <input
            aria-label={t("videoPlayer.volume")}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={audible ? volume : 0}
            onChange={(event) => onVolume(Number(event.target.value))}
            className="course-video-volume ml-1 mr-2 w-[60px]"
            style={
              {
                "--progress-percent": `${volumePercent}%`,
                "--video-control-color": "#fff",
              } as CSSProperties
            }
          />
        </div>
      </div>

      <span className="ca-player-controls-time ml-1.5 whitespace-nowrap text-[13px] font-medium tabular-nums text-white/90">
        {formatMs(currentMs)}
        <span className="text-white/55"> / {formatMs(durationMs)}</span>
      </span>
      {currentChapter && !compactControls && (
        <span
          className="ml-2 min-w-0 truncate text-[13px] text-white/75"
          title={currentChapter.title}
        >
          <span aria-hidden="true" className="mr-2 text-white/40">·</span>
          {currentChapter.title}
        </span>
      )}

      <div className="min-w-2 flex-1" />

      {!compactControls && showSkipNav && (
        <>
          <button
            type="button"
            onClick={() => prevSkipMs != null && onPreviewSkip(prevSkipMs)}
            disabled={prevSkipMs == null}
            aria-label={t("videoPlayer.previousPause")}
            title={t("videoPlayer.previousPauseHint")}
            className={iconButtonClass}
          >
            <SkipBack className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => nextSkipMs != null && onPreviewSkip(nextSkipMs)}
            disabled={nextSkipMs == null}
            aria-label={t("videoPlayer.nextPause")}
            title={t("videoPlayer.nextPauseHint")}
            className={iconButtonClass}
          >
            <SkipForward className="h-4 w-4" />
          </button>
        </>
      )}

      {!compactControls && (
        <div className="relative flex-none" data-speed-menu>
          <button
            ref={speedTriggerRef}
            type="button"
            className={`${textButtonClass} ${effectiveRate !== 1 ? "text-[var(--video-accent)] hover:text-[var(--video-accent)]" : ""}`}
            aria-haspopup="menu"
            aria-expanded={speedOpen}
            aria-label={t("videoPlayer.rateCurrent", { rate: formatRate(effectiveRate) })}
            onClick={() => {
              setSettingsOpen(false);
              if (!speedOpen) measureMenuMaxHeight();
              setSpeedOpen((open) => !open);
            }}
          >
            {/* 菜单勾选基础倍速，触发按钮显示智能调速后的常态实际速度。 */}
            {effectiveRate === 1 ? t("videoPlayer.rate") : `${formatRate(effectiveRate)}x`}
          </button>
          {speedOpen && (
            <div
              ref={speedMenuRef}
              role="menu"
              data-player-menu=""
              aria-label={t("videoPlayer.rate")}
              onKeyDown={(event) => moveMenuFocus(event, closeSpeedMenu)}
              className={`${popoverClass} left-1/2 w-28 -translate-x-1/2`}
              style={menuMaxHeight ? { maxHeight: menuMaxHeight } : undefined}
            >
              {speedChoices("list")}
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onToggleCaptions}
        aria-label={t("videoPlayer.captions")}
        aria-pressed={captionsOn}
        title={captionsOn ? t("videoPlayer.captionsOff") : t("videoPlayer.captionsOn")}
        className={iconButtonClass}
      >
        <Captions className={`h-5 w-5 ${captionsOn ? "" : "opacity-70"}`} />
        {/* 开着时图标下面一道强调色短线（YouTube 的 CC 就是这么标的）。 */}
        <span
          aria-hidden="true"
          className={`absolute bottom-1 left-1/2 h-[3px] -translate-x-1/2 rounded-full bg-[var(--video-accent)] transition-[width,opacity] duration-150 ${
            captionsOn ? "w-4 opacity-100" : "w-0 opacity-0"
          }`}
        />
      </button>

      {!compactControls && danmakuAvailable && (
        <button
          type="button"
          onClick={onToggleDanmaku}
          aria-label={t("videoPlayer.danmaku")}
          aria-pressed={danmakuOn}
          title={danmakuOn ? t("videoPlayer.danmakuOff") : t("videoPlayer.danmakuOn")}
          className={iconButtonClass}
        >
          {danmakuOn ? (
            <MessageSquareText className="h-5 w-5" />
          ) : (
            <MessageSquareOff className="h-5 w-5 opacity-70" />
          )}
        </button>
      )}

      <div className="relative flex-none" data-settings-menu>
        <button
          ref={settingsTriggerRef}
          type="button"
          className={iconButtonClass}
          aria-haspopup="menu"
          aria-expanded={settingsOpen}
          aria-controls={settingsOpen ? settingsMenuId : undefined}
          aria-label={t("videoPlayer.settings")}
          title={t("videoPlayer.settings")}
          onClick={() => {
            setSpeedOpen(false);
            if (!settingsOpen) measureMenuMaxHeight();
            setSettingsOpen((open) => !open);
          }}
        >
          <Settings
            className={`h-5 w-5 transition-transform duration-300 ${settingsOpen ? "rotate-45" : ""}`}
          />
          {playbackTweaked && (
            <span
              aria-hidden="true"
              data-testid="settings-active-dot"
              className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[var(--video-accent)]"
            />
          )}
        </button>
        {settingsOpen &&
          (compactControls
            ? // 窄布局是一张固定在屏幕右下角的面板：挂到 body 上，跳出控制栏的层叠上下文，
              // 否则会被页面上的悬浮按钮（助手入口等）压住。
              createPortal(
                <>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t("common.close")}
                    className="ca-player-mobile-menu-backdrop"
                    onClick={() => closeSettingsMenu(false)}
                  />
                  {settingsMenu}
                </>,
                document.body,
              )
            : settingsMenu)}
      </div>

      <button
        type="button"
        onClick={onFullscreenToggle}
        aria-label={
          fullscreen ? t("videoPlayer.exitFullscreen") : t("videoPlayer.fullscreen")
        }
        title={fullscreen ? t("videoPlayer.exitFullscreen") : t("videoPlayer.fullscreen")}
        className={iconButtonClass}
      >
        {fullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
      </button>
    </div>
  );
}
