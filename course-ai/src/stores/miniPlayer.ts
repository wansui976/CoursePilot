import { create } from "zustand";

/**
 * 应用内迷你播放器：在视频页里正在放的视频，离开视频页（打开设置、学习面板、回到课程库……）
 * 时由它在角落接着放；回到视频页时工作台的播放器从它放到的地方接着放，它自己收起。
 *
 * 只交接「正在播放」的视频：暂停着离开就是不想听了，不该在角落里冒出一个小窗。
 */
export interface MiniPlayerSession {
  videoId: string;
  courseId: string | null;
  title: string;
  src: string;
  /** 交接时的位置；之后由迷你播放器每秒更新，回到视频页时从这里接着放。 */
  ms: number;
  playing: boolean;
  rate: number;
  /** 0–1。视频页里放大到 100% 以上的音量在这里按 100% 放。 */
  volume: number;
  muted: boolean;
}

interface MiniPlayerState {
  session: MiniPlayerSession | null;
  open: (session: MiniPlayerSession) => void;
  update: (patch: Partial<Pick<MiniPlayerSession, "ms" | "playing">>) => void;
  close: () => void;
}

export const useMiniPlayer = create<MiniPlayerState>((set) => ({
  session: null,
  open: (session) => set({ session }),
  update: (patch) =>
    set((state) => (state.session ? { session: { ...state.session, ...patch } } : state)),
  close: () => set({ session: null }),
}));
