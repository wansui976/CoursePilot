import { Button } from "@/components/ui/button";
import { formatMs } from "@/lib/time";
import { Maximize, Minimize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useState, type CSSProperties } from "react";

const SPEEDS = [2, 1.5, 1.25, 1, 0.75, 0.5];
const iconButtonClass =
  "flex h-9 w-9 items-center justify-center rounded-lg text-white/90 transition hover:bg-white/10 hover:text-white";
const textButtonClass =
  "h-9 whitespace-nowrap rounded-lg px-2 text-sm font-medium text-white/85 transition hover:bg-white/10 hover:text-white";

function formatRate(rate: number) {
  return Number.isInteger(rate) ? rate.toFixed(1) : String(rate);
}

export function Controls({
  playing,
  currentMs,
  durationMs,
  rate,
  volume,
  muted,
  captionsOn,
  fullscreen,
  showCrop,
  cropOn,
  onToggleCrop,
  onToggleCaptions,
  onPlayPause,
  onSeek,
  onRate,
  onVolume,
  onMuteToggle,
  onFullscreenToggle,
}: {
  playing: boolean;
  currentMs: number;
  durationMs: number;
  rate: number;
  volume: number;
  muted: boolean;
  captionsOn: boolean;
  fullscreen: boolean;
  showCrop: boolean;
  cropOn: boolean;
  onToggleCrop: () => void;
  onToggleCaptions: () => void;
  onPlayPause: () => void;
  onSeek: (ms: number) => void;
  onRate: (rate: number) => void;
  onVolume: (volume: number) => void;
  onMuteToggle: () => void;
  onFullscreenToggle: () => void;
}) {
  const [speedOpen, setSpeedOpen] = useState(false);
  const safeDuration = Math.max(0, durationMs);
  const progressPercent =
    safeDuration > 0 ? Math.min(100, Math.max(0, (currentMs / safeDuration) * 100)) : 0;
  const volumePercent = muted ? 0 : Math.min(100, Math.max(0, volume * 100));

  return (
    <div className="shrink-0 bg-black/95 px-4 pb-2.5 pt-2 text-white">
      <input
        aria-label="播放进度"
        type="range"
        min={0}
        max={safeDuration}
        value={currentMs}
        onChange={(event) => onSeek(Number(event.target.value))}
        className="course-video-progress w-full"
        style={
          {
            "--progress-percent": `${progressPercent}%`,
          } as CSSProperties
        }
      />
      <div className="mt-2 flex items-center gap-2 text-sm text-white/75">
        <Button
          size="icon"
          variant="ghost"
          onClick={onPlayPause}
          aria-label={playing ? "暂停" : "播放"}
          title={playing ? "暂停" : "播放"}
          className="h-9 w-9 rounded-lg text-white hover:bg-white/10 hover:text-white"
        >
          {playing ? <Pause className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5 fill-current" />}
        </Button>
        <span className="whitespace-nowrap text-sm font-medium tabular-nums tracking-wide text-white/85">
          {formatMs(currentMs)} / {formatMs(durationMs)}
        </span>

        <div className="min-w-2 flex-1" />

        <div className="relative">
          <button
            type="button"
            className={textButtonClass}
            aria-haspopup="menu"
            aria-expanded={speedOpen}
            onClick={() => setSpeedOpen((open) => !open)}
          >
            倍速
          </button>
          {speedOpen && (
            <div
              role="menu"
              aria-label="倍速"
              className="absolute bottom-full left-1/2 mb-2 w-24 -translate-x-1/2 overflow-hidden rounded-md bg-black/90 py-1.5 shadow-2xl ring-1 ring-white/12 backdrop-blur"
            >
              {SPEEDS.map((speed) => (
                <button
                  key={speed}
                  type="button"
                  role="menuitemradio"
                  aria-checked={rate === speed}
                  className={`block w-full px-4 py-1.5 text-center text-sm font-medium ${
                    rate === speed ? "text-[#3b82f6]" : "text-white"
                  } hover:bg-white/10`}
                  onClick={() => {
                    onRate(speed);
                    setSpeedOpen(false);
                  }}
                >
                  {formatRate(speed)}x
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onToggleCaptions}
          title={captionsOn ? "关闭字幕" : "开启字幕"}
          className={`${textButtonClass} ${captionsOn ? "text-[#3b82f6]" : ""}`}
        >
          字幕
        </button>
        <button
          type="button"
          onClick={onToggleCrop}
          title={
            showCrop
              ? cropOn
                ? "显示原画（保留黑边）"
                : "裁掉黑边"
              : "裁掉黑边"
          }
          className={`${textButtonClass} ${cropOn ? "text-[#3b82f6]" : ""}`}
        >
          裁黑边
        </button>
        <Button
          size="icon"
          variant="ghost"
          onClick={onMuteToggle}
          title={muted ? "取消静音" : "静音"}
          className={iconButtonClass}
        >
          {muted || volume === 0 ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
        </Button>
        <input
          aria-label="音量"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(event) => onVolume(Number(event.target.value))}
          className="course-video-volume hidden w-16 sm:block"
          style={
            {
              "--progress-percent": `${volumePercent}%`,
            } as CSSProperties
          }
        />
        <Button
          size="icon"
          variant="ghost"
          onClick={onFullscreenToggle}
          aria-label={fullscreen ? "退出全屏" : "全屏"}
          title={fullscreen ? "退出全屏" : "全屏"}
          className={iconButtonClass}
        >
          {fullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
        </Button>
      </div>
    </div>
  );
}
