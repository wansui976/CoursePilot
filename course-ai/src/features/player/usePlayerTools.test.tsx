import i18n from "@/i18n";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import { usePlaybackTools } from "@/stores/playbackTools";
import { usePlayerTools } from "./usePlayerTools";

function fakeVideo(currentTime = 0) {
  return {
    currentTime,
    duration: 120,
    paused: true,
    play: vi.fn(function (this: { paused: boolean }) {
      this.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(function (this: { paused: boolean }) {
      this.paused = true;
    }),
  } as unknown as HTMLVideoElement;
}

const segments = [
  { id: 1, video_id: "v", segment_idx: 0, start_ms: 0, end_ms: 4000, text: "a" },
  { id: 2, video_id: "v", segment_idx: 1, start_ms: 4000, end_ms: 9000, text: "b" },
];
const chapters = [
  { id: 1, video_id: "v", title: "一", summary: null, start_ms: 0, end_ms: 60_000, order_index: 0 },
  { id: 2, video_id: "v", title: "二", summary: null, start_ms: 60_000, end_ms: 120_000, order_index: 1 },
];

function setup(video: HTMLVideoElement) {
  const ref = { current: video } as RefObject<HTMLVideoElement | null>;
  return renderHook(() => usePlayerTools(ref, "v", segments, chapters));
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  usePlaybackTools.setState({ loop: null, sleep: null, kick: 0 });
});

describe("usePlayerTools", () => {
  it("loops back to A after crossing B", () => {
    const video = fakeVideo(10);
    const { result } = setup(video);
    act(() => result.current.applyLoop("step"));
    video.currentTime = 15;
    act(() => result.current.applyLoop("step"));
    expect(result.current.loop).toEqual({ videoId: "v", startMs: 10_000, endMs: 15_000 });
    // 定好终点时人在终点：直接回到起点开播。
    expect(video.currentTime).toBe(10);
    expect(video.play).toHaveBeenCalled();
    video.currentTime = 15.2;
    expect(result.current.handleTimeUpdate(video)).toBe(true);
    expect(video.currentTime).toBe(10);
    expect(result.current.notice).toBe("复读 00:10 – 00:15");
  });

  it("loops the current sentence", () => {
    const video = fakeVideo(5);
    const { result } = setup(video);
    act(() => result.current.applyLoop("sentence"));
    expect(result.current.loop).toMatchObject({ startMs: 4000, endMs: 9000 });
    expect(video.currentTime).toBe(4);
  });

  it("pauses at the end of the chapter", () => {
    const video = fakeVideo(30);
    const { result } = setup(video);
    act(() => result.current.applySleep("chapter"));
    expect(result.current.sleep).toEqual({ kind: "chapter", videoId: "v", endMs: 60_000 });
    video.currentTime = 59.9;
    act(() => {
      result.current.handleTimeUpdate(video);
    });
    expect(video.pause).toHaveBeenCalled();
    expect(usePlaybackTools.getState().sleep).toBeNull();
    expect(result.current.notice).toBe("定时已到，已暂停");
  });

  it("starts a loop requested from elsewhere", () => {
    const video = fakeVideo(100);
    setup(video);
    act(() => usePlaybackTools.getState().startLoop({ videoId: "v", startMs: 2000, endMs: 8000 }));
    expect(video.currentTime).toBe(2);
    expect(video.play).toHaveBeenCalled();
  });
});
