import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { TranscriptSegment } from "@/lib/types";
import { usePlayer } from "@/stores/player";
import { useNoteCapture } from "@/stores/noteCapture";
import { actionForKey, normalizeKey, useShortcuts } from "@/stores/shortcuts";
import { keyBelongsToTarget, type GestureHint } from "./playerPrefs";

const KEY_HOLD_MS = 200;
const KEY_HOLD_RATE = 2;
const KEY_REWIND_TICK_MS = 200;
const KEY_REWIND_STEP_S = 0.8;

type KeyScan = {
  action: "seekBack" | "seekForward";
  engaged: boolean;
  timer: number;
  interval?: number;
  prevRate?: number;
};

type KeyboardHandlers = {
  videoId: string;
  flashPlayState: (kind: "play" | "pause") => void;
  setGestureHint: (hint: GestureHint | null) => void;
  setMuted: Dispatch<SetStateAction<boolean>>;
  setVolume: Dispatch<SetStateAction<number>>;
  setCaptionsOn: Dispatch<SetStateAction<boolean>>;
  toggleFullscreen: () => void;
};

/** 跳到上一句/下一句字幕的开头；该视频还没有字幕时回退到 ±10s 快退/快进。 */
export function jumpSubtitle(video: HTMLVideoElement, segments: TranscriptSegment[], dir: -1 | 1) {
  if (segments.length === 0) {
    video.currentTime = dir < 0 ? Math.max(0, video.currentTime - 10) : video.currentTime + 10;
    return;
  }
  const nowMs = video.currentTime * 1000;
  if (dir > 0) {
    const next = segments.find((s) => s.start_ms > nowMs);
    video.currentTime = next ? next.start_ms / 1000 : video.duration || video.currentTime;
  } else {
    let targetMs = 0;
    for (const s of segments) {
      if (s.start_ms < nowMs) targetMs = s.start_ms;
      else break;
    }
    video.currentTime = Math.max(0, targetMs / 1000);
  }
}

/**
 * 键盘快捷键：动作 → 按键的映射在设置里可改（见 stores/shortcuts）。空格在未被
 * 占用时永远兜底为播放/暂停。聚焦输入框时不拦截，避免影响打字。
 *
 * 快退/快进键是 B 站式长短按：短按 ±5s（松键提交）；按住 ≥200ms 进入扫描——
 * 快进 = 2 倍速播放、快退 = 周期回退，松开恢复原倍速。
 * 2x 是 macOS WKWebView 完整逐帧解码的上限：超过 2x AVFoundation 会降级成
 * 只渲染关键帧（约 1 秒 1 帧）；Blink（网页版/Windows）没有这个限制。
 *
 * 返回长按扫描的状态 ref：扫描期间倍速由这里直接改，智能倍速不能去抢。
 */
export function usePlayerKeyboard(
  videoRef: RefObject<HTMLVideoElement | null>,
  segmentsRef: RefObject<TranscriptSegment[]>,
  handlers: KeyboardHandlers,
) {
  const keyScanRef = useRef<KeyScan | null>(null);
  // 监听只挂一次，处理函数读到的始终是最新一次渲染的回调。
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    // 结束长按流程。commitTap（keyup）：未进入扫描则补上短按 ±5s；
    // blur/卸载不补——用户没有完成一次「按一下」，且失焦后 keyup 会丢。
    const endKeyScan = (commitTap: boolean) => {
      const scan = keyScanRef.current;
      if (!scan) return;
      keyScanRef.current = null;
      window.clearTimeout(scan.timer);
      if (scan.interval) window.clearInterval(scan.interval);
      const video = videoRef.current;
      if (scan.engaged) {
        if (video && scan.prevRate != null) video.playbackRate = scan.prevRate;
        handlersRef.current.setGestureHint(null);
      } else if (commitTap && video) {
        video.currentTime =
          scan.action === "seekBack" ? Math.max(0, video.currentTime - 5) : video.currentTime + 5;
      }
    };

    const onKey = (event: KeyboardEvent) => {
      if (keyBelongsToTarget(event)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const video = videoRef.current;
      if (!video) return;
      const bindings = useShortcuts.getState().bindings;
      const action =
        actionForKey(bindings, event.key) ?? (normalizeKey(event.key) === " " ? "playPause" : null);
      if (!action) return;
      event.preventDefault();
      const h = handlersRef.current;
      const clamp = (v: number) => Math.min(1, Math.max(0, v));
      switch (action) {
        case "playPause":
          if (video.paused) {
            void video.play();
            h.flashPlayState("play");
          } else {
            video.pause();
            h.flashPlayState("pause");
          }
          break;
        case "seekBack":
        case "seekForward": {
          // 系统 auto-repeat 不打断长按流程；一次只允许一个方向键在按住。
          if (event.repeat || keyScanRef.current) break;
          const timer = window.setTimeout(() => {
            const scan = keyScanRef.current;
            const v = videoRef.current;
            if (!scan || !v) return;
            scan.engaged = true;
            if (scan.action === "seekForward") {
              scan.prevRate = v.playbackRate;
              v.playbackRate = KEY_HOLD_RATE;
              // 暂停中长按 = 直接以倍速开播（对齐 B 站）。
              if (v.paused) void v.play();
              handlersRef.current.setGestureHint({ kind: "rate", value: KEY_HOLD_RATE });
            } else {
              scan.interval = window.setInterval(() => {
                const vv = videoRef.current;
                if (vv) vv.currentTime = Math.max(0, vv.currentTime - KEY_REWIND_STEP_S);
              }, KEY_REWIND_TICK_MS);
              handlersRef.current.setGestureHint({ kind: "rewind", value: 0 });
            }
          }, KEY_HOLD_MS);
          keyScanRef.current = { action, engaged: false, timer };
          break;
        }
        case "prevSubtitle":
          jumpSubtitle(video, segmentsRef.current, -1);
          break;
        case "nextSubtitle":
          jumpSubtitle(video, segmentsRef.current, 1);
          break;
        case "volumeUp":
          h.setMuted(false);
          h.setVolume((v) => clamp(v + 0.1));
          break;
        case "volumeDown":
          h.setVolume((v) => clamp(v - 0.1));
          break;
        case "mute":
          h.setMuted((v) => !v);
          break;
        case "fullscreen":
          h.toggleFullscreen();
          break;
        case "captions":
          h.setCaptionsOn((v) => !v);
          break;
        case "takeNote":
          // 视频还没装载好（刚打开、尚未跳到上次进度）时 currentTime 还是 0，改用记录的进度。
          useNoteCapture
            .getState()
            .capture(h.videoId, video.readyState > 0 ? video.currentTime * 1000 : usePlayer.getState().currentMs);
          break;
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const scan = keyScanRef.current;
      if (!scan) return;
      const action = actionForKey(useShortcuts.getState().bindings, event.key);
      if (action === scan.action) endKeyScan(true);
    };
    const onBlur = () => endKeyScan(false);

    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      endKeyScan(false);
    };
  }, [videoRef, segmentsRef]);

  return keyScanRef;
}
