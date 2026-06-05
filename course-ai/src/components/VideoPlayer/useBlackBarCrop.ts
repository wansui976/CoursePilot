import { useEffect, useState } from "react";
import { detectBlackBars, type Insets, NO_INSETS } from "@/lib/blackBars";

const SAMPLE_W = 160; // 缩略宽，检测足够且开销极低
const FALLBACK_TIMES = [2, 5, 10]; // 拿不到 duration 时的固定采样点（秒）

/** 取每条边在多帧里的最小黑边（暗场景会误报，取最小绝不误切内容）。 */
function minInsets(frames: Insets[]): Insets {
  return frames.reduce(
    (acc, f) => ({
      top: Math.min(acc.top, f.top),
      right: Math.min(acc.right, f.right),
      bottom: Math.min(acc.bottom, f.bottom),
      left: Math.min(acc.left, f.left),
    }),
    { top: 1, right: 1, bottom: 1, left: 1 },
  );
}

/** seek 到 t 秒并在 seeked 后把当前帧画进 canvas，取像素跑 detectBlackBars。 */
function sampleAt(
  video: HTMLVideoElement,
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  t: number,
): Promise<Insets | null> {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      try {
        const vw = video.videoWidth || SAMPLE_W;
        const vh = video.videoHeight || Math.round(SAMPLE_W * 0.5625);
        const cw = SAMPLE_W;
        const ch = Math.max(1, Math.round((SAMPLE_W * vh) / vw));
        canvas.width = cw;
        canvas.height = ch;
        ctx.drawImage(video, 0, 0, cw, ch);
        const { data } = ctx.getImageData(0, 0, cw, ch);
        resolve(detectBlackBars(data, cw, ch));
      } catch {
        resolve(null); // 跨域污染 / 取帧失败 → 放弃这帧
      }
    };
    video.addEventListener("seeked", onSeeked);
    try {
      video.currentTime = t;
    } catch {
      video.removeEventListener("seeked", onSeeked);
      resolve(null);
    }
  });
}

/**
 * 用离屏隐藏 <video> 加载同一 src，采样靠前的几帧检测黑边。
 * 任何失败都回退到无黑边，播放器走原行为。每个 src 仅检测一次。
 */
export function useBlackBarCrop(src: string): {
  crop: Insets;
  hasBars: boolean;
} {
  const [crop, setCrop] = useState<Insets>(NO_INSETS);

  useEffect(() => {
    setCrop(NO_INSETS);
    if (!src) return;
    let cancelled = false;

    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    video.src = src;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // jsdom 等无 2d 上下文 → 维持无黑边

    const run = async () => {
      const dur = video.duration;
      const times =
        Number.isFinite(dur) && dur > 0
          ? [0.25, 0.5, 0.75].map((f) => dur * f)
          : FALLBACK_TIMES;
      const frames: Insets[] = [];
      for (const t of times) {
        if (cancelled) return;
        const f = await sampleAt(video, ctx, canvas, t);
        if (f) frames.push(f);
      }
      if (cancelled || frames.length === 0) return;
      setCrop(minInsets(frames));
    };

    const onMeta = () => void run();
    video.addEventListener("loadedmetadata", onMeta);

    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeAttribute("src");
      video.load();
    };
  }, [src]);

  const hasBars =
    crop.top > 0 || crop.right > 0 || crop.bottom > 0 || crop.left > 0;
  return { crop, hasBars };
}
