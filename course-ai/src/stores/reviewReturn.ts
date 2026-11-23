import { create } from "zustand";

/** 学习面板里正在进行的是哪一种复习，回来时照原样再打开。 */
export type ReviewReturnSession =
  | { kind: "due" }
  | { kind: "mistakes" }
  | { kind: "concept"; courseId: string; conceptId: string; name: string };

/**
 * 复习卡「回看出处」：跳去视频前记下是从哪种复习出来的、跳到了哪个视频。
 * 在那个视频里点返回时，回到学习面板并接着复习，而不是退回课程库。
 * 期间换了别的视频，就不再算「回看出处」。
 */
interface ReviewReturnState {
  pending: { session: ReviewReturnSession; videoId: string } | null;
  /** 返回时置真，学习面板挂载后据此重新打开复习并清空。 */
  resume: boolean;
  remember: (session: ReviewReturnSession, videoId: string) => void;
  markResume: () => void;
  take: () => ReviewReturnSession | null;
  clear: () => void;
}

export const useReviewReturn = create<ReviewReturnState>((set, get) => ({
  pending: null,
  resume: false,
  remember: (session, videoId) => set({ pending: { session, videoId }, resume: false }),
  markResume: () => set({ resume: true }),
  take: () => {
    const { pending, resume } = get();
    set({ pending: null, resume: false });
    return resume && pending ? pending.session : null;
  },
  clear: () => set({ pending: null, resume: false }),
}));
