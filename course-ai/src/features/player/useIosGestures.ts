import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { APPLE_MAX_PLAYBACK_RATE, type GestureHint } from "./playerPrefs";

/**
 * iOS 沉浸式播放的手势层：左半边上下滑调亮度、右半边调音量、横滑拖进度、
 * 长按临时 2 倍速、单击切控制栏、双击切全屏。
 */

const TAP_DELAY_MS = 240;
const LONG_PRESS_MS = 360;
const TAP_MOVE_TOLERANCE_PX = 12;
const AXIS_LOCK_PX = 16;
const SCRUB_MS_PER_PIXEL = 100;
const BRIGHTNESS_STEP = 0.0025;
const VOLUME_STEP = 0.0025;

type GestureMode = "idle" | "brightness" | "volume" | "scrub";

export type GestureState = {
  pointerId: number;
  startX: number;
  startY: number;
  startTime: number;
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

export type TapState = { t: number; timer?: number };

function clearGestureTimer(gesture: GestureState | null) {
  if (!gesture) return;
  if (gesture.tapTimer) window.clearTimeout(gesture.tapTimer);
  if (gesture.longPressTimer) window.clearTimeout(gesture.longPressTimer);
}

export function useIosGestures({
  enabled,
  videoRef,
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
}: {
  enabled: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** 与 handleStageTap 共用：单/双击判定的上一击。 */
  tapRef: RefObject<TapState>;
  rate: number;
  volume: number;
  brightness: number;
  setBrightness: (value: number) => void;
  setVolume: (value: number) => void;
  setMuted: (value: boolean) => void;
  setGestureHint: (hint: GestureHint | null) => void;
  revealGestureHint: (kind: "brightness" | "volume" | "scrub", value: number) => void;
  revealControls: () => void;
  toggleControls: () => void;
  toggleFullscreen: () => void;
}) {
  const gestureRef = useRef<GestureState | null>(null);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!enabled || event.pointerType === "mouse") return;
    clearGestureTimer(gestureRef.current);
    const video = videoRef.current;
    const width = window.innerWidth || event.currentTarget.getBoundingClientRect().width || 0;
    const gesture: GestureState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTime: video?.currentTime ?? 0,
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
      const activeVideo = videoRef.current;
      if (!current || current.pointerId !== event.pointerId || !activeVideo) return;
      if (current.swiped || current.longPressActive) return;
      current.longPressActive = true;
      // 长按只临时改播放器的有效倍速，不能把已经叠过智能倍率的值写回基础 rate。
      const next = Math.min(APPLE_MAX_PLAYBACK_RATE, current.startRate * 2);
      activeVideo.playbackRate = next;
      setGestureHint({ kind: "rate", value: next });
    }, LONG_PRESS_MS);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !enabled) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if ((adx > TAP_MOVE_TOLERANCE_PX || ady > TAP_MOVE_TOLERANCE_PX) && gesture.longPressTimer) {
      window.clearTimeout(gesture.longPressTimer);
      gesture.longPressTimer = undefined;
    }
    if (gesture.mode === "idle") {
      if (adx < AXIS_LOCK_PX && ady < AXIS_LOCK_PX) return;
      gesture.mode = adx > ady ? "scrub" : gesture.side === "left" ? "brightness" : "volume";
    }
    if (gesture.mode === "brightness") {
      const next = Math.min(1, Math.max(0, gesture.startBrightness + (gesture.startY - event.clientY) * BRIGHTNESS_STEP));
      setBrightness(next);
      revealGestureHint("brightness", next);
      return;
    }
    if (gesture.mode === "volume") {
      const next = Math.min(1, Math.max(0, gesture.startVolume + (gesture.startY - event.clientY) * VOLUME_STEP));
      setVolume(next);
      setMuted(next === 0);
      revealGestureHint("volume", next);
      return;
    }
    if (gesture.mode === "scrub") {
      gesture.swiped = true;
      const video = videoRef.current;
      if (!video) return;
      const next = gesture.startTime + (dx * SCRUB_MS_PER_PIXEL) / 1000;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = Math.min(video.duration, Math.max(0, next));
      } else {
        video.currentTime = Math.max(0, next);
      }
      revealGestureHint("scrub", next);
    }
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !enabled) return;
    clearGestureTimer(gesture);
    const adx = Math.abs(event.clientX - gesture.startX);
    const ady = Math.abs(event.clientY - gesture.startY);
    if (gesture.longPressActive) {
      const video = videoRef.current;
      if (video) video.playbackRate = gesture.startRate;
      setGestureHint(null);
      revealControls();
    } else if (gesture.mode === "scrub" || (gesture.swiped && adx > ady)) {
      revealControls();
    } else {
      const now = Date.now();
      const prev = tapRef.current;
      if (now - prev.t < TAP_DELAY_MS) {
        if (prev.timer) window.clearTimeout(prev.timer);
        tapRef.current = { t: 0 };
        toggleFullscreen();
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

  function onPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !enabled) return;
    clearGestureTimer(gesture);
    if (gesture.longPressActive) {
      const video = videoRef.current;
      if (video) video.playbackRate = gesture.startRate;
      setGestureHint(null);
    }
    gestureRef.current = null;
  }

  return { gestureRef, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } };
}
