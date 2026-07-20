import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VideoPlayer } from ".";

const setFullscreen = vi.hoisted(() => vi.fn());
const mockEnsureCrop = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ipc", () => ({
  ipc: {
    transcripts: { list: vi.fn().mockResolvedValue([]) },
    videos: { ensureCrop: mockEnsureCrop },
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setFullscreen }),
}));

vi.mock("@/lib/platform", () => ({
  isIOS: () => true,
  isMobile: () => true,
  isAndroid: () => false,
  isTablet: () => false,
  isDesktop: () => false,
}));

beforeEach(() => {
  mockEnsureCrop.mockReset();
  mockEnsureCrop.mockResolvedValue({ top: 0, right: 0, bottom: 0, left: 0 });
});

function renderPlayer(immersive = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <VideoPlayer
        src="http://127.0.0.1:1234/m/abc"
        videoId="video-1"
        immersive={immersive}
      />
    </QueryClientProvider>,
  );
}

describe("VideoPlayer iOS gestures", () => {
  it("toggles fullscreen on double tap", async () => {
    setFullscreen.mockClear();
    setFullscreen.mockResolvedValue(undefined);

    renderPlayer();
    const gestureLayer = screen.getByLabelText("课程视频手势层");

    fireEvent.pointerDown(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 120,
      clientY: 120,
    });
    fireEvent.pointerUp(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 120,
      clientY: 120,
    });
    fireEvent.pointerDown(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 122,
      clientY: 121,
    });
    fireEvent.pointerUp(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 122,
      clientY: 121,
    });

    await waitFor(() => expect(setFullscreen).toHaveBeenCalledWith(true));
  });

  it("seeks forward on right swipe", () => {
    renderPlayer();
    const video = screen.getByLabelText("课程视频播放器") as HTMLVideoElement;
    const gestureLayer = screen.getByLabelText("课程视频手势层");
    const setCurrentTime = vi.fn();

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => 30,
      set: setCurrentTime,
    });
    Object.defineProperty(video, "duration", {
      configurable: true,
      get: () => 120,
    });

    fireEvent.pointerDown(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 170,
      clientY: 104,
    });
    fireEvent.pointerUp(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 170,
      clientY: 104,
    });

    expect(setCurrentTime).toHaveBeenCalled();
    expect(setCurrentTime.mock.calls[setCurrentTime.mock.calls.length - 1]?.[0]).toBeGreaterThan(30);
  });

  it("bases repeated scrub moves on the initial time", () => {
    renderPlayer();
    const video = screen.getByLabelText("课程视频播放器") as HTMLVideoElement;
    const gestureLayer = screen.getByLabelText("课程视频手势层");
    const setCurrentTime = vi.fn();
    let currentTime = 30;

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
        setCurrentTime(value);
      },
    });
    Object.defineProperty(video, "duration", {
      configurable: true,
      get: () => 120,
    });

    fireEvent.pointerDown(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 120,
      clientY: 104,
    });
    fireEvent.pointerMove(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 130,
      clientY: 104,
    });

    expect(setCurrentTime.mock.calls.map(([value]) => value)).toEqual([32, 33]);
  });

  it("seeks backward on left swipe", () => {
    renderPlayer();
    const video = screen.getByLabelText("课程视频播放器") as HTMLVideoElement;
    const gestureLayer = screen.getByLabelText("课程视频手势层");
    const setCurrentTime = vi.fn();

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => 30,
      set: setCurrentTime,
    });
    Object.defineProperty(video, "duration", {
      configurable: true,
      get: () => 120,
    });

    fireEvent.pointerDown(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 170,
      clientY: 100,
    });
    fireEvent.pointerMove(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 95,
      clientY: 104,
    });
    fireEvent.pointerUp(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 95,
      clientY: 104,
    });

    expect(setCurrentTime).toHaveBeenCalled();
    expect(setCurrentTime.mock.calls[setCurrentTime.mock.calls.length - 1]?.[0]).toBeLessThan(30);
  });

  it("shows a brightness overlay while adjusting brightness", () => {
    renderPlayer();
    const gestureLayer = screen.getByLabelText("课程视频手势层");

    fireEvent.pointerDown(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 80,
      clientY: 200,
    });
    fireEvent.pointerMove(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 80,
      clientY: 120,
    });

    expect(screen.getByLabelText("亮度浮层")).toBeInTheDocument();
    expect(screen.getByText(/亮度/)).toBeInTheDocument();
  });

  it("shows a volume overlay while adjusting volume", () => {
    renderPlayer();
    const gestureLayer = screen.getByLabelText("课程视频手势层");

    fireEvent.pointerDown(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 780,
      clientY: 200,
    });
    fireEvent.pointerMove(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 780,
      clientY: 120,
    });

    expect(screen.getByLabelText("亮度浮层")).toBeInTheDocument();
    expect(screen.getByText(/音量/)).toBeInTheDocument();
  });

  it("doubles the current playback rate while long pressing", async () => {
    vi.useFakeTimers();
    renderPlayer();
    const gestureLayer = screen.getByLabelText("课程视频手势层");
    const video = screen.getByLabelText("课程视频播放器") as HTMLVideoElement;
    const setRate = vi.fn();
    Object.defineProperty(video, "playbackRate", {
      configurable: true,
      get: () => 1,
      set: setRate,
    });

    fireEvent.pointerDown(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 120,
      clientY: 120,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(setRate).toHaveBeenCalledWith(2);

    fireEvent.pointerUp(gestureLayer, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 120,
      clientY: 120,
    });
    expect(setRate).toHaveBeenLastCalledWith(1);
    vi.useRealTimers();
  });
});
