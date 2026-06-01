import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePlayer } from "@/stores/player";
import { Controls } from "./Controls";

export function VideoPlayer({ filePath }: { filePath: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const setCurrentMs = usePlayer((s) => s.setCurrentMs);
  const setDurationMs = usePlayer((s) => s.setDurationMs);
  const currentMs = usePlayer((s) => s.currentMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const seekRequest = usePlayer((s) => s.seekRequest);

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

  return (
    <div className="flex h-full flex-col bg-black">
      <video
        ref={ref}
        aria-label="课程视频播放器"
        src={convertFileSrc(filePath)}
        playsInline
        disablePictureInPicture
        className="min-h-0 w-full min-w-0 flex-1 bg-black object-contain"
        onTimeUpdate={(event) =>
          setCurrentMs(Math.floor(event.currentTarget.currentTime * 1000))
        }
        onLoadedMetadata={(event) =>
          setDurationMs(Math.floor(event.currentTarget.duration * 1000))
        }
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <Controls
        playing={playing}
        currentMs={currentMs}
        durationMs={durationMs}
        rate={rate}
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
      />
    </div>
  );
}
