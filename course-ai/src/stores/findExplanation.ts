import { create } from "zustand";

/**
 * 「拍题找讲解」对话框的开关。入口很多（课程页按钮、粘贴 / 拖入图片、助手附图），
 * 对话框只挂一份（在 Home），谁要打开就往这里塞一份请求。
 */
interface FindExplanationRequest {
  courseId: string;
  /** 已经有图（粘贴、拖入、助手附图）时直接带上，跳过选图那一步。 */
  image?: string;
  nonce: number;
}

interface FindExplanationState {
  request: FindExplanationRequest | null;
  open: (courseId: string, image?: string) => void;
  close: () => void;
}

export const useFindExplanation = create<FindExplanationState>((set, get) => ({
  request: null,
  open: (courseId, image) =>
    set({ request: { courseId, ...(image ? { image } : {}), nonce: (get().request?.nonce ?? 0) + 1 } }),
  close: () => set({ request: null }),
}));
