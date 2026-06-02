import { useQuery } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { usePlayer } from "@/stores/player";
import { CaptionOverlay } from "./CaptionOverlay";
import { Controls } from "./Controls";

export function VideoPlayer({ src, videoId }: { src: string; videoId: string }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const setCurrentMs = usePlayer((s) => s.setCurrentMs);
  const setDurationMs = usePlayer((s) => s.setDurationMs);
  const currentMs = usePlayer((s) => s.currentMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const seekRequest = usePlayer((s) => s.seekRequest);

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

  return (
    <div
      aria-label="课程视频舞台"
      className={`flex flex-col ${
        fullscreen
          ? "fixed inset-0 z-50 bg-black"
          : "h-full min-h-0 bg-transparent"
      }`}
    >
      <div ref={stageRef} className="relative min-h-0 w-full min-w-0 flex-1">
        <video
          ref={ref}
          aria-label="课程视频播放器"
          src={src}
          playsInline
          disablePictureInPicture
          className="h-full w-full bg-black object-cover"
          onTimeUpdate={(event) =>
            setCurrentMs(Math.floor(event.currentTarget.currentTime * 1000))
          }
          onLoadedMetadata={(event) =>
            setDurationMs(Math.floor(event.currentTarget.duration * 1000))
          }
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onVolumeChange={(event) => {
            setVolume(event.currentTarget.volume);
            setMuted(event.currentTarget.muted);
          }}
        />
        {captionsOn && caption && (
          <CaptionOverlay text={caption} stageRef={stageRef} />
        )}
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
