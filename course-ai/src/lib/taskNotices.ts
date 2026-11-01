import { create } from "zustand";
import type { TaskNotice } from "@/lib/backgroundTasks";

/** 完成提示最多堆几条、每条停留多久。 */
export const NOTICE_MS = 6000;
export const MAX_NOTICES = 3;

interface TaskNoticesState {
  notices: TaskNotice[];
  push: (notice: TaskNotice) => void;
  dismiss: (id: number) => void;
  /** 视频/课程被删除后，连同它的完成提示一起清掉。 */
  clearScope: (scope: { videoId?: string; videoIds?: string[]; courseId?: string }) => void;
}

/**
 * 完成提示放在全局 store 里而不是组件 state：删除课程/视频的地方也要能把它清掉，
 * 否则「查看」会指向一个已经不存在的对象。
 */
export const useTaskNotices = create<TaskNoticesState>((set) => ({
  notices: [],
  push: (notice) =>
    set((state) => ({ notices: [...state.notices, notice].slice(-MAX_NOTICES) })),
  dismiss: (id) =>
    set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) })),
  clearScope: ({ videoId, videoIds, courseId }) => {
    const ids = new Set(videoIds ?? []);
    if (videoId) ids.add(videoId);
    set((state) => ({
      notices: state.notices.filter(
        (notice) =>
          !(notice.videoId && ids.has(notice.videoId)) &&
          !(courseId && notice.courseId === courseId),
      ),
    }));
  },
}));
