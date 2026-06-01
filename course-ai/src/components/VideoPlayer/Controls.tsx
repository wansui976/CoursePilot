import { Button } from "@/components/ui/button";
import { formatMs } from "@/lib/time";

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
    <div className="space-y-1 bg-black/40 p-2 backdrop-blur">
      <input
        type="range"
        min={0}
        max={Math.max(0, durationMs)}
        value={currentMs}
        onChange={(event) => onSeek(Number(event.target.value))}
        className="w-full accent-primary"
      />
      <div className="flex items-center gap-3 text-xs text-white/70">
        <Button size="sm" variant="ghost" onClick={onPlayPause}>
          {playing ? "暂停" : "播放"}
        </Button>
        <span>
          {formatMs(currentMs)} / {formatMs(durationMs)}
        </span>
        <select
          value={rate}
          onChange={(event) => onRate(Number(event.target.value))}
          className="rounded border border-white/20 bg-zinc-900 px-1 text-xs"
        >
          {SPEEDS.map((speed) => (
            <option key={speed} value={speed}>
              {speed}x
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
