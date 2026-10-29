import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 麦克风录音（费曼复述用）：开始 / 停止、计时、给波形用的实时音量，停下后交出 data URL。
 *
 * WebView 里的录音能力因平台而异（WKWebView / WebView2 / Android WebView 的权限与编码都不同），
 * 所以先探测、录不了就明说，调用方退回「打字也行」——录音只是更顺手的输入方式，不是唯一入口。
 */

/** 讲一个知识点，三分钟足够；再长多半是忘了停。 */
export const MAX_RECORDING_MS = 180_000;
const LEVEL_BARS = 24;

export type RecorderState =
  | { status: "idle" }
  | { status: "recording"; elapsedMs: number }
  | { status: "error"; reason: "denied" | "unavailable" | "failed" };

/** 这个 WebView 能不能录音（不弹权限，只看接口在不在）。 */
export function canRecord(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window !== "undefined" &&
    typeof window.MediaRecorder === "function"
  );
}

/** 选一个这个引擎支持的编码：Chromium 系 WebM/Opus，WebKit 系 MP4/AAC。 */
export function pickMimeType(isSupported: (type: string) => boolean): string | undefined {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find(isSupported);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("读取录音失败"));
    reader.readAsDataURL(blob);
  });
}

export function useRecorder() {
  const [state, setState] = useState<RecorderState>({ status: "idle" });
  /** 最近一段时间的音量（0–1），画成一排竖条。 */
  const [levels, setLevels] = useState<number[]>(() => Array(LEVEL_BARS).fill(0));
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef(0);
  const startedAtRef = useRef(0);
  const resolveRef = useRef<((dataUrl: string | null) => void) | null>(null);
  /** 到三分钟自动停下时没人在等 stop()：录到的东西放在这里，调用方取走。 */
  const [autoClip, setAutoClip] = useState<string | null>(null);

  const teardown = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    setLevels(Array(LEVEL_BARS).fill(0));
  }, []);

  useEffect(
    () => () => {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      teardown();
    },
    [teardown],
  );

  const start = useCallback(async () => {
    if (!canRecord()) {
      setState({ status: "error", reason: "unavailable" });
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const name = (error as DOMException)?.name;
      setState({
        status: "error",
        reason: name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable",
      });
      return;
    }
    streamRef.current = stream;
    const mimeType = pickMimeType((type) => MediaRecorder.isTypeSupported?.(type) ?? false);
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      teardown();
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
      const resolve = resolveRef.current;
      resolveRef.current = null;
      setState({ status: "idle" });
      if (blob.size === 0) {
        resolve?.(null);
        return;
      }
      blobToDataUrl(blob).then(
        (url) => (resolve ? resolve(url) : setAutoClip(url)),
        () => resolve?.(null),
      );
    };
    recorderRef.current = recorder;

    // 波形：分析器取音量，每帧推一格。拿不到 AudioContext 也照样录，只是没有波形。
    try {
      const context = new AudioContext();
      audioContextRef.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Uint8Array(analyser.fftSize);
      let lastPush = 0;
      const tick = (now: number) => {
        analyser.getByteTimeDomainData(buffer);
        let peak = 0;
        for (const value of buffer) peak = Math.max(peak, Math.abs(value - 128) / 128);
        const elapsed = Date.now() - startedAtRef.current;
        if (now - lastPush > 80) {
          lastPush = now;
          setLevels((current) => [...current.slice(1), Math.min(1, peak * 1.6)]);
          setState({ status: "recording", elapsedMs: elapsed });
        }
        if (elapsed >= MAX_RECORDING_MS && recorder.state === "recording") recorder.stop();
        frameRef.current = requestAnimationFrame(tick);
      };
      frameRef.current = requestAnimationFrame(tick);
    } catch {
      // 没有波形不影响录音。
    }

    startedAtRef.current = Date.now();
    recorder.start(1000);
    setState({ status: "recording", elapsedMs: 0 });
  }, [teardown]);

  /** 停止录音，交出录到的 data URL（没录到东西返回 null）。 */
  const stop = useCallback((): Promise<string | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "recording") return Promise.resolve(null);
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      recorder.stop();
    });
  }, []);

  return {
    state,
    levels,
    start,
    stop,
    supported: canRecord(),
    autoClip,
    takeAutoClip: () => {
      const clip = autoClip;
      setAutoClip(null);
      return clip;
    },
  };
}
