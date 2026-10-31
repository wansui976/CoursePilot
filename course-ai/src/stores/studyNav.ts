import { create } from "zustand";
import type { StudyTarget } from "@/lib/backgroundTasks";

/**
 * 「去学习面板的某一页」的请求：后台任务列表、完成提示点进来时用。
 * 目标视频的面板已经开着就当场切页；还没打开的，面板挂载时读这份请求当初始页签。
 *
 * 请求落地后必须 [`consume`] 掉：留着的话，这个视频以后每次打开都会被钉到
 * 上一次任务的页签上，覆盖用户自己记住的页签。
 */
export type StudyNavRequest = { videoId: string; target: StudyTarget; nonce: number };

interface StudyNavState {
  request: StudyNavRequest | null;
  open: (videoId: string, target: StudyTarget) => void;
  /** 用掉这一条请求（按 nonce 认，别误伤后到的新请求）。 */
  consume: (nonce: number) => void;
}

export const useStudyNav = create<StudyNavState>((set, get) => ({
  request: null,
  open: (videoId, target) =>
    set({ request: { videoId, target, nonce: (get().request?.nonce ?? 0) + 1 } }),
  consume: (nonce) =>
    set((state) => (state.request?.nonce === nonce ? { request: null } : state)),
}));

/** 这个视频尚未落地的请求（面板挂载时取初始页签）；没有返回 null。 */
export function pendingStudyRequest(videoId: string): StudyNavRequest | null {
  const request = useStudyNav.getState().request;
  return request?.videoId === videoId ? request : null;
}
