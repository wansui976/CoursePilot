import { create } from "zustand";
import type { StudyTarget } from "@/lib/backgroundTasks";

/**
 * 「去学习面板的某一页」的请求：后台任务列表、完成提示点进来时用。
 * 目标视频的面板已经开着就当场切页；还没打开的，面板挂载时读这份请求当初始页签。
 */
type StudyNavRequest = { videoId: string; target: StudyTarget; nonce: number };

interface StudyNavState {
  request: StudyNavRequest | null;
  open: (videoId: string, target: StudyTarget) => void;
}

export const useStudyNav = create<StudyNavState>((set, get) => ({
  request: null,
  open: (videoId, target) =>
    set({ request: { videoId, target, nonce: (get().request?.nonce ?? 0) + 1 } }),
}));

/** 这个视频有没有尚未落地的请求（面板挂载时取初始页签）。 */
export function pendingStudyTarget(videoId: string): StudyTarget | null {
  const request = useStudyNav.getState().request;
  return request?.videoId === videoId ? request.target : null;
}
