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
