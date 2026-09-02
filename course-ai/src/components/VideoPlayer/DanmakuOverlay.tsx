import { useEffect, useMemo, useRef } from "react";
import {
  DanmakuEngine,
  SCROLL_TRAVEL_MS,
  danmakuFontSize,
  type DanmakuGeometry,
} from "@/lib/danmaku";
import type { DanmakuEntry } from "@/lib/types";

// 弹幕渲染层：一块铺满视频画面的透明 canvas。排期（何时出现、占哪条轨道、
// 何时离场）全在 lib/danmaku.ts 的纯逻辑里；这里只随视频时间逐帧画。
// 时间直接读 video.currentTime——暂停时弹幕冻结、倍速时自然同步、seek 大幅
// 跳变由排期器检测并清场重来，不需要监听播放器事件。

const DANMAKU_FONT =
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';

export function DanmakuOverlay({
  entries,
  videoRef,
}: {
  entries: DanmakuEntry[];
  videoRef: React.RefObject<HTMLVideoElement | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engine = useMemo(() => new DanmakuEngine(entries), [entries]);

  useEffect(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const canvas = canvasRef.current;
      const video = videoRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !video || !ctx) return;
      const cssWidth = canvas.clientWidth;
      const cssHeight = canvas.clientHeight;
      if (cssWidth === 0 || cssHeight === 0) return;
      // 画布按设备像素比建 back store，绘制统一用 CSS 像素坐标。
      const dpr = window.devicePixelRatio || 1;
      const pixelWidth = Math.round(cssWidth * dpr);
      const pixelHeight = Math.round(cssHeight * dpr);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const fontSize = danmakuFontSize(cssHeight);
      const laneHeight = fontSize * 1.4;
      const geometry: DanmakuGeometry = {
        width: cssWidth,
        height: cssHeight,
        laneHeight,
        // 滚动弹幕用画面上部 ~75%（不往下挤字幕区）；顶部/底部各占 ~30%。
        scrollLanes: Math.max(1, Math.floor((cssHeight * 0.75) / laneHeight)),
        staticLanes: Math.max(1, Math.floor((cssHeight * 0.3) / laneHeight)),
        measure: (text, size) => {
          ctx.font = `${size}px ${DANMAKU_FONT}`;
          return ctx.measureText(text).width;
        },
      };
      const nowMs = video.currentTime * 1000;
      engine.advance(nowMs, geometry);

      ctx.clearRect(0, 0, cssWidth, cssHeight);
      ctx.textBaseline = "top";
      ctx.font = `${fontSize}px ${DANMAKU_FONT}`;
      ctx.globalAlpha = 0.95;
      // 描一细圈黑边：浅色弹幕在亮画面上也看得清。
      ctx.lineWidth = Math.max(1, fontSize / 10);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
      ctx.lineJoin = "round";
      for (const item of engine.active) {
        const elapsed = nowMs - item.bornMs;
        let x: number;
        let y: number;
        if (item.entry.mode === "scroll") {
          x = cssWidth - (elapsed / SCROLL_TRAVEL_MS) * (cssWidth + item.width);
          y = item.lane * laneHeight + 2;
        } else if (item.entry.mode === "top") {
          x = (cssWidth - item.width) / 2;
          y = item.lane * laneHeight + 2;
        } else {
          x = (cssWidth - item.width) / 2;
          y = cssHeight - (item.lane + 1) * laneHeight + 2;
        }
        ctx.strokeText(item.entry.text, x, y);
        ctx.fillStyle = item.entry.color ?? "#ffffff";
        ctx.fillText(item.entry.text, x, y);
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [engine, videoRef]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-danmaku-overlay=""
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
