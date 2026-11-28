import { create } from "zustand";
import type { AbLoop, SleepTimer } from "@/lib/abLoop";

/**
 * 播放器的两件小工具：区间复读、定时停止。只在这次打开的应用里有效，不写本地——
 * 下次打开还在循环一小段、或者莫名其妙停下来，比没记住更让人困惑。
 */
interface PlaybackToolsState {
  loop: AbLoop | null;
  sleep: SleepTimer | null;
  setLoop: (loop: AbLoop | null) => void;
  /** 别处（文稿划选）要求马上开始复读：播放器看到 `kick` 变了就跳到起点开播。 */
  startLoop: (loop: AbLoop) => void;
  kick: number;
  setSleep: (timer: SleepTimer | null) => void;
}

export const usePlaybackTools = create<PlaybackToolsState>((set) => ({
  loop: null,
  sleep: null,
  setLoop: (loop) => set({ loop }),
  kick: 0,
  startLoop: (loop) => set((state) => ({ loop, kick: state.kick + 1 })),
  setSleep: (sleep) => set({ sleep }),
}));
