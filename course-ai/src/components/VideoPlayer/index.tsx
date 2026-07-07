import { useQuery } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { posKey, durKey } from "@/lib/playback";
import { isIOS } from "@/lib/platform";
import { usePlayer } from "@/stores/player";
import { actionForKey, normalizeKey, useShortcuts } from "@/stores/shortcuts";
import { CaptionOverlay } from "./CaptionOverlay";
import { Controls } from "./Controls";

// 距片尾 15s 内不再续播（视为看完），从头开始。
const RESUME_TAIL_GUARD = 15;
const TAP_DELAY_MS = 240;
const LONG_PRESS_MS = 360;
const TAP_MOVE_TOLERANCE_PX = 12;
const AXIS_LOCK_PX = 16;
const SCRUB_MS_PER_PIXEL = 100;
const BRIGHTNESS_STEP = 0.0025;
const VOLUME_STEP = 0.0025;

type GestureMode = "idle" | "brightness" | "volume" | "scrub";

type GestureState = {
  pointerId: number;
  startX: number;
  startY: number;
  startRate: number;
  startVolume: number;
  startBrightness: number;
  mode: GestureMode;
  side: "left" | "right";
  tapTimer?: number;
  longPressTimer?: number;
  longPressActive: boolean;
  swiped: boolean;
};

