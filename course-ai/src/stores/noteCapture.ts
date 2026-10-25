import { create } from "zustand";

/**
 * 「记一笔」请求：播放器（快捷键）或笔记面板的按钮发出，在某个视频的某个时间点插一条笔记。
 *
 * 由几个互不相识的部件分头接力：播放器收到就暂停（写字时视频别跑，光标进了编辑器后播放
 * 快捷键也按不到）；学习面板切到「笔记」；笔记编辑器在内容装载完成后，于末尾插入该时间戳
 * 并把光标停在后面，处理完调 done 清掉。笔记标签之前没打开过也一样能接住。
 */
export interface NoteCaptureRequest {
  videoId: string;
  ms: number;
  /** 区分连续两次相同时间的请求。 */
  nonce: number;
}

interface NoteCaptureState {
  request: NoteCaptureRequest | null;
  capture: (videoId: string, ms: number) => void;
  done: (nonce: number) => void;
}

let counter = 0;

export const useNoteCapture = create<NoteCaptureState>((set, get) => ({
  request: null,
  capture: (videoId, ms) => {
    counter += 1;
    set({ request: { videoId, ms: Math.max(0, Math.round(ms)), nonce: counter } });
  },
  done: (nonce) => {
    if (get().request?.nonce === nonce) set({ request: null });
  },
}));
