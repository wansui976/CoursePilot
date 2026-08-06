import { describe, expect, it, vi } from "vitest";
import { buildAssistantContext, reconcileAssistantAction } from "./assistantHome";

describe("Home Agent context", () => {
  it("uses the opened video's real course when it came from another course's queue", () => {
    expect(
      buildAssistantContext(
        "course-old",
        { id: "video-new", course_id: "course-new" },
        42_000,
      ),
    ).toEqual({
      course_id: "course-new",
      video_id: "video-new",
      position_ms: 42_000,
    });
  });

  it("never exposes a stale video id or playback position when the video no longer exists", () => {
    expect(buildAssistantContext("course-1", undefined, 42_000)).toEqual({
      course_id: "course-1",
      video_id: null,
      position_ms: null,
    });
  });

  it("clears the selected and pending state when Agent deletes the current video", () => {
    const commands = {
      removeQueuedVideo: vi.fn(),
      clearCurrentVideo: vi.fn(),
      clearPendingOpen: vi.fn(),
    };

    reconcileAssistantAction(
      { kind: "propose_delete", video_id: "video-1", title: "第一讲" },
      "video-1",
      commands,
    );

    expect(commands.removeQueuedVideo).toHaveBeenCalledWith("video-1");
    expect(commands.clearPendingOpen).toHaveBeenCalledWith("video-1");
    expect(commands.clearCurrentVideo).toHaveBeenCalledOnce();
  });

  it("does not clear the current selection when Agent deletes another video", () => {
    const commands = {
      removeQueuedVideo: vi.fn(),
      clearCurrentVideo: vi.fn(),
      clearPendingOpen: vi.fn(),
    };

    reconcileAssistantAction(
      { kind: "propose_delete", video_id: "video-2", title: "第二讲" },
      "video-1",
      commands,
    );

    expect(commands.removeQueuedVideo).toHaveBeenCalledWith("video-2");
    expect(commands.clearPendingOpen).toHaveBeenCalledWith("video-2");
    expect(commands.clearCurrentVideo).not.toHaveBeenCalled();
  });
});
