import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/queries";
import { qk } from "@/lib/queryKeys";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cropStyle } from "@/lib/blackBars";
import { useSilenceSkip } from "@/lib/useSilenceSkip";
import { useSmartRate } from "@/lib/useSmartRate";
import { ipc } from "@/lib/ipc";
import { useVideoCrop } from "./useVideoCrop";
import { posKey, durKey, syncPlaybackProgress } from "@/lib/playback";
import { isIOS, isMobile } from "@/lib/platform";
import { findActiveSegmentIndex } from "@/lib/transcript";
import type { DanmakuEntry, TranscriptSegment } from "@/lib/types";
import { useVideoCoverUrl } from "@/lib/useVideoCoverUrl";
import { useWatchLogger } from "@/lib/useWatchLogger";
import { usePlayer } from "@/stores/player";
import { useNoteCapture } from "@/stores/noteCapture";
import { CaptionOverlay } from "./CaptionOverlay";
import { Controls } from "./Controls";
import { ChapterFeynmanPrompt } from "./ChapterFeynmanPrompt";
import { DanmakuOverlay } from "./DanmakuOverlay";
import { useCaptionPrefs, useTranslationLang } from "@/stores/captionPrefs";
import { MiniProgress, ProgressBar } from "./ProgressBar";
import {
  APPLE_MAX_PLAYBACK_RATE,
  loadDanmakuEnabled,
  loadPlaybackRate,
  persistDanmakuEnabled,
  persistPlaybackRate,
  usesApplePlaybackEngine,
  type GestureHint,
} from "./playerPrefs";
import { usePlayerKeyboard } from "./usePlayerKeyboard";
import { useHighlights } from "./useHighlights";
import { useIosGestures, type TapState } from "./useIosGestures";
import {
  AudioStage,
  DecodeFailureCard,
  GestureHintOverlay,
  PlayFlash,
  StageActionNotice,
  StageNotice,
  type TranscodeStatus,
} from "./StageOverlays";

/**
 * 手机上还没播过的视频不画首帧：Android WebView 画一张自带的灰底大播放图标盖住画面，
 * iOS 则整块留白，看着像没加载出来。所以移动端用视频封面当 poster；封面还没取到时
 * 先用透明图，只露出舞台底色。一旦开始播放或跳到上次的进度，真实画面照常出现。
 */
const TRANSPARENT_POSTER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// 距片尾 15s 内不再续播（视为看完），从头开始。
const RESUME_TAIL_GUARD = 15;
const TAP_DELAY_MS = 240;
// 桌面：鼠标在画面上停着不动这么久（且在播放）就收起控制栏和指针（YouTube 式）。
const DESKTOP_IDLE_HIDE_MS = 2500;
const EMPTY_TRANSCRIPT_SEGMENTS: TranscriptSegment[] = [];
const EMPTY_DANMAKU: DanmakuEntry[] = [];

