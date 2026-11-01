import { create } from "zustand";

interface State {
  videoId: string | null;
  currentMs: number;
  durationMs: number;
  seekRequest: { ms: number; nonce: number } | null;
  // 跨视频跳转（如课程级搜索点到别的视频）：Home 据此打开目标视频，
  // 目标播放器加载完成后消费此处的 ms 跳到指定位置。故 setVideo 不清它。
  // keepClipQueue：这次是「依次播放」自己的跨视频导航，不能被当成手动打开视频而清空队列。
  pendingSeek: { videoId: string; ms: number; keepClipQueue?: boolean } | null;
  /** 递增的「暂停」请求：费曼复述要录音时用，别让麦克风把讲课声录进去。 */
  pauseRequest: number;
  setVideo: (id: string | null) => void;
  setCurrentMs: (ms: number) => void;
  setDurationMs: (ms: number) => void;
  requestSeek: (ms: number) => void;
  requestOpenAt: (
    videoId: string,
    ms: number,
    options?: { keepClipQueue?: boolean },
  ) => void;
  clearPendingSeek: () => void;
  requestPause: () => void;
}

let nonce = 0;

export const usePlayer = create<State>((set) => ({
  videoId: null,
  currentMs: 0,
  durationMs: 0,
  seekRequest: null,
  pendingSeek: null,
  pauseRequest: 0,
  setVideo: (id) =>
    set({ videoId: id, currentMs: 0, durationMs: 0, seekRequest: null }),
  setCurrentMs: (ms) => set({ currentMs: ms }),
  setDurationMs: (ms) => set({ durationMs: ms }),
  requestSeek: (ms) => set({ seekRequest: { ms, nonce: ++nonce } }),
  requestOpenAt: (videoId, ms, options) =>
    set({
      pendingSeek: {
        videoId,
        ms,
        ...(options?.keepClipQueue ? { keepClipQueue: true } : {}),
      },
    }),
  clearPendingSeek: () => set({ pendingSeek: null }),
  requestPause: () => set((state) => ({ pauseRequest: state.pauseRequest + 1 })),
}));
