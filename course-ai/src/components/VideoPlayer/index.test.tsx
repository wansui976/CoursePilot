import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VideoPlayer } from ".";
import { ipc } from "@/lib/ipc";
import { usePlayer } from "@/stores/player";

const setFullscreen = vi.hoisted(() => vi.fn());
const mockEnsureCrop = vi.hoisted(() => vi.fn());
const mockCancelCropDetect = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ipc", () => ({
  ipc: {
    transcripts: { list: vi.fn().mockResolvedValue([]) },
    videos: { ensureCrop: mockEnsureCrop, cancelCropDetect: mockCancelCropDetect },
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
  mockCancelCropDetect.mockReset();
  mockCancelCropDetect.mockResolvedValue(undefined);
});

/** 画面「已经能放了」——黑边探测等的就是这个信号。 */
function reachPlayable() {
  fireEvent.canPlay(screen.getByLabelText("课程视频播放器"));
}

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

  it("seeks +5s on a short right-arrow tap (committed on release)", () => {
    renderPlayer();
    const video = screen.getByLabelText("课程视频播放器") as HTMLVideoElement;
    const setCurrentTime = vi.fn();
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => 100,
      set: setCurrentTime,
    });

    fireEvent.keyDown(window, { key: "ArrowRight" });
    // 需要区分长短按：短按的 seek 在松键时提交。
    expect(setCurrentTime).not.toHaveBeenCalled();
    fireEvent.keyUp(window, { key: "ArrowRight" });
    expect(setCurrentTime).toHaveBeenCalledWith(105);
  });

  it("fast-forwards at 2x while the right arrow is held and restores on release", async () => {
    vi.useFakeTimers();
    try {
      renderPlayer();
      const video = screen.getByLabelText("课程视频播放器") as HTMLVideoElement;
      const setCurrentTime = vi.fn();
      const setRate = vi.fn();
      let rateValue = 1;
      Object.defineProperty(video, "currentTime", {
        configurable: true,
        get: () => 100,
        set: setCurrentTime,
      });
      Object.defineProperty(video, "playbackRate", {
        configurable: true,
        get: () => rateValue,
        set: (v: number) => {
          rateValue = v;
          setRate(v);
        },
      });
      // 变速不变调在扫描期间要临时关掉（WKWebView 切倍速时重建变调管线会卡顿）。
      let pitchValue = true;
      Object.defineProperty(video, "preservesPitch", {
        configurable: true,
        get: () => pitchValue,
        set: (v: boolean) => {
          pitchValue = v;
        },
      });

      fireEvent.keyDown(window, { key: "ArrowRight" });
      // 系统 auto-repeat 的 keydown 不应打断长按流程。
      fireEvent.keyDown(window, { key: "ArrowRight", repeat: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(220);
      });

      expect(setRate).toHaveBeenCalledWith(2);
      expect(pitchValue).toBe(false);
      expect(screen.getByText("2x 快进中")).toBeInTheDocument();

      fireEvent.keyUp(window, { key: "ArrowRight" });
      expect(setRate).toHaveBeenLastCalledWith(1);
      expect(pitchValue).toBe(true);
      // 长按结束不追加短按的 +5s。
      expect(setCurrentTime).not.toHaveBeenCalled();
      expect(screen.queryByText("2x 快进中")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rewinds continuously while the left arrow is held", async () => {
    vi.useFakeTimers();
    try {
      renderPlayer();
      const video = screen.getByLabelText("课程视频播放器") as HTMLVideoElement;
      const setCurrentTime = vi.fn();
      Object.defineProperty(video, "currentTime", {
        configurable: true,
        get: () => 100,
        set: setCurrentTime,
      });

      fireEvent.keyDown(window, { key: "ArrowLeft" });
      await act(async () => {
        // 200ms 进入扫描后再过 2 个回退周期（各 200ms）。
        await vi.advanceTimersByTimeAsync(200 + 410);
      });

      expect(setCurrentTime).toHaveBeenCalledTimes(2);
      expect(setCurrentTime).toHaveBeenCalledWith(100 - 0.8);
      expect(screen.getByText("快退中")).toBeInTheDocument();

      fireEvent.keyUp(window, { key: "ArrowLeft" });
      setCurrentTime.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      // 松开后扫描停止、也不补 ±5s。
      expect(setCurrentTime).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the caption above the control bar zone even while controls are hidden", async () => {
    // 控制栏是悬浮出现的：如果字幕只在控制栏「可见时」才避让，唤出控制栏的
    // 瞬间它会先盖住字幕、等 200ms 过渡才让开。字幕必须常年避开控制栏占位区。
    // 舞台高 400、控制栏高 64：默认字幕框底边 0.94*400=376 落入占位区
    // （400-64-8=328 以下），即使控制栏未显示也要上移 376-328=48px。
    localStorage.removeItem("caption-box");
    const offsetDesc = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    )!;
    const clientDesc = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "clientHeight",
    )!;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => 64,
    });
    Object.defineProperty(Element.prototype, "clientHeight", {
      configurable: true,
      get: () => 400,
    });
    try {
      vi.mocked(ipc.transcripts.list).mockResolvedValueOnce([
        {
          id: 1,
          video_id: "video-1",
          segment_idx: 0,
          start_ms: 0,
          end_ms: 5000,
          text: "这句字幕不能被控制栏挡住",
        },
      ]);
      act(() => usePlayer.getState().setCurrentMs(1000));

      renderPlayer(false);

      const caption = await screen.findByText("这句字幕不能被控制栏挡住");
      const group = caption.parentElement as HTMLElement;
      expect(group.style.transform).toBe("translateY(-48px)");
    } finally {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetDesc);
      Object.defineProperty(Element.prototype, "clientHeight", clientDesc);
    }
  });
});

