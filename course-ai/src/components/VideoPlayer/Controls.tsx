import { Button } from "@/components/ui/button";
import { formatMs } from "@/lib/time";
import { Pause, Play, SkipBack, SkipForward, Volume2 } from "lucide-react";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function Controls({
  playing,
  currentMs,
  durationMs,
  rate,
  onPlayPause,
  onSeek,
  onRate,
}: {
  playing: boolean;
  currentMs: number;
  durationMs: number;
  rate: number;
  onPlayPause: () => void;
  onSeek: (ms: number) => void;
  onRate: (rate: number) => void;
}) {
  return (
    <div className="space-y-3 bg-black px-6 pb-5 pt-3">
      <input
        type="range"
        min={0}
        max={Math.max(0, durationMs)}
        value={currentMs}
        onChange={(event) => onSeek(Number(event.target.value))}
        className="h-1 w-full accent-primary"
      />
      <div className="flex items-center gap-5 text-sm text-white/75">
        <span className="w-20 text-left font-medium text-white">{formatMs(currentMs)}</span>
        <Button size="icon" variant="ghost" onClick={onPlayPause} title={playing ? "暂停" : "播放"}>
          {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
        </Button>
        <Button size="icon" variant="ghost" onClick={() => onSeek(Math.max(0, currentMs - 10_000))} title="后退 10 秒">
          <SkipBack className="h-5 w-5" />
        </Button>
        <Button size="icon" variant="ghost" onClick={() => onSeek(Math.min(durationMs, currentMs + 10_000))} title="前进 10 秒">
          <SkipForward className="h-5 w-5" />
        </Button>
        <div className="flex-1" />
        <button className="rounded-md px-2 py-1 text-white/80 hover:bg-white/8">流畅</button>
        <button className="rounded-md px-2 py-1 text-white/80 hover:bg-white/8">字幕</button>
        <button className="rounded-md px-2 py-1 text-white/80 hover:bg-white/8">查找</button>
        <select
          value={rate}
          onChange={(event) => onRate(Number(event.target.value))}
          className="rounded-md border border-white/10 bg-black px-2 py-1 text-sm text-white"
        >
          {SPEEDS.map((speed) => (
            <option key={speed} value={speed}>
              {speed}x
            </option>
          ))}
        </select>
        <Volume2 className="h-5 w-5 text-white/75" />
        <span className="w-20 text-right font-medium text-white">{formatMs(durationMs)}</span>
      </div>
    </div>
  );
}
