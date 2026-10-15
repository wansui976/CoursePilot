import { createContext, useContext } from "react";
import type { ConceptNavigationState } from "@/features/knowledge/ConceptsPanel";
import type { ProcessingQueue } from "@/features/library/useProcessingQueue";
import type { Recorrection } from "@/features/library/useRecorrection";
import type { DueCard } from "@/lib/ipc";
import type { Course, Video } from "@/lib/types";

export type KnowledgeReturnState = {
  courseId: string;
  navigationState: ConceptNavigationState;
};

/**
 * 外壳（Home）交给各路由视图的共享状态与导航动作。
 *
 * 跨视图的导航要先过「未保存设置 / 打开的菜单与模态」这道关（runAfterWorkspaceTransient），
 * 还牵涉播放器的 pendingSeek 与知识点回跳——这些只有外壳知道，所以动作都由外壳实现，
 * 视图只管调用。视图自己的数据仍由各自的 query 获取。
 */
export interface Shell {
  isPhoneDevice: boolean;
  shellWide: boolean;
  workbenchAvailableWidth: number;
  /** 窄屏「课程」Tab 根层：整屏课程列表代替课程库。 */
  showCourseListScreen: boolean;

  courseVideos: Video[];
  selectedCourse: Course | undefined;
  selectedVideo: Video | undefined;
  knowledgeReturn: KnowledgeReturnState | null;

  queue: ProcessingQueue;
  recorrection: Recorrection;
  videoQuery: string;
  setVideoQuery: (query: string) => void;

  selectCourse: (courseId: string) => void;
  clearCourseSelection: () => void;
  openVideo: (videoId: string) => void;
  openQueuedVideo: (video: Video) => void;
  openMainView: (view: "settings" | "recycle" | "dev" | "dashboard") => void;
  closeToLibrary: () => void;
  resumeStudy: (courseId: string, videoId: string, positionSec: number) => void;
  reviewJump: (card: DueCard) => void;
  conceptJump: (videoId: string, startMs: number, navigationState?: ConceptNavigationState) => void;
  closeConcepts: () => void;
  returnToKnowledge: () => void;
  returnFromVideo: () => void;
  goBackOneLevel: () => boolean;
  forgetQueuedVideo: (videoId: string) => void;
  setVideoFullscreen: (fullscreen: boolean) => void;

  registerTransientClose: (close: (() => HTMLElement | null | void) | null) => void;
  registerSettingsExitRequest: (request: ((continuation: () => void) => void) | null) => void;
  registerSettingsBackRequest: (request: (() => void) | null) => void;
}

export const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell 只能在 Home 外壳内使用");
  return shell;
}
