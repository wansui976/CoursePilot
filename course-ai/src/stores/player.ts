import { create } from "zustand";

interface State {
  videoId: string | null;
  currentMs: number;
  durationMs: number;
  seekRequest: { ms: number; nonce: number } | null;
  // 跨视频跳转（如课程级搜索点到别的视频）：Home 据此打开目标视频，
  // 目标播放器加载完成后消费此处的 ms 跳到指定位置。故 setVideo 不清它。
  pendingSeek: { videoId: string; ms: number } | null;
  setVideo: (id: string | null) => void;
  setCurrentMs: (ms: number) => void;
  setDurationMs: (ms: number) => void;
  requestSeek: (ms: number) => void;
  requestOpenAt: (videoId: string, ms: number) => void;
  clearPendingSeek: () => void;
}

let nonce = 0;

export const usePlayer = create<State>((set) => ({
  videoId: null,
  currentMs: 0,
  durationMs: 0,
  seekRequest: null,
  pendingSeek: null,
  setVideo: (id) =>
    set({ videoId: id, currentMs: 0, durationMs: 0, seekRequest: null }),
  setCurrentMs: (ms) => set({ currentMs: ms }),
  setDurationMs: (ms) => set({ durationMs: ms }),
  requestSeek: (ms) => set({ seekRequest: { ms, nonce: ++nonce } }),
  requestOpenAt: (videoId, ms) => set({ pendingSeek: { videoId, ms } }),
  clearPendingSeek: () => set({ pendingSeek: null }),
}));
