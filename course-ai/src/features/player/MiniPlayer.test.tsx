import "@testing-library/jest-dom/vitest";
import i18n from "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MiniPlayer } from "./MiniPlayer";
import { useMiniPlayer, type MiniPlayerSession } from "@/stores/miniPlayer";
import { posKey } from "@/lib/playback";

const session: MiniPlayerSession = {
  videoId: "v3",
  courseId: "c1",
  title: "03 梯度下降的直觉",
  src: "http://127.0.0.1:1234/m/v3",
  ms: 95_000,
  playing: true,
  rate: 1.5,
  volume: 0.8,
  muted: false,
};

function stage() {
  return document.querySelector(".ca-mini-player video") as HTMLVideoElement;
}

describe("MiniPlayer", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    localStorage.clear();
    useMiniPlayer.getState().close();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  });

  it("renders nothing without a session", () => {
    render(<MiniPlayer layout="card" onReturn={vi.fn()} />);
    expect(screen.queryByRole("region", { name: "迷你播放器" })).toBeNull();
  });

  it("picks up where the video page left off, at the same speed", () => {
    useMiniPlayer.getState().open(session);
    render(<MiniPlayer layout="card" onReturn={vi.fn()} />);
    const video = stage();
    expect(video.volume).toBeCloseTo(0.8);
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(95);
    expect(video.playbackRate).toBe(1.5);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("goes back to the video with the current position", () => {
    useMiniPlayer.getState().open(session);
    const onReturn = vi.fn();
    render(<MiniPlayer layout="card" onReturn={onReturn} />);
    const video = stage();
    fireEvent.loadedMetadata(video);
    video.currentTime = 130;
    fireEvent.click(screen.getByRole("button", { name: "回到「03 梯度下降的直觉」" }));
    expect(onReturn).toHaveBeenCalledWith(expect.objectContaining({ videoId: "v3", ms: 130_000 }));
  });

  it("saves the position as a resume point and goes away when closed", () => {
    useMiniPlayer.getState().open(session);
    render(<MiniPlayer layout="bar" onReturn={vi.fn()} />);
    const video = stage();
    fireEvent.loadedMetadata(video);
    video.currentTime = 140;
    fireEvent.click(screen.getByRole("button", { name: "关闭迷你播放器" }));
    expect(useMiniPlayer.getState().session).toBeNull();
    expect(Number(localStorage.getItem(posKey("v3")))).toBe(140);
  });

  it("closes quietly when the source stops working", () => {
    useMiniPlayer.getState().open(session);
    render(<MiniPlayer layout="card" onReturn={vi.fn()} />);
    fireEvent.error(stage());
    expect(useMiniPlayer.getState().session).toBeNull();
  });

  it("keeps clear of an assistant docked on the right", () => {
    useMiniPlayer.getState().open(session);
    render(<MiniPlayer layout="card" onReturn={vi.fn()} rightInset={380} />);
    expect(screen.getByRole("region", { name: "迷你播放器" })).toHaveStyle({
      right: "calc(380px + 1rem)",
    });
  });
});