describe("VideoPlayer black-bar detection cost", () => {
  it("waits until the picture can play before spending ffmpeg on detection", async () => {
    localStorage.clear();
    renderPlayer();

    await screen.findByRole("button", { name: "去黑边，已开启" });
    // 探测要解码正片三处；在首帧还没缓冲出来的时候开跑，就是和起播抢磁盘。
    expect(mockEnsureCrop).not.toHaveBeenCalled();

    reachPlayable();
    await waitFor(() => expect(mockEnsureCrop).toHaveBeenCalledWith("video-1"));
  });

  it("does not detect at all while the crop switch is off", async () => {
    localStorage.clear();
    localStorage.setItem("crop-black-bars", "off");
    renderPlayer();

    await screen.findByRole("button", { name: "去黑边，已关闭" });
    reachPlayable();
    // 关着开关还去测，等于为一个用不上的结果付整趟解码。
    await waitFor(() => expect(mockEnsureCrop).not.toHaveBeenCalled());
  });

  it("stops the detection when you leave the video", async () => {
    localStorage.clear();
    const { unmount } = renderPlayer();
    reachPlayable();
    await waitFor(() => expect(mockEnsureCrop).toHaveBeenCalled());

    unmount();
    // 切走了结果就没人要；不停的话连点几个视频会攒下一堆 ffmpeg，全压在新视频的起播上。
    expect(mockCancelCropDetect).toHaveBeenCalledWith("video-1");
  });
});

describe("VideoPlayer black-bar readout", () => {
  it("prints the detected insets on screen when the crop switch is flipped", async () => {
    localStorage.clear();
    mockEnsureCrop.mockResolvedValue({ top: 0.0625, right: 0, bottom: 0.0625, left: 0.125 });
    renderPlayer();

    const button = await screen.findByRole("button", { name: "去黑边，已开启" });
    reachPlayable();
    // 探测结果回来之前开关是灰的，等它可用再点。
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);

    // 悬浮提示看不到（控制栏会淡出），所以把探测值和实际用的值直接打在画面上。
    expect(await screen.findByText(/已关闭去黑边（探测值 上 6\.3%/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "去黑边，已关闭" }));
    expect(
      await screen.findByText(/已开启去黑边：.*→ 实际用 上 6\.3% \/ 右 0\.0% \/ 下 6\.3% \/ 左 0\.0%/),
    ).toBeInTheDocument();
  });
});
