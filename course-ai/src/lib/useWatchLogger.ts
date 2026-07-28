import { useEffect, useRef } from "react";
import { ipc } from "./ipc";
import { WatchAccumulator, WatchLogQueue } from "./watchLogger";

// 每 30s 落一次库；不足 1s 的碎片不写，避免噪声与频繁 IPC。
const FLUSH_INTERVAL_MS = 30_000;
const MIN_FLUSH_MS = 1000;
const watchLogQueue = new WatchLogQueue((videoId, watchedMs) =>
  ipc.stats.logWatch(videoId, watchedMs),
);

/**
 * 把播放器的「播放中时长」记入学习事件日志（study_events）。
 * 周期 flush + 切视频/卸载时 flush；切视频时把累计记到「切走前」的那个视频。
 */
export function useWatchLogger(videoId: string | null, playing: boolean): void {
  const accRef = useRef<WatchAccumulator | null>(null);
  if (!accRef.current) accRef.current = new WatchAccumulator();

  useEffect(() => {
    accRef.current!.setPlaying(playing);
  }, [playing]);

  useEffect(() => {
    if (!videoId) return;
    const acc = accRef.current!;
    const flush = () => {
      const ms = acc.drain();
      if (ms >= MIN_FLUSH_MS) {
        void watchLogQueue.enqueue(videoId, ms).catch(() => {});
      }
      // Also retry failed batches from videos visited earlier in this player session.
      void watchLogQueue.retryAll();
    };
    const timer = window.setInterval(flush, FLUSH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      // 切视频 / 卸载前 flush：闭包捕获的是「切走前」的 videoId，归属正确。
      flush();
    };
  }, [videoId]);
}
