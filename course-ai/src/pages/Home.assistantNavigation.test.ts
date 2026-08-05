import { describe, expect, it, vi } from "vitest";
import type { AssistantAction } from "@/lib/types";
import { dispatchAssistantNavigation } from "./Home";

function commands() {
  return {
    selectCourse: vi.fn(),
    openAt: vi.fn(),
    seek: vi.fn(),
    clearPendingOpen: vi.fn(),
  };
}

describe("dispatchAssistantNavigation", () => {
  it("switches to the action's course before opening a video from another course", () => {
    const target = commands();
    const action: AssistantAction = {
      kind: "open_video",
      course_id: "course-2",
      video_id: "video-2",
      title: "第二讲",
      at_ms: 65_000,
    };

    dispatchAssistantNavigation(action, "video-1", target);

    expect(target.selectCourse).toHaveBeenCalledWith("course-2");
    expect(target.openAt).toHaveBeenCalledWith("video-2", 65_000);
    expect(target.seek).not.toHaveBeenCalled();
  });

  it("seeks immediately when open_video targets the video that is already mounted", () => {
    const target = commands();
    const action: AssistantAction = {
      kind: "open_video",
      course_id: "course-1",
      video_id: "video-1",
      title: "第一讲",
      at_ms: 90_000,
    };

    dispatchAssistantNavigation(action, "video-1", target);

    expect(target.clearPendingOpen).toHaveBeenCalledOnce();
    expect(target.seek).toHaveBeenCalledWith(90_000);
    expect(target.openAt).not.toHaveBeenCalled();
  });

  it("does not reset the current video to zero when no timestamp was requested", () => {
    const target = commands();
    const action: AssistantAction = {
      kind: "open_video",
      course_id: "course-1",
      video_id: "video-1",
      title: "第一讲",
    };

    dispatchAssistantNavigation(action, "video-1", target);

    expect(target.clearPendingOpen).toHaveBeenCalledOnce();
    expect(target.openAt).not.toHaveBeenCalled();
    expect(target.seek).not.toHaveBeenCalled();
  });

  it("clamps invalid negative seek positions before they reach the player", () => {
    const target = commands();

    dispatchAssistantNavigation({ kind: "seek_to", at_ms: -1 }, "video-1", target);

    expect(target.clearPendingOpen).toHaveBeenCalledOnce();
    expect(target.seek).toHaveBeenCalledWith(0);
  });
});
