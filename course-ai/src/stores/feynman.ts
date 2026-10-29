import { create } from "zustand";
import type { FeynmanTopic } from "@/lib/types";

/** 「讲给我听」对话框的开关：入口在知识点页和章节列表，对话框只在 Home 挂一份。 */
interface FeynmanRequest {
  topic: FeynmanTopic;
  title: string;
  cardVideoId: string | null;
  nonce: number;
}

interface FeynmanState {
  request: FeynmanRequest | null;
  open: (topic: FeynmanTopic, title: string, cardVideoId: string | null) => void;
  close: () => void;
}

export const useFeynman = create<FeynmanState>((set, get) => ({
  request: null,
  open: (topic, title, cardVideoId) =>
    set({ request: { topic, title, cardVideoId, nonce: (get().request?.nonce ?? 0) + 1 } }),
  close: () => set({ request: null }),
}));
