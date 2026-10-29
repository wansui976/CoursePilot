import { create } from "zustand";

/**
 * 依次播放几段视频片段（拍题找讲解的「先看这几段」）。
 * 工作台顶部显示一条「第 1 / 3 段 · 下一段」，用户自己决定什么时候去下一段。
 */
export interface QueuedClip {
  videoId: string;
  videoTitle: string;
  startMs: number;
}

interface ClipQueueState {
  items: QueuedClip[];
  index: number;
  start: (items: QueuedClip[]) => void;
  /** 前进一段；已经是最后一段则结束队列。返回要播的那一段。 */
  next: () => QueuedClip | null;
  clear: () => void;
}

export const useClipQueue = create<ClipQueueState>((set, get) => ({
  items: [],
  index: 0,
  start: (items) => set({ items, index: 0 }),
  next: () => {
    const { items, index } = get();
    if (index + 1 >= items.length) {
      set({ items: [], index: 0 });
      return null;
    }
    set({ index: index + 1 });
    return items[index + 1];
  },
  clear: () => set({ items: [], index: 0 }),
}));