export function VideoPlayer({
  src,
  videoId,
  immersive = false,
  onFullscreenChange,
  onTranscoded,
}: {
  src: string;
  videoId: string;
  immersive?: boolean;
  onFullscreenChange?: (fullscreen: boolean) => void;
  /** 本机转码完成：外层重新取一次 mediaUrl（此刻 data_dir 里已经有 playable.mp4）。 */
  onTranscoded?: () => void;
}) {
  const { t } = useTranslation();
  const regionRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLVideoElement>(null);
  // 控制栏实测高度：字幕据此在控制栏显示时上移，浮在其上方（控制栏悬浮遮住舞台底部）。
  const [controlsHeight, setControlsHeight] = useState(0);
  const lastSavedRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  // 纯音频源（播客、本地音频导入）：没有画面，舞台换成音频卡片而不是一整块空白。
  const [audioOnly, setAudioOnly] = useState(false);
  // 解码不了时把原因说出来。以前这里什么都不做：AV1 之类 WKWebView 解不了的编码
  // （老款 iPad / iPhone）就是一块黑屏，用户不知道是文件坏了还是设备不行。
  const [decodeFailure, setDecodeFailure] = useState<string | null>(null);
  // 端上转码进度（只 iOS 会真有这个状态）。解码失败后开始轮询：
  // 后端在 cmd_media_url 里已经点火，这里只负责显示进度和转完后的刷新。
  const [transcode, setTranscode] = useState<TranscodeStatus | null>(null);
  useEffect(() => {
    setAudioOnly(false);
    setDecodeFailure(null);
  }, [src]);
  // 把「播放中时长」记入学习事件日志（供仪表盘统计 / 间隔重复排期）。
  useWatchLogger(videoId, playing);
  // 「记一笔」（快捷键或笔记面板的按钮）：先暂停，写字时视频别往前跑。
  useEffect(
    () =>
      useNoteCapture.subscribe((state, previous) => {
        const request = state.request;
        if (!request || request === previous.request || request.videoId !== videoId) return;
        ref.current?.pause();
      }),
    [videoId],
  );
  // 离开/切换视频时把进度同步进库（暂停时也同步一次，见 onPause）。
  useEffect(() => {
    if (!videoId) return;
    return () => syncPlaybackProgress(videoId);
  }, [videoId]);
  // 费曼复述要录音：打开对话框时先暂停，免得麦克风把正在讲的课录进去。
  // 以挂载时的值为基准：对话框是在别的页面打开的（播放器没挂载）时，不该等视频一打开就暂停。
  const pauseRequest = usePlayer((s) => s.pauseRequest);
  const handledPauseRef = useRef(pauseRequest);
  useEffect(() => {
    if (pauseRequest === handledPauseRef.current) return;
    handledPauseRef.current = pauseRequest;
    ref.current?.pause();
  }, [pauseRequest]);
  // 父组件每次渲染都传一个新的内联回调；放进 ref，免得轮询跟着父组件重渲染一遍遍重启。
  const onTranscodedRef = useRef(onTranscoded);
  onTranscodedRef.current = onTranscoded;
  useEffect(() => {
    if (decodeFailure === null) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const status = await ipc.videos.transcodeStatus(videoId);
        if (cancelled) return;
        setTranscode(status);
        if (status.state === "done") {
          onTranscodedRef.current?.();
          return;
        }
      } catch {
        // 转码状态拿不到就当没有转码，不影响播放本身。
      }
      if (!cancelled) timer = window.setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [decodeFailure, videoId]);

  const [rate, setRate] = useState(loadPlaybackRate);
  const silenceSkip = useSilenceSkip(videoId);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    onFullscreenChange?.(fullscreen);
  }, [fullscreen, onFullscreenChange]);
  useEffect(
    () => () => {
      onFullscreenChange?.(false);
    },
    [onFullscreenChange],
  );
  // 控制栏可见性：桌面默认收起、悬停视频后展开；沉浸式（手机）进入时先显示一下、
  // 随后自动隐藏，之后点视频切换。
  const [controlsVisible, setControlsVisible] = useState(true);
  const [desktopControlsVisible, setDesktopControlsVisible] = useState(false);
  const hideControlsTimer = useRef<number | undefined>(undefined);
  const desktopHideTimer = useRef<number | undefined>(undefined);
  // 去黑边：状态、后台探测、stageBox 几何全在 hook 里，播放器只管把结果套到 video 上。
  const {
    cropOn,
    cropInsets,
    cropNotice,
    effectiveCrop,
    stageBox,
    toggleCrop,
    markMetadata,
    markPlayable,
  } = useVideoCrop(videoId, regionRef);
  // 沉浸式单/双击判定：单击切控制栏、双击左右两侧 ±10s（中间播放/暂停）。
  const tapRef = useRef<TapState>({ t: 0 });
  const setCurrentMs = usePlayer((s) => s.setCurrentMs);
  const mobile = isMobile();
  const coverUrl = useVideoCoverUrl(videoId, mobile);
  const setDurationMs = usePlayer((s) => s.setDurationMs);
  const seekRequest = usePlayer((s) => s.seekRequest);
  // 不在这里订阅 currentMs（否则播放时整个播放器每秒重渲染 4 次）。
  // 进度由 Controls 自己订阅；字幕只在「跨段」时更新。
  const [caption, setCaption] = useState<string | undefined>(undefined);
  const [captionTranslation, setCaptionTranslation] = useState<string | undefined>(undefined);
  const [brightness, setBrightness] = useState(1);
  const [gestureHint, setGestureHint] = useState<GestureHint | null>(null);
  const gestureHintTimerRef = useRef<number | undefined>(undefined);
  // 点画面 / 空格切换播放时，画面中央闪一下播放或暂停图标（YouTube 式），key 让动画每次重播。
  const [playFlash, setPlayFlash] = useState<{ kind: "play" | "pause"; key: number } | null>(null);
  const flashPlayState = (kind: "play" | "pause") =>
    setPlayFlash((prev) => ({ kind, key: (prev?.key ?? 0) + 1 }));
  const { data: queriedSegments } = useQuery(queries.transcripts(videoId));
  // 弹幕：B 站视频才有数据（其余源后端直接返回空）。库里没有时后端会先在线
  // 抓一次并缓存，首开可能慢几秒——抓到前开关不出现，不打扰本地视频。
  const { data: queriedDanmaku } = useQuery({
    queryKey: qk.danmaku(videoId),
    queryFn: () => ipc.danmaku.list(videoId),
    staleTime: Infinity,
  });
  const danmaku = queriedDanmaku ?? EMPTY_DANMAKU;
  // 章节：控制栏在时间后面显示当前章节名；与进度条、章节面板共用同一查询缓存。
  const { data: chapters } = useQuery(queries.chapters(videoId));
  // 字幕译文：本地库里读，翻过才有。原文模式下也读，用来决定要不要出「原文/双语/译文」切换。
  const captionMode = useCaptionPrefs((s) => s.mode);
  const translationLang = useTranslationLang(queriedSegments ?? EMPTY_TRANSCRIPT_SEGMENTS);
  const { data: translations } = useQuery({
    queryKey: qk.translations(videoId, translationLang),
    queryFn: () => ipc.translation.list(videoId, translationLang),
  });
  const translationByIdx = useMemo(
    () => new Map((translations ?? []).map((row) => [row.segment_idx, row.text])),
    [translations],
  );
  const [danmakuOn, setDanmakuOn] = useState(loadDanmakuEnabled);
  // 查询 pending 时保持同一个空数组引用，避免智能倍率计划被当作“新文稿”反复重建。
  const segments = queriedSegments ?? EMPTY_TRANSCRIPT_SEGMENTS;
  const applePlaybackEngine = useMemo(usesApplePlaybackEngine, []);
  const smartRate = useSmartRate(segments, {
    resetKey: videoId,
    maxEffectiveRate: applePlaybackEngine ? APPLE_MAX_PLAYBACK_RATE : undefined,
  });
  // 精华压缩版：水分段快放或跳过（优先级：跳过 > 快放 > 智能倍速）。
  // 传入有效倍速：基础倍速已经比快放档快时，快放档不能把它降下来。
  const highlights = useHighlights(videoId, {
    maxRate: applePlaybackEngine ? APPLE_MAX_PLAYBACK_RATE : undefined,
    baseRate: applePlaybackEngine
      ? Math.min(APPLE_MAX_PLAYBACK_RATE, rate * smartRate.multiplier)
      : rate * smartRate.multiplier,
  });
  const { rateFor: highlightRateFor, mode: highlightMode, segments: highlightSegments } = highlights;
  const effectiveRate = applePlaybackEngine
    ? Math.min(APPLE_MAX_PLAYBACK_RATE, rate * smartRate.multiplier)
    : rate * smartRate.multiplier;
  // 字幕跳转用：始终持有按 start_ms 排好序的最新分句，供键盘处理器读取（避免闭包过期）。
  const sortedSegments = useMemo(
    () => [...segments].sort((a, b) => a.start_ms - b.start_ms),
    [segments],
  );
  const segmentsRef = useRef<typeof segments>([]);
  useEffect(() => {
    segmentsRef.current = sortedSegments;
  }, [sortedSegments]);

  // 跟随播放进度更新字幕：订阅播放器 store，但只在字幕文本变化时才 setState，
  // 避免每个 currentMs tick 都重渲染。
  useEffect(() => {
    const compute = (ms: number) => {
      const index = findActiveSegmentIndex(sortedSegments, ms);
      const text = index >= 0 ? sortedSegments[index].text : undefined;
      setCaption((prev) => (prev === text ? prev : text));
      const translated =
        index >= 0 ? translationByIdx.get(sortedSegments[index].segment_idx) : undefined;
      setCaptionTranslation((prev) => (prev === translated ? prev : translated));
    };
    compute(usePlayer.getState().currentMs);
    return usePlayer.subscribe((state, previousState) => {
      if (state.currentMs !== previousState.currentMs) compute(state.currentMs);
    });
  }, [sortedSegments, translationByIdx]);

  useLayoutEffect(() => {
    ref.current?.setAttribute("webkit-playsinline", "true");
  }, []);

  // 跟踪控制栏高度，供字幕避让（控制栏内容/换行时高度会变）。
  useEffect(() => {
    const el = controlsRef.current;
    if (!el) return;
    const update = () => setControlsHeight(el.offsetHeight);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!ref.current || !seekRequest) return;
    ref.current.currentTime = seekRequest.ms / 1000;
  }, [seekRequest]);


  useEffect(() => {
    if (!ref.current) return;
    ref.current.volume = volume;
    ref.current.muted = muted || volume === 0;
  }, [muted, volume]);

  const isIosImmersive = immersive && isIOS();

  // 视频全屏：CSS 把播放器铺满视口（盖住应用其它 UI），同时让窗口铺满物理屏幕，
  // 视觉上就是纯视频全屏，而非「程序全屏」。WKWebView 不支持元素级全屏，所以走这套。
  const setVideoFullscreen = async (next: boolean) => {
    setFullscreen(next);
    try {
      await getCurrentWindow().setFullscreen(next);
    } catch {
      // 窗口全屏失败也无妨：CSS 覆盖已让视频铺满当前窗口。
    }
  };

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void setVideoFullscreen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
     
  }, [fullscreen]);

  const toggleFullscreen = () => void setVideoFullscreen(!fullscreen);

  // 沉浸式（手机）控制栏：默认显示，播放 3 秒后自动隐藏；点视频切换显隐；暂停时常显。
  // 倍速 / 设置菜单开着时不收控制栏（窄屏的设置面板挂在 body 上，不在 controlsRef 里）。
  function playerMenuOpen() {
    return document.querySelector("[data-player-menu]") != null;
  }
  function clearHideTimer() {
    if (hideControlsTimer.current) window.clearTimeout(hideControlsTimer.current);
  }
  function clearDesktopHideTimer() {
    if (desktopHideTimer.current) window.clearTimeout(desktopHideTimer.current);
  }
  function scheduleHideControls() {
    clearHideTimer();
    if (!immersive) return;
    hideControlsTimer.current = window.setTimeout(() => {
      if (
        ref.current &&
        !ref.current.paused &&
        !controlsRef.current?.contains(document.activeElement) &&
        !playerMenuOpen()
      ) {
        setControlsVisible(false);
      }
    }, 3000);
  }
  function revealControls() {
    setControlsVisible(true);
    scheduleHideControls();
  }
  function toggleControls() {
    if (controlsVisible) {
      clearHideTimer();
      setControlsVisible(false);
    } else {
      revealControls();
    }
  }
  function clearTapTimer() {
    if (tapRef.current.timer) window.clearTimeout(tapRef.current.timer);
    tapRef.current = { t: 0 };
  }
  function revealGestureHint(kind: "brightness" | "volume" | "scrub", value: number) {
    setGestureHint({ kind, value });
    if (gestureHintTimerRef.current) window.clearTimeout(gestureHintTimerRef.current);
    gestureHintTimerRef.current = window.setTimeout(() => setGestureHint(null), 650);
  }
  // 沉浸式（手机）点视频：区分单/双击。单击延后 240ms 才切控制栏，期间若来第二击则
  // 判为双击——按落点在视频左/中/右执行 后退10s / 播放暂停 / 前进10s。桌面不走这套。
  function handleStageTap(event: React.MouseEvent<HTMLDivElement>) {
    if (!immersive) return;
    const now = Date.now();
    const prev = tapRef.current;
    if (now - prev.t < TAP_DELAY_MS) {
      if (prev.timer) window.clearTimeout(prev.timer);
      tapRef.current = { t: 0 };
      const video = ref.current;
      if (!video) return;
      const rect = regionRef.current?.getBoundingClientRect();
      const zone = rect && rect.width ? (event.clientX - rect.left) / rect.width : 0.5;
      if (zone < 0.4) {
        video.currentTime = Math.max(0, video.currentTime - 10);
        revealControls();
      } else if (zone > 0.6) {
        video.currentTime = video.currentTime + 10;
        revealControls();
      } else if (video.paused) {
        void video.play();
      } else {
        video.pause();
      }
      return;
    }
    const timer = window.setTimeout(() => {
      tapRef.current = { t: 0 };
      toggleControls();
    }, TAP_DELAY_MS);
    tapRef.current = { t: now, timer };
  }
  // 菜单开着、焦点在控制栏里、指针停在控制栏上时都不收：用户正在操作它。
  function desktopControlsBusy() {
    const controls = controlsRef.current;
    if (!controls) return false;
    return (
      controls.contains(document.activeElement) ||
      playerMenuOpen() ||
      controls.matches(":hover")
    );
  }
  function revealDesktopControls() {
    if (immersive) return;
    clearDesktopHideTimer();
    setDesktopControlsVisible(true);
    // 播放中鼠标停住不动一会儿就收起；暂停时只要鼠标还在画面上就一直显示。
    desktopHideTimer.current = window.setTimeout(() => {
      if (ref.current && !ref.current.paused && !desktopControlsBusy()) {
        setDesktopControlsVisible(false);
      }
    }, DESKTOP_IDLE_HIDE_MS);
  }
  function scheduleDesktopHideControls() {
    if (immersive) return;
    clearDesktopHideTimer();
    desktopHideTimer.current = window.setTimeout(() => {
      if (!controlsRef.current?.contains(document.activeElement) && !playerMenuOpen()) {
        setDesktopControlsVisible(false);
      }
    }, 80);
  }
  // 桌面点画面：单击播放 / 暂停，双击全屏（两次单击一来一回抵消，和 YouTube 一样）。
  // 字幕框、弹幕高峰点等自己就是按钮，点它们不算点画面。
  function isStageSurface(target: EventTarget | null) {
    const el = target as HTMLElement | null;
    return !el?.closest("button, input, [role='menu'], a");
  }
  function handleDesktopStageClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!isStageSurface(event.target)) return;
    const video = ref.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
      flashPlayState("play");
    } else {
      video.pause();
      flashPlayState("pause");
    }
  }
  function handleDesktopStageDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!isStageSurface(event.target)) return;
    toggleFullscreen();
  }

  function revealControlsForKeyboard() {
    clearHideTimer();
    clearDesktopHideTimer();
    if (immersive) setControlsVisible(true);
    else setDesktopControlsVisible(true);
  }

  function handleControlsBlur(event: React.FocusEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    if (immersive) scheduleHideControls();
    else scheduleDesktopHideControls();
  }

  useEffect(() => {
    if (!immersive) {
      setDesktopControlsVisible(false);
      clearHideTimer();
      clearDesktopHideTimer();
      return;
    }
    // 沉浸式：进入时先显示一下让用户知道有控制栏，2.5s 后自动收起（无论是否在播放）。
    setControlsVisible(true);
    clearHideTimer();
    hideControlsTimer.current = window.setTimeout(
      () => setControlsVisible(false),
      2500,
    );
    return clearHideTimer;
     
  }, [immersive]);

  useEffect(
    () => () => {
      clearHideTimer();
      clearDesktopHideTimer();
      clearTapTimer();
      if (gestureHintTimerRef.current) window.clearTimeout(gestureHintTimerRef.current);
    },
    [],
  );

  const iosGestures = useIosGestures({
    enabled: isIosImmersive,
    videoRef: ref,
    tapRef,
    rate,
    volume,
    brightness,
    setBrightness,
    setVolume,
    setMuted,
    setGestureHint,
    revealGestureHint,
    revealControls,
    toggleControls,
    toggleFullscreen,
  });
  const gestureRef = iosGestures.gestureRef;

  useEffect(() => {
    // 智能倍速是在用户选的倍速之上叠加的倍率，所以这里生效的是两者之积。
    const video = ref.current;
    if (!video || gestureRef.current?.longPressActive) return;
    // 正在快放水分段：倍速由 onTimeUpdate 按段决定，这里不去改回来。
    const override = highlightRateFor(video.currentTime * 1000);
    // 媒体资源加载会把 playbackRate 还原为 defaultPlaybackRate；两者一起更新，
    // 切到目标倍速相同的新视频时也不会悄悄掉回 1x。
    video.defaultPlaybackRate = effectiveRate;
    // 任何倍速（含长按 2x）都保持变速不变调，否则音调会明显升高。
    video.preservesPitch = true;
    const target = override ?? effectiveRate;
    if (video.playbackRate !== target) video.playbackRate = target;
    // highlightRateFor 读的是 ref，档位 / 段落变化时跟着 mode、segments 重新套一次。
  }, [effectiveRate, gestureRef, src, highlightMode, highlightSegments, highlightRateFor]);

  const keyScanRef = usePlayerKeyboard(ref, segmentsRef, {
    videoId,
    flashPlayState,
    setGestureHint,
    setMuted,
    setVolume,
    setCaptionsOn,
    toggleFullscreen,
  });

  const playbackControlsVisible = immersive ? controlsVisible : desktopControlsVisible;
  // 桌面播放中控制栏因鼠标静止收起后，指针也一起藏起来，别在画面中间晃。
  const hideCursor = !immersive && playing && !desktopControlsVisible;

  return (
    <div
      data-video-player=""
      data-video-fullscreen={fullscreen ? "" : undefined}
      // iPadOS / WKWebView：长按视频会弹系统「复制 / 存储到照片」菜单并给画面套蓝框。
      // CSS 已把播放器表面设为不可选，这里再拦掉 contextmenu 兜一层；只作用于播放器，
      // 文稿、输入框等正文区不受影响。
      onContextMenu={(event) => event.preventDefault()}
      className={`flex flex-col ${
        fullscreen
          ? "fixed inset-0 z-50 bg-black"
          : "relative h-full min-h-0 bg-transparent"
      }`}
    >
      <div
        ref={regionRef}
        data-vt-stage=""
        aria-label={t("videoPlayer.stage")}
        tabIndex={0}
        onFocus={revealControlsForKeyboard}
        onClick={
          immersive ? (!isIosImmersive ? handleStageTap : undefined) : handleDesktopStageClick
        }
        onDoubleClick={!immersive ? handleDesktopStageDoubleClick : undefined}
        onMouseEnter={!immersive ? revealDesktopControls : undefined}
        onMouseMove={!immersive ? revealDesktopControls : undefined}
        onMouseLeave={!immersive ? scheduleDesktopHideControls : undefined}
        className={`relative flex min-h-0 w-full min-w-0 flex-1 items-center justify-center overflow-hidden ${
          fullscreen ? "bg-black" : audioOnly ? "bg-[#0b0d12]" : "bg-[var(--surface-stage)]"
        } ${hideCursor ? "cursor-none" : ""}`}
      >
        <div
          className="relative overflow-hidden"
          style={
            stageBox
              ? { width: stageBox.width, height: stageBox.height }
              : { width: "100%", height: "100%" }
          }
        >
          <video
            ref={ref}
            aria-label={t("videoPlayer.player")}
            data-theme-heavy=""
            src={src}
            poster={mobile ? (coverUrl ?? TRANSPARENT_POSTER) : undefined}
            playsInline
            disablePictureInPicture
            className={`h-full w-full object-contain ${
              fullscreen ? "bg-black" : audioOnly ? "bg-[#0b0d12]" : "bg-[var(--surface-stage)]"
            } ${isIosImmersive ? "pointer-events-none" : ""}`}
            // 提升到独立 GPU 合成层：暂停后让这一帧留在自己的层上，减少回退到
            // 「栅格化再缩放」的软化；backface-visibility 进一步固定层、避免半像素抖动。
            style={{
              ...(stageBox ? cropStyle(stageBox, effectiveCrop) : {}),
              transform: "translateZ(0)",
              willChange: "transform",
              backfaceVisibility: "hidden",
              // A no-op filter still creates extra compositing work for video frames.
              filter: brightness < 1 ? `brightness(${brightness})` : undefined,
            }}
            // 一开始跳转就把时间改成目标位置，不等跳转完成：没缓冲到的位置要先拉一段数据，
            // Android 上常要一两秒，这期间进度条会弹回原处、时间还是旧的，此时点「标记起点」
            // 记下的也是旧时间。所有跳转（拖进度条、快进快退、点章节 / 文稿）都经过这里。
            onSeeking={(event) => {
              setCurrentMs(Math.floor(event.currentTarget.currentTime * 1000));
              // 用户自己选了位置：跳过档这一帧不要把他弹走（连按后退才退得回去）。
              highlights.noteSeek();
            }}
            onTimeUpdate={(event) => {
              // 精华版跳过档、跳停顿：落在要跳的区间里就直接跃过去，跳完这一轮不再按旧位置记进度。
              if (highlights.handleTimeUpdate(event.currentTarget)) return;
              if (silenceSkip.handleTimeUpdate(event.currentTarget)) return;
              const t = event.currentTarget.currentTime;
              // 长按快进时播放器的 playbackRate 由手势直接改，这时别去抢。
              if (!keyScanRef.current?.engaged && !gestureRef.current?.longPressActive) {
                smartRate.update(t * 1000, rate);
                // 精华版快放档：进出水分段时切倍速（只改播放器的有效倍速，不动用户选的基础倍速）。
                const target = highlights.rateFor(t * 1000) ?? effectiveRate;
                if (Math.abs(event.currentTarget.playbackRate - target) > 0.01) {
                  event.currentTarget.playbackRate = target;
                }
              }
              setCurrentMs(Math.floor(t * 1000));
              // 每 5 秒（或回退时）记录一次进度，避免频繁写 localStorage。
              if (Math.abs(t - lastSavedRef.current) >= 5) {
                lastSavedRef.current = t;
                const dur = event.currentTarget.duration;
                if (dur && t > dur - RESUME_TAIL_GUARD) {
                  // 看到尾部：记成整段时长（= 已看完）。以前是删掉记录，于是「已看完」
                  // 角标和仪表盘完成度反而永远不出现——看完一讲把它算成没看。
                  // 续播那边本来就会跳过尾部附近的位置，不会再从末尾开始播。
                  localStorage.setItem(posKey(videoId), String(dur));
                } else if (t > 2) {
                  localStorage.setItem(posKey(videoId), String(t));
                }
              }
            }}
            onError={(event) => {
              // code 4 = MEDIA_ERR_SRC_NOT_SUPPORTED：这类失败九成是编码问题，
              // 问一下后端这条片到底是什么编码，好让提示能落地。
              const code = event.currentTarget.error?.code;
              if (code !== 4 && event.currentTarget.error != null) return;
              setDecodeFailure("");
              void ipc.videos
                .codec(videoId)
                .then((codec) => setDecodeFailure(codec ?? "unknown"))
                .catch(() => setDecodeFailure("unknown"));
            }}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              // 记录视频固有比例，去黑边的 stageBox 要靠它做等比缩放。
              markMetadata(video.videoWidth, video.videoHeight);
              setAudioOnly(video.videoWidth === 0 && video.videoHeight === 0);
              // 有画面轨却解出来 0×0：WKWebView 遇到不支持的编码（AV1、hev1 封装的 HEVC）
              // 就是这样，不是纯音频。问一下编码把原因说出来，别退化成「音频」卡片。
              if (video.videoWidth === 0 && video.videoHeight === 0) {
                void ipc.videos
                  .codec(videoId)
                  .then((codec) => {
                    if (codec) setDecodeFailure(codec);
                  })
                  .catch(() => undefined);
              }
              // 某些 WebKit 版本在资源加载后才重置速率；metadata 到达时再兜底应用一次。
              video.defaultPlaybackRate = effectiveRate;
              video.playbackRate = effectiveRate;
              setDurationMs(Math.floor(video.duration * 1000));
              // 记录总时长，供首页显示「时长 + 进度条」（DB 里 duration_ms 常为空）。
              if (Number.isFinite(video.duration) && video.duration > 0) {
                localStorage.setItem(durKey(videoId), String(video.duration));
              }
              // 跨视频跳转优先：若有落在本视频的 pendingSeek（课程级搜索点来的），
              // 直接跳到该处、消费掉，压过断点续播。
              const pending = usePlayer.getState().pendingSeek;
              if (pending && pending.videoId === videoId) {
                video.currentTime = Math.max(0, pending.ms / 1000);
                usePlayer.getState().clearPendingSeek();
              } else {
                // 断点续播：恢复上次离开的位置。
                const saved = Number(localStorage.getItem(posKey(videoId)));
                if (
                  Number.isFinite(saved) &&
                  saved > 2 &&
                  video.duration &&
                  saved < video.duration - RESUME_TAIL_GUARD
                ) {
                  video.currentTime = saved;
                  lastSavedRef.current = saved;
                }
              }
            }}
            // 缓冲够起播了才放黑边探测进场：那一趟解码不该和首帧抢磁盘。
            onCanPlay={markPlayable}
            onPlay={() => {
              setPlaying(true);
              scheduleHideControls();
            }}
            onPause={(event) => {
              setPlaying(false);
              setControlsVisible(true);
              clearHideTimer();
              const t = event.currentTarget.currentTime;
              const dur = event.currentTarget.duration;
              if (t > 2) {
                // 尾部附近按「看完」记（同 onTimeUpdate）。
                const saved = dur && t > dur - RESUME_TAIL_GUARD ? dur : t;
                localStorage.setItem(posKey(videoId), String(saved));
                lastSavedRef.current = saved;
              }
              // 暂停是同步进库的好时机：完成度以库里那份为准。
              syncPlaybackProgress(videoId);
            }}
            onVolumeChange={(event) => {
              setVolume(event.currentTarget.volume);
              setMuted(event.currentTarget.muted);
            }}
          />
          {audioOnly && <AudioStage playing={playing} />}
          {danmakuOn && danmaku.length > 0 && (
            <DanmakuOverlay entries={danmaku} videoRef={ref} />
          )}
          {isIosImmersive && (
            <div
              aria-label={t("videoPlayer.gestureLayer")}
              className="absolute inset-0 z-10"
              {...iosGestures.handlers}
              style={{ touchAction: "none" }}
            />
          )}
          {smartRate.notice && <StageNotice align="right">{smartRate.notice}</StageNotice>}
          {silenceSkip.notice && !highlights.notice && (
            <StageNotice align="center">{silenceSkip.notice}</StageNotice>
          )}
          {highlights.notice && (
            <StageActionNotice
              text={highlights.notice.text}
              actionLabel={highlights.notice.actionLabel}
              onAction={highlights.notice.onAction}
              onDismiss={highlights.dismissNotice}
            />
          )}
          {gestureHint && <GestureHintOverlay hint={gestureHint} />}
          {decodeFailure !== null && (
            <DecodeFailureCard
              codec={decodeFailure}
              transcode={transcode}
              onRetryTranscode={() => {
                void ipc.videos.startTranscode(videoId).then(setTranscode).catch(() => undefined);
              }}
            />
          )}
          {playFlash && (
            <PlayFlash key={playFlash.key} kind={playFlash.kind} onDone={() => setPlayFlash(null)} />
          )}
          {cropNotice && (
            <div className="pointer-events-none absolute inset-x-4 top-6 z-20 mx-auto w-fit max-w-full whitespace-pre-line rounded-lg bg-[var(--surface-stage-overlay)] px-3 py-1.5 text-center text-xs font-medium leading-relaxed text-white">
              {cropNotice}
            </div>
          )}
          <ChapterFeynmanPrompt videoId={videoId} chapters={chapters} />
        </div>
        {/* 字幕定位相对「舞台」区域（含黑边），因此可拖到整个舞台内任意处，不限于视频画面框。
            控制栏悬浮遮住舞台底部 controlsHeight 像素：字幕**常年**避开该占位区，
            而不是等控制栏可见才躲——否则每次唤出控制栏都先盖住字幕、等过渡完才让开，
            字幕还会随控制栏出没上下跳。 */}
        {/* 只按 captionsOn 挂载（不按 caption），换句时不卸载重挂——避免重挂时先以 0 高度
            算出最小字号、量到真实高度后再瞬间变大的跳变。空文本时组件内部返回 null。 */}
        {captionsOn && (
          <CaptionOverlay
            text={caption ?? ""}
            translation={captionTranslation}
            mode={captionMode}
            containerRef={regionRef}
            bottomInset={controlsHeight}
          />
        )}
      </div>
      <div
        ref={controlsRef}
        className="absolute inset-x-0 bottom-0 z-10"
        onMouseEnter={!immersive ? revealDesktopControls : undefined}
        onMouseLeave={!immersive ? scheduleDesktopHideControls : undefined}
        onPointerDown={immersive ? () => revealControls() : undefined}
      >
        {/* 托底渐变：只在控制栏唤出时出现，保证白色按钮在任何画面上都读得清（功能性，不是装饰）。 */}
        <div
          aria-hidden="true"
          data-allow-gradient=""
          className={`ca-player-scrim pointer-events-none transition-opacity duration-200 ${
            playbackControlsVisible ? "opacity-100" : "opacity-0"
          }`}
        />
        {/* 进度条在上、按钮行在下（YouTube / B 站布局）：桌面悬停浮现，沉浸式随点按显隐。 */}
        <div
          aria-label={t("videoPlayer.controls")}
          aria-hidden={!playbackControlsVisible}
          inert={playbackControlsVisible ? undefined : true}
          onFocusCapture={revealControlsForKeyboard}
          onBlurCapture={handleControlsBlur}
          onClick={immersive ? (e) => e.stopPropagation() : undefined}
          className={`relative transition-opacity duration-200 ${
            playbackControlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <ProgressBar
            videoId={videoId}
            skipRanges={silenceSkip.ranges}
            highlightSegments={highlights.mode === "off" ? undefined : highlights.segments}
            danmaku={danmakuOn ? danmaku : undefined}
            onSeek={(ms) => {
              if (ref.current) ref.current.currentTime = ms / 1000;
            }}
          />
          <div className="ca-player-controls-shell">
            <Controls
              playing={playing}
              rate={rate}
              effectiveRate={effectiveRate}
              volume={volume}
              muted={muted}
              captionsOn={captionsOn}
              smartRate={smartRate.enabled}
              smartRateAvailable={smartRate.available}
              skipSilence={silenceSkip.enabled}
              skipSilenceAvailable={silenceSkip.available}
              skipSilenceLoading={silenceSkip.loading}
              skipRanges={silenceSkip.ranges}
              // 还没有文稿就没什么可标的：整节不显示，别让用户点了生成才收到一条失败提示。
              highlights={
                segments.length > 0
                  ? {
                      available: highlights.available,
                      generating: highlights.generating,
                      generateError: highlights.generateError,
                      mode: highlights.mode,
                      strength: highlights.strength,
                      savedMs: highlights.savedMs(effectiveRate),
                      onGenerate: highlights.generate,
                    }
                  : undefined
              }
              cropOn={cropOn}
              cropInsets={cropInsets}
              fullscreen={fullscreen}
              danmakuAvailable={danmaku.length > 0}
              danmakuOn={danmakuOn}
              translationAvailable={translationByIdx.size > 0}
              chapters={chapters}
              onToggleCrop={toggleCrop}
              onToggleCaptions={() => setCaptionsOn((on) => !on)}
              onToggleDanmaku={() => {
                const next = !danmakuOn;
                setDanmakuOn(next);
                persistDanmakuEnabled(next);
              }}
              onToggleSmartRate={smartRate.toggle}
              onToggleSkipSilence={silenceSkip.toggle}
              onPreviewSkip={(ms) => {
                // 试跳要「看得到跳」：暂停着不会触发跳过判定，所以顺手接着播。
                const video = ref.current;
                if (!video) return;
                video.currentTime = ms / 1000;
                if (video.paused) void video.play();
              }}
              onPlayPause={() => {
                const video = ref.current;
                if (!video) return;
                if (video.paused) {
                  void video.play();
                } else {
                  video.pause();
                }
              }}
              onRate={(nextRate) => {
                setRate(nextRate);
                persistPlaybackRate(nextRate);
              }}
              onVolume={(value) => {
                setVolume(value);
                setMuted(value === 0);
              }}
              onMuteToggle={() => setMuted((value) => !value)}
              onFullscreenToggle={toggleFullscreen}
            />
          </div>
        </div>
        {/* 控制栏收起时：画面最底边留一条 2px 进度细线（B 站式）。 */}
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 transition-opacity duration-200 ${
            playbackControlsVisible ? "opacity-0" : "opacity-100"
          }`}
        >
          <MiniProgress />
        </div>
      </div>
    </div>
  );
}
