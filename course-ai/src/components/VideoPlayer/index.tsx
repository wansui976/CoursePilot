import { useQuery } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { contentAspect, cropStyle, type Insets, NO_INSETS } from "@/lib/blackBars";
import { ipc } from "@/lib/ipc";
import { usePlayer } from "@/stores/player";
import { CaptionOverlay } from "./CaptionOverlay";
import { Controls } from "./Controls";

const posKey = (id: string) => `video-pos:${id}`;
// 距片尾 15s 内不再续播（视为看完），从头开始。
const RESUME_TAIL_GUARD = 15;

export function VideoPlayer({
  src,
  videoId,
  crop: cropProp,
}: {
  src: string;
  videoId: string;
  // 导入时 ffmpeg cropdetect 探测到的四边黑边占比；无则不裁。
  crop?: Insets | null;
}) {
  const regionRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLVideoElement>(null);
  const lastSavedRef = useRef(0);
  const [videoAspect, setVideoAspect] = useState(16 / 9);
  const [videoDims, setVideoDims] = useState({ w: 0, h: 0 }); // 调试：真实像素尺寸
  const setCurrentMs = usePlayer((s) => s.setCurrentMs);
  const setDurationMs = usePlayer((s) => s.setDurationMs);
  const currentMs = usePlayer((s) => s.currentMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const seekRequest = usePlayer((s) => s.seekRequest);
  const crop = cropProp ?? NO_INSETS;
  const hasBars =
    !!cropProp &&
    (crop.top > 0 || crop.right > 0 || crop.bottom > 0 || crop.left > 0);
  const [cropEnabled, setCropEnabled] = useState(true);
  // 检测到黑边即默认开启；换视频时复位为该视频的判定。
  useEffect(() => {
    setCropEnabled(hasBars);
  }, [videoId, hasBars]);
  const activeCrop = cropEnabled ? crop : NO_INSETS;
  const [region, setRegion] = useState({ w: 0, h: 0 });
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const dpr =
    typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

  const { data: segments = [] } = useQuery({
    queryKey: ["transcripts", videoId],
    queryFn: () => ipc.transcripts.list(videoId),
    refetchInterval: (query) =>
      query.state.data && query.state.data.length > 0 ? false : 2000,
  });
  const caption = segments.find(
    (segment) => currentMs >= segment.start_ms && currentMs < segment.end_ms,
  )?.text;

  useLayoutEffect(() => {
    ref.current?.setAttribute("webkit-playsinline", "true");
  }, []);

  // 跟踪播放区实际尺寸，据此把舞台收成视频的真实宽高比，做到「完整不裁剪 + 不留黑边」。
  useEffect(() => {
    const el = regionRef.current;
    if (!el) return;
    const update = () => setRegion({ w: el.clientWidth, h: el.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 在播放区内，求与视频同比例、尽可能大的居中矩形；视频铺满它即完整无黑边。
  const aspect = contentAspect(videoAspect > 0 ? videoAspect : 16 / 9, activeCrop);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  const toggleFullscreen = () => void setVideoFullscreen(!fullscreen);

  // 键盘快捷键：空格/K 播放暂停，←→ 快退快进 5s，J/L 10s，↑↓ 调音量，
  // M 静音，F 全屏，C 字幕。聚焦输入框时不拦截，避免影响打字。
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
      const video = ref.current;
      if (!video) return;
      const clamp = (v: number) => Math.min(1, Math.max(0, v));
      switch (event.key) {
        case " ":
        case "k":
        case "K":
          event.preventDefault();
          if (video.paused) void video.play();
          else video.pause();
          break;
        case "ArrowLeft":
          event.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 5);
          break;
        case "ArrowRight":
          event.preventDefault();
          video.currentTime = video.currentTime + 5;
          break;
        case "j":
        case "J":
          video.currentTime = Math.max(0, video.currentTime - 10);
          break;
        case "l":
        case "L":
          video.currentTime = video.currentTime + 10;
          break;
        case "ArrowUp":
          event.preventDefault();
          setMuted(false);
          setVolume((v) => clamp(v + 0.1));
          break;
        case "ArrowDown":
          event.preventDefault();
          setVolume((v) => clamp(v - 0.1));
          break;
        case "m":
        case "M":
          setMuted((v) => !v);
          break;
        case "f":
        case "F":
          event.preventDefault();
          toggleFullscreen();
          break;
        case "c":
        case "C":
          setCaptionsOn((v) => !v);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  return (
    <div
      aria-label="课程视频舞台"
      className={`flex flex-col ${
        fullscreen
          ? "fixed inset-0 z-50 bg-black"
          : "h-full min-h-0 bg-transparent"
      }`}
    >
      <div
        ref={regionRef}
        className={`relative flex min-h-0 w-full min-w-0 flex-1 items-center justify-center overflow-hidden ${
          fullscreen ? "bg-black" : "bg-[var(--surface-stage)]"
        }`}
      >
        <div
          ref={stageRef}
          className={`relative overflow-hidden ${fullscreen ? "" : "rounded-[14px]"}`}
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
            className={stageBox ? "bg-black" : "h-full w-full bg-black object-contain"}
            // 提升到独立 GPU 合成层：暂停后让这一帧留在自己的层上，减少回退到
            // 「栅格化再缩放」的软化；backface-visibility 进一步固定层、避免半像素抖动。
            // stageBox 就绪时叠加 cropStyle（绝对定位 + 放大负偏移）把黑边推出包裹层；
            // 无裁剪时 cropStyle 等价于铺满 stageBox，与原渲染一致。
            // object-fit:contain：元素尺寸已按内容宽高比算好（W/H==内容显示比例）。
            // contain 等比缩放、永不拉伸（不变形）、且**永不裁掉内容**——对文档/讲义这类
            // 边缘文字不能丢的内容最稳；常见方形像素下与精确铺满一致，仅当视频真实显示比例
            // 与 videoWidth/Height 推算的比例有微差时，在框内留一丝黑边（可接受）。
            // 黑边仍由 cropStyle 的负偏移推出包裹层。
            style={{
              transform: "translateZ(0)",
              willChange: "transform",
              backfaceVisibility: "hidden",
              ...(stageBox
                ? {
                    ...cropStyle(stageBox, activeCrop, dpr),
                    objectFit: "contain" as const,
                  }
                : {}),
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
              const { videoWidth, videoHeight } = video;
              if (videoWidth > 0 && videoHeight > 0) {
                setVideoAspect(videoWidth / videoHeight);
                setVideoDims({ w: videoWidth, h: videoHeight });
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
            onPlay={() => setPlaying(true)}
            onPause={(event) => {
              setPlaying(false);
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
          {captionsOn && caption && (
            <CaptionOverlay text={caption} stageRef={stageRef} />
          )}
          {/* 临时调试读数：定位裁剪偏移/比例问题用，定位后会删除。 */}
          <div className="pointer-events-none absolute left-1 top-1 z-20 whitespace-pre rounded bg-black/70 px-1.5 py-1 font-mono text-[10px] leading-tight text-lime-300">
            {[
              `region ${region.w}x${region.h}`,
              `video ${videoDims.w}x${videoDims.h} ar=${videoAspect.toFixed(4)}`,
              `crop T${crop.top.toFixed(3)} R${crop.right.toFixed(3)} B${crop.bottom.toFixed(3)} L${crop.left.toFixed(3)}`,
              `on=${cropEnabled} hasBars=${hasBars}`,
              stageBox
                ? `stage ${Math.round(stageBox.width)}x${Math.round(stageBox.height)}`
                : "stage null",
              stageBox
                ? (() => {
                    const s = cropStyle(stageBox, activeCrop, dpr);
                    return `vid w=${Math.round(Number(s.width))} h=${Math.round(Number(s.height))} l=${Math.round(Number(s.left))} t=${Math.round(Number(s.top))}`;
                  })()
                : "",
            ].join("\n")}
          </div>
        </div>
      </div>
      <Controls
        playing={playing}
        currentMs={currentMs}
        durationMs={durationMs}
        rate={rate}
        volume={volume}
        muted={muted}
        captionsOn={captionsOn}
        fullscreen={fullscreen}
        showCrop={hasBars}
        cropOn={cropEnabled}
        onToggleCrop={() => setCropEnabled((v) => !v)}
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
  );
}
