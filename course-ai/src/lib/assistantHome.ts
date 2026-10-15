import type { AssistantAction, AssistantContext, Video } from "./types";

export function buildAssistantContext(
  selectedCourseId: string | null,
  selectedVideo: Pick<Video, "id" | "course_id"> | undefined,
  positionMs: number,
): AssistantContext {
  return {
    course_id: selectedVideo?.course_id ?? selectedCourseId,
    video_id: selectedVideo?.id ?? null,
    position_ms: selectedVideo ? positionMs : null,
  };
}

export function reconcileAssistantAction(
  action: AssistantAction,
  currentVideoId: string | null,
  commands: {
    removeQueuedVideo: (videoId: string) => void;
    clearCurrentVideo: () => void;
    clearPendingOpen: (videoId: string) => void;
  },
) {
  if (action.kind !== "propose_delete") return;
  commands.removeQueuedVideo(action.video_id);
  commands.clearPendingOpen(action.video_id);
  if (action.video_id === currentVideoId) commands.clearCurrentVideo();
}

/** 助手的导航动作（打开视频 / 跳到某处）落到外壳的导航命令上。 */
export function dispatchAssistantNavigation(
  action: AssistantAction,
  currentVideoId: string | null,
  commands: {
    selectCourse: (courseId: string) => void;
    openAt: (videoId: string, atMs: number) => void;
    seek: (atMs: number) => void;
    clearPendingOpen: () => void;
  },
) {
  if (action.kind === "open_video") {
    if (action.course_id) commands.selectCourse(action.course_id);

    const atMs = Math.max(0, action.at_ms ?? 0);
    if (action.video_id === currentVideoId) {
      // pendingSeek 只在 loadedmetadata 时消费；当前视频不会重新触发该事件，必须直接 seek。
      commands.clearPendingOpen();
      if (action.at_ms != null) commands.seek(atMs);
      return;
    }

    commands.openAt(action.video_id, atMs);
    return;
  }

  if (action.kind === "seek_to") {
    commands.clearPendingOpen();
    commands.seek(Math.max(0, action.at_ms));
  }
}
