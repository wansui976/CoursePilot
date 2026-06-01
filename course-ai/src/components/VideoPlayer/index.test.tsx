import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VideoPlayer } from ".";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

describe("VideoPlayer", () => {
  it("keeps video playback inline inside the learning workspace", () => {
    render(<VideoPlayer filePath="/tmp/lesson.mp4" />);

    const video = screen.getByLabelText("课程视频播放器");

    expect(video).toHaveAttribute("playsinline");
    expect(video).toHaveAttribute("webkit-playsinline");
    expect(video).toHaveAttribute("disablepictureinpicture");
  });
});