export function VideoPlayer({
  src,
  videoId,
  immersive = false,
  resizing = false,
}: {
  src: string;
  videoId: string;
  immersive?: boolean;
  // 工作台分隔条正在拖动:拖动期间冻结舞台尺寸,避免暂停静帧每帧重新栅格化导致卡顿。
  resizing?: boolean;
}) {
  const regionRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLVideoElement>(null);
  const lastSavedRef = useRef(0);
  const [videoAspect, setVideoAspect] = useState(16 / 9);
  const [region, setRegion] = useState({ w: 0, h: 0 });
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  // 控制栏可见性：桌面默认收起、悬停视频后展开；沉浸式（手机）进入时先显示一下、
  // 随后自动隐藏，之后点视频切换。
  const [controlsVisible, setControlsVisible] = useState(true);
  const [desktopControlsVisible, setDesktopControlsVisible] = useState(false);
  const hideControlsTimer = useRef<number | undefined>(undefined);
  const desktopHideTimer = useRef<number | undefined>(undefined);
  // 沉浸式单/双击判定：单击切控制栏、双击左右两侧 ±10s（中间播放/暂停）。
  const tapRef = useRef<{ t: number; timer?: number }>({ t: 0 });
  const gestureRef = useRef<GestureState | null>(null);
  const setCurrentMs = usePlayer((s) => s.setCurrentMs);
  const setDurationMs = usePlayer((s) => s.setDurationMs);
  const seekRequest = usePlayer((s) => s.seekRequest);
  // 不在这里订阅 currentMs（否则播放时整个播放器每秒重渲染 4 次）。
  // 进度由 Controls 自己订阅；字幕只在「跨段」时更新。
  const [caption, setCaption] = useState<string | undefined>(undefined);
  const [brightness, setBrightness] = useState(1);
  const [gestureHint, setGestureHint] = useState<{
    kind: "brightness" | "volume" | "scrub";
    value: number;
  } | null>(null);
  const gestureHintTimerRef = useRef<number | undefined>(undefined);

  const { data: segments = [] } = useQuery({
    queryKey: ["transcripts", videoId],
    queryFn: () => ipc.transcripts.list(videoId),
    refetchInterval: (query) =>
      query.state.data && query.state.data.length > 0 ? false : 2000,
  });

  // 字幕跳转用：始终持有按 start_ms 排好序的最新分句，供键盘处理器读取（避免闭包过期）。
  const segmentsRef = useRef<typeof segments>([]);
  useEffect(() => {
    segmentsRef.current = [...segments].sort((a, b) => a.start_ms - b.start_ms);
  }, [segments]);

  // 跟随播放进度更新字幕：订阅播放器 store，但只在字幕文本变化时才 setState，
  // 避免每个 currentMs tick 都重渲染。
  useEffect(() => {
    const compute = (ms: number) => {
      const text = segmentsRef.current.find(
        (segment) => ms >= segment.start_ms && ms < segment.end_ms,
      )?.text;
      setCaption((prev) => (prev === text ? prev : text));
    };
    compute(usePlayer.getState().currentMs);
    return usePlayer.subscribe((state) => compute(state.currentMs));
  }, [segments]);

  useLayoutEffect(() => {
    ref.current?.setAttribute("webkit-playsinline", "true");
  }, []);

  // 跟踪播放区实际尺寸，据此把舞台收成视频的真实宽高比，做到「完整不裁剪 + 不留黑边」。
  const resizingRef = useRef(resizing);
  useEffect(() => {
    const el = regionRef.current;
    if (!el) return;
    const update = () => {
      // 拖动分隔条期间不重算舞台尺寸：否则网格每帧重排，暂停的静帧会被反复栅格化（卡顿来源）。
      if (resizingRef.current) return;
      const w = el.clientWidth;
      const h = el.clientHeight;
      // 等值守卫：尺寸没变就不 setState，避免无谓重渲染。
      setRegion((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    // rAF 合帧：一帧内多次 resize 只算一次。
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    });
    ro.observe(el);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // 分隔条拖动状态翻转：拖动中冻结舞台尺寸，松手后一次性贴合最终宽度。
  useEffect(() => {
    resizingRef.current = resizing;
    if (resizing) return;
    const el = regionRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    setRegion((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
  }, [resizing]);

  // 在播放区内，求与视频同比例、尽可能大的居中矩形；视频铺满它即完整无黑边。
  const aspect = videoAspect > 0 ? videoAspect : 16 / 9;
  const stageBox = (() => {
    const { w, h } = region;
    if (!w || !h) return null;
    let boxW = w;
    let boxH = w / aspect;
    if (boxH > h) {
      boxH = h;
      boxW = h * aspect;
    }
    // 对齐到整数物理像素：暂停时的静态帧是按物理像素栅格化的，舞台落在半像素上会被
    // 重采样而发虚。先按 devicePixelRatio 取整再换回 CSS 像素，让缩放尽量无损。
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    return { width: snap(boxW), height: snap(boxH) };
  })();

  useEffect(() => {
    if (!ref.current || !seekRequest) return;
    ref.current.currentTime = seekRequest.ms / 1000;
  }, [seekRequest]);

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = rate;
  }, [rate]);

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
      if (ref.current && !ref.current.paused) setControlsVisible(false);
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
  function clearGestureTimer(gesture: GestureState | null) {
    if (!gesture) return;
    if (gesture.tapTimer) window.clearTimeout(gesture.tapTimer);
    if (gesture.longPressTimer) window.clearTimeout(gesture.longPressTimer);
  }
  function revealGestureHint(kind: "brightness" | "volume" | "scrub", value: number) {
    setGestureHint({ kind, value });
    if (gestureHintTimerRef.current) window.clearTimeout(gestureHintTimerRef.current);
    gestureHintTimerRef.current = window.setTimeout(() => setGestureHint(null), 650);
  }
  function handleIosPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!isIosImmersive || event.pointerType === "mouse") return;
    clearGestureTimer(gestureRef.current);
    const video = ref.current;
    const width = window.innerWidth || event.currentTarget.getBoundingClientRect().width || 0;
    const gesture: GestureState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRate: video?.playbackRate ?? rate,
      startVolume: volume,
      startBrightness: brightness,
      mode: "idle",
      side: event.clientX < width / 2 ? "left" : "right",
      longPressActive: false,
      swiped: false,
    };
    gestureRef.current = gesture;
    const target = event.currentTarget;
    if ("setPointerCapture" in target) {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // Safari/测试环境可能不支持，忽略即可。
      }
    }
    gesture.longPressTimer = window.setTimeout(() => {
      const current = gestureRef.current;
      const activeVideo = ref.current;
      if (!current || current.pointerId !== event.pointerId || !activeVideo) return;
      if (current.swiped || current.longPressActive) return;
      current.longPressActive = true;
      setRate(current.startRate * 2);
    }, LONG_PRESS_MS);
  }
  function handleIosPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !isIosImmersive) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (adx > TAP_MOVE_TOLERANCE_PX || ady > TAP_MOVE_TOLERANCE_PX) {
      if (gesture.longPressTimer) {
        window.clearTimeout(gesture.longPressTimer);
        gesture.longPressTimer = undefined;
      }
    }
    if (gesture.mode === "idle") {
      if (adx < AXIS_LOCK_PX && ady < AXIS_LOCK_PX) return;
      gesture.mode = adx > ady ? "scrub" : gesture.side === "left" ? "brightness" : "volume";
    }
    if (gesture.mode === "brightness") {
      const next = Math.min(
        1,
        Math.max(0, gesture.startBrightness + (gesture.startY - event.clientY) * BRIGHTNESS_STEP),
      );
      setBrightness(next);
      revealGestureHint("brightness", next);
      return;
    }
    if (gesture.mode === "volume") {
      const next = Math.min(
        1,
        Math.max(0, gesture.startVolume + (gesture.startY - event.clientY) * VOLUME_STEP),
      );
      setVolume(next);
      setMuted(next === 0);
      revealGestureHint("volume", next);
      return;
    }
    if (gesture.mode === "scrub") {
      gesture.swiped = true;
      const video = ref.current;
      if (!video) return;
      const next = video.currentTime + (dx * SCRUB_MS_PER_PIXEL) / 1000;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = Math.min(video.duration, Math.max(0, next));
      } else {
        video.currentTime = Math.max(0, next);
      }
      revealGestureHint("scrub", next);
    }
  }
  function handleIosPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !isIosImmersive) return;
    clearGestureTimer(gesture);
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (gesture.longPressActive) {
      setRate(gesture.startRate);
      revealControls();
    } else if (gesture.mode === "scrub" || (gesture.swiped && adx > ady)) {
      revealControls();
    } else {
      const now = Date.now();
      const prev = tapRef.current;
      if (now - prev.t < TAP_DELAY_MS) {
        if (prev.timer) window.clearTimeout(prev.timer);
        tapRef.current = { t: 0 };
        void setVideoFullscreen(!fullscreen);
      } else {
        const timer = window.setTimeout(() => {
          tapRef.current = { t: 0 };
          toggleControls();
        }, TAP_DELAY_MS);
        tapRef.current = { t: now, timer };
      }
    }
    gestureRef.current = null;
  }
  function handleIosPointerCancel(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !isIosImmersive) return;
    clearGestureTimer(gesture);
    if (gesture.longPressActive) {
      setRate(gesture.startRate);
    }
    gestureRef.current = null;
  }
  // 沉浸式（手机）点视频：区分单/双击。单击延后 240ms 才切控制栏，期间若来第二击则
  // 判为双击——按落点在视频左/中/右执行 后退10s / 播放暂停 / 前进10s。桌面不走这套。
  function handleStageTap(event: React.MouseEvent<HTMLDivElement>) {
    if (!immersive) return;
    const now = Date.now();
    const prev = tapRef.current;
    if (now - prev.t < 240) {
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
    }, 240);
    tapRef.current = { t: now, timer };
  }
  function revealDesktopControls() {
    if (immersive) return;
    clearDesktopHideTimer();
    setDesktopControlsVisible(true);
  }
  function scheduleDesktopHideControls() {
    if (immersive) return;
    clearDesktopHideTimer();
    desktopHideTimer.current = window.setTimeout(() => {
      setDesktopControlsVisible(false);
    }, 80);
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

  // 跳到上一句/下一句字幕的开头；该视频还没有字幕时回退到 ±10s 快退/快进。
  const jumpSubtitle = (dir: -1 | 1) => {
    const video = ref.current;
    if (!video) return;
    const segs = segmentsRef.current;
    if (segs.length === 0) {
      video.currentTime =
        dir < 0
          ? Math.max(0, video.currentTime - 10)
          : video.currentTime + 10;
      return;
    }
    const nowMs = video.currentTime * 1000;
    if (dir > 0) {
      const next = segs.find((s) => s.start_ms > nowMs);
      video.currentTime = next
        ? next.start_ms / 1000
        : video.duration || video.currentTime;
    } else {
      let targetMs = 0;
      for (const s of segs) {
        if (s.start_ms < nowMs) targetMs = s.start_ms;
        else break;
      }
      video.currentTime = Math.max(0, targetMs / 1000);
    }
  };

  // 键盘快捷键：动作 → 按键的映射在设置里可改（见 stores/shortcuts）。空格在未被
  // 占用时永远兜底为播放/暂停。聚焦输入框时不拦截，避免影响打字。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const video = ref.current;
      if (!video) return;
      const bindings = useShortcuts.getState().bindings;
      const action =
        actionForKey(bindings, event.key) ??
        (normalizeKey(event.key) === " " ? "playPause" : null);
      if (!action) return;
      event.preventDefault();
      const clamp = (v: number) => Math.min(1, Math.max(0, v));
      switch (action) {
        case "playPause":
          if (video.paused) void video.play();
          else video.pause();
          break;
        case "seekBack":
          video.currentTime = Math.max(0, video.currentTime - 5);
          break;
        case "seekForward":
          video.currentTime = video.currentTime + 5;
          break;
        case "prevSubtitle":
          jumpSubtitle(-1);
          break;
        case "nextSubtitle":
          jumpSubtitle(1);
          break;
        case "volumeUp":
          setMuted(false);
          setVolume((v) => clamp(v + 0.1));
          break;
        case "volumeDown":
          setVolume((v) => clamp(v - 0.1));
          break;
        case "mute":
          setMuted((v) => !v);
          break;
        case "fullscreen":
          toggleFullscreen();
          break;
        case "captions":
          setCaptionsOn((v) => !v);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  return (
    <div
      className={`flex flex-col ${
        fullscreen
          ? "fixed inset-0 z-50 bg-black"
          : "relative h-full min-h-0 bg-transparent"
      }`}
    >
      <div
        ref={regionRef}
        aria-label="课程视频舞台"
        onClick={immersive && !isIosImmersive ? handleStageTap : undefined}
        onMouseEnter={!immersive ? revealDesktopControls : undefined}
        onMouseLeave={!immersive ? scheduleDesktopHideControls : undefined}
        className={`relative flex min-h-0 w-full min-w-0 flex-1 items-center justify-center overflow-hidden ${
          fullscreen ? "bg-black" : "bg-[var(--surface-stage)]"
        }`}
      >
      <div
        ref={stageRef}
        className={`relative overflow-hidden ${fullscreen ? "" : "rounded-xl"}`}
        style={
          stageBox
              ? { width: stageBox.width, height: stageBox.height }
              : { width: "100%", height: "100%" }
          }
        >
          <video
            ref={ref}
            aria-label="课程视频播放器"
            src={src}
            playsInline
            disablePictureInPicture
            className={`h-full w-full bg-black object-contain ${isIosImmersive ? "pointer-events-none" : ""}`}
            // 提升到独立 GPU 合成层：暂停后让这一帧留在自己的层上，减少回退到
            // 「栅格化再缩放」的软化；backface-visibility 进一步固定层、避免半像素抖动。
            style={{
              transform: "translateZ(0)",
              willChange: "transform",
              backfaceVisibility: "hidden",
              filter: `brightness(${brightness})`,
            }}
            onTimeUpdate={(event) => {
              const t = event.currentTarget.currentTime;
              setCurrentMs(Math.floor(t * 1000));
              // 每 5 秒（或回退时）记录一次进度，避免频繁写 localStorage。
              if (Math.abs(t - lastSavedRef.current) >= 5) {
                lastSavedRef.current = t;
                const dur = event.currentTarget.duration;
                if (dur && t > dur - RESUME_TAIL_GUARD) {
                  localStorage.removeItem(posKey(videoId));
                } else if (t > 2) {
                  localStorage.setItem(posKey(videoId), String(t));
                }
              }
            }}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              setDurationMs(Math.floor(video.duration * 1000));
              // 记录总时长，供首页显示「时长 + 进度条」（DB 里 duration_ms 常为空）。
              if (Number.isFinite(video.duration) && video.duration > 0) {
                localStorage.setItem(durKey(videoId), String(video.duration));
              }
              const { videoWidth, videoHeight } = video;
              if (videoWidth > 0 && videoHeight > 0) {
                setVideoAspect(videoWidth / videoHeight);
              }
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
            }}
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
              if (t > 2 && (!dur || t < dur - RESUME_TAIL_GUARD)) {
                localStorage.setItem(posKey(videoId), String(t));
                lastSavedRef.current = t;
              }
            }}
              onVolumeChange={(event) => {
                setVolume(event.currentTarget.volume);
                setMuted(event.currentTarget.muted);
              }}
          />
          {isIosImmersive && (
            <div
              aria-label="课程视频手势层"
              className="absolute inset-0 z-10"
              onPointerDown={handleIosPointerDown}
              onPointerMove={handleIosPointerMove}
              onPointerUp={handleIosPointerUp}
              onPointerCancel={handleIosPointerCancel}
              style={{ touchAction: "none" }}
            />
          )}
          {gestureHint && (
            <div
              aria-label="亮度浮层"
              className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/20 text-white"
            >
              <div className="rounded-lg bg-black/70 px-4 py-2 text-sm font-medium">
                {gestureHint.kind === "brightness" && `亮度 ${(gestureHint.value * 100).toFixed(0)}%`}
                {gestureHint.kind === "volume" && `音量 ${(gestureHint.value * 100).toFixed(0)}%`}
                {gestureHint.kind === "scrub" && "进度调整"}
              </div>
            </div>
          )}
        </div>
        {/* 字幕定位相对「舞台」区域（含黑边），因此可拖到整个舞台内任意处，不限于视频画面框。 */}
        {captionsOn && caption && (
          <CaptionOverlay text={caption} containerRef={regionRef} />
        )}
      </div>
      <div
        aria-label="视频播放控制栏"
        aria-hidden={immersive ? !controlsVisible : !desktopControlsVisible}
        onClick={immersive ? (e) => e.stopPropagation() : undefined}
        onMouseEnter={!immersive ? revealDesktopControls : undefined}
        onMouseLeave={!immersive ? scheduleDesktopHideControls : undefined}
        onPointerDown={immersive ? () => revealControls() : undefined}
        className={
          immersive
            ? `absolute inset-x-0 bottom-0 z-10 transition-opacity duration-200 ${
                controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
              }`
            : // 桌面控制栏改为绝对定位悬浮在视频底边:收起时不再占据列布局高度,
              // 视频舞台(flex-1)直接铺到容器底部,不留空隙;悬停时浮现,不引起重排。
              `absolute inset-x-0 bottom-0 z-10 transition-opacity duration-200 ${
                desktopControlsVisible
                  ? "opacity-100"
                  : "pointer-events-none opacity-0"
              }`
        }
      >
        <Controls
          playing={playing}
          rate={rate}
          volume={volume}
          muted={muted}
          captionsOn={captionsOn}
          fullscreen={fullscreen}
          onToggleCaptions={() => setCaptionsOn((on) => !on)}
          onPlayPause={() => {
            const video = ref.current;
            if (!video) return;
            if (video.paused) {
              void video.play();
            } else {
              video.pause();
            }
          }}
          onSeek={(ms) => {
            if (ref.current) ref.current.currentTime = ms / 1000;
          }}
          onRate={setRate}
          onVolume={(value) => {
            setVolume(value);
            setMuted(value === 0);
          }}
          onMuteToggle={() => setMuted((value) => !value)}
          onFullscreenToggle={toggleFullscreen}
        />
      </div>
    </div>
  );
}
