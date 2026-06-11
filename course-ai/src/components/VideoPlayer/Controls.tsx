import { Button } from "@/components/ui/button";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";
import { Check, Maximize, Minimize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";

const SPEEDS = [2, 1.5, 1.25, 1, 0.75, 0.5];
const iconButtonClass =
  "flex h-7 w-7 items-center justify-center rounded-lg text-white/90 transition hover:bg-white/10 hover:text-white";
const textButtonClass =
  "h-7 whitespace-nowrap rounded-lg px-2 text-[13px] font-medium text-white/85 transition hover:bg-white/10 hover:text-white";

function formatRate(rate: number) {
  return Number.isInteger(rate) ? rate.toFixed(1) : String(rate);
}

export function Controls({
  playing,
  rate,
  volume,
  muted,
  captionsOn,
  fullscreen,
  onToggleCaptions,
  onPlayPause,
  onSeek,
  onRate,
  onVolume,
  onMuteToggle,
  onFullscreenToggle,
}: {
  playing: boolean;
  rate: number;
  volume: number;
  muted: boolean;
  captionsOn: boolean;
  fullscreen: boolean;
  onToggleCaptions: () => void;
  onPlayPause: () => void;
  onSeek: (ms: number) => void;
  onRate: (rate: number) => void;
  onVolume: (volume: number) => void;
  onMuteToggle: () => void;
  onFullscreenToggle: () => void;
}) {
  // 只让这个小组件订阅进度（每秒约 4 次重渲染），不波及整个播放器。
  const currentMs = usePlayer((s) => s.currentMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const [speedOpen, setSpeedOpen] = useState(false);

  // 倍速菜单:点菜单与触发按钮之外即收起(都打了 data-speed-menu)。
  useEffect(() => {
    if (!speedOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-speed-menu]")) return;
      setSpeedOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [speedOpen]);
  const safeDuration = Math.max(0, durationMs);
  const progressPercent =
    safeDuration > 0 ? Math.min(100, Math.max(0, (currentMs / safeDuration) * 100)) : 0;
  const volumePercent = muted ? 0 : Math.min(100, Math.max(0, volume * 100));

  return (
    <div className="shrink-0 bg-black/95 px-3 pb-1 pt-1 text-white">
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
            "--video-control-color": "var(--accent)",
          } as CSSProperties
        }
      />
      <div className="ca-player-controls mt-1 flex items-center gap-1.5 text-sm text-white/75">
        <Button
          size="icon"
          variant="ghost"
          onClick={onPlayPause}
          aria-label={playing ? "暂停" : "播放"}
          title={playing ? "暂停" : "播放"}
          className="h-7 w-7 rounded-lg text-white hover:bg-white/10 hover:text-white"
        >
          {playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
        </Button>
        <span className="whitespace-nowrap text-sm font-medium tabular-nums tracking-wide text-white/85">
          {formatMs(currentMs)} / {formatMs(durationMs)}
        </span>

        <div className="min-w-2 flex-1" />

        <div className="relative" data-speed-menu>
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
                  className={`flex w-full items-center justify-center gap-1.5 px-4 py-1.5 text-sm font-medium ${
                    rate === speed ? "text-[var(--accent)]" : "text-white"
                  } hover:bg-white/10`}
                  onClick={() => {
                    onRate(speed);
                    setSpeedOpen(false);
                  }}
                >
                  <span className="flex w-3.5 flex-none justify-center">
                    {rate === speed && <Check className="h-3.5 w-3.5" />}
                  </span>
                  {formatRate(speed)}x
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onToggleCaptions}
          aria-pressed={captionsOn}
          title={captionsOn ? "关闭字幕" : "开启字幕"}
          className={`${textButtonClass} ${captionsOn ? "text-[var(--accent)]" : ""}`}
        >
          字幕
        </button>
        <Button
          size="icon"
          variant="ghost"
          onClick={onMuteToggle}
          title={muted ? "取消静音" : "静音"}
          className={iconButtonClass}
        >
          {muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
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
              "--video-control-color": "var(--accent)",
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
          {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
