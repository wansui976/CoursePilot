import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VideoPlayer } from ".";
import i18n from "@/i18n";
import { ipc } from "@/lib/ipc";
import { usePlayer } from "@/stores/player";

const setFullscreen = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ipc", () => ({
  ipc: {
    transcripts: { list: vi.fn().mockResolvedValue([]) },
    danmaku: {
      list: vi.fn().mockResolvedValue([]),
    },
    videos: {
      // 已探测过、无黑边。
      ensureCrop: vi.fn().mockResolvedValue({
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
        detecting: false,
      }),
      cancelCropDetect: vi.fn().mockResolvedValue(undefined),
    },
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

function renderPlayer(
  immersive = true,
  onFullscreenChange?: (fullscreen: boolean) => void,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <VideoPlayer
        src="http://127.0.0.1:1234/m/abc"
        videoId="video-1"
        immersive={immersive}
        onFullscreenChange={onFullscreenChange}
      />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  localStorage.removeItem("course-ai-playback-rate");
});

describe("VideoPlayer iOS gestures", () => {
  it("expands the uncropped video element to every stage edge", () => {
    renderPlayer(false);

    const video = screen.getByLabelText("课程视频播放器");
    expect(video).toHaveClass("h-full", "w-full", "object-contain");
    expect(video).toHaveClass("bg-[var(--surface-stage)]");
    expect(video).not.toHaveClass("bg-black");
    expect(video).toHaveAttribute("data-theme-heavy");
    // 去黑边会放大并偏移 video，所以它套在 stageBox 里（relative overflow-hidden 裁剪负偏移），
    // 而不是原先那个 absolute inset-0 的满铺容器。
    expect(video.parentElement).toHaveClass("relative", "overflow-hidden");
    expect(video.parentElement).not.toHaveClass("absolute");
    expect(video.parentElement).not.toHaveClass("rounded-xl");
  });

  it("keeps hidden desktop controls out of tab order and reveals them from the stage", () => {
    renderPlayer(false);

    const stage = screen.getByLabelText("课程视频舞台");
    const controls = screen.getByLabelText("视频播放控制栏", { selector: "div" });
    expect(stage).toHaveAttribute("tabindex", "0");
    expect(controls).toHaveAttribute("aria-hidden", "true");
    expect(controls).toHaveAttribute("inert");

    fireEvent.focus(stage);

    expect(controls).toHaveAttribute("aria-hidden", "false");
    expect(controls).not.toHaveAttribute("inert");
    expect(controls).toHaveClass("opacity-100");
  });

  it("restores and persists the selected base playback rate", () => {
    localStorage.setItem("course-ai-playback-rate", "1.25");
    renderPlayer();

    fireEvent.click(screen.getByRole("button", { name: "倍速，当前 1.25x" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "1.5x" }));

    expect(localStorage.getItem("course-ai-playback-rate")).toBe("1.5");
    expect(screen.getByRole("button", { name: "倍速，当前 1.5x" })).toBeInTheDocument();
  });

  it("reapplies the persisted rate after a media resource resets playback", () => {
    localStorage.setItem("course-ai-playback-rate", "1.5");
    renderPlayer();
    const video = screen.getByLabelText("课程视频播放器") as HTMLVideoElement;
    const setRate = vi.fn();
    Object.defineProperty(video, "playbackRate", {
      configurable: true,
      get: () => 1,
      set: setRate,
    });

    fireEvent.loadedMetadata(video);

    expect(setRate).toHaveBeenLastCalledWith(1.5);
    expect(video.defaultPlaybackRate).toBe(1.5);
  });

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

  it("reports fullscreen changes and exits fullscreen on Escape", async () => {
    const onFullscreenChange = vi.fn();
    setFullscreen.mockClear();
    setFullscreen.mockResolvedValue(undefined);
    renderPlayer(true, onFullscreenChange);

    fireEvent.click(screen.getByRole("button", { name: "全屏" }));
    await waitFor(() => expect(onFullscreenChange).toHaveBeenLastCalledWith(true));

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(setFullscreen).toHaveBeenLastCalledWith(false));
    await waitFor(() => expect(onFullscreenChange).toHaveBeenLastCalledWith(false));
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
    const video = screen.getByLabelText("课程视频播放器");
    const gestureLayer = screen.getByLabelText("课程视频手势层");

    // Default brightness must not force every decoded frame through a CSS filter.
    expect(video).not.toHaveStyle({ filter: "brightness(1)" });

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
      clientY: 280,
    });

    expect(screen.getByLabelText("播放手势提示")).toBeInTheDocument();
    expect(screen.getByText(/亮度/)).toBeInTheDocument();
    expect(video).toHaveStyle({ filter: "brightness(0.8)" });
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

    expect(screen.getByLabelText("播放手势提示")).toBeInTheDocument();
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

  it("keeps an effective smart rate separate from the base rate during long press", async () => {
    vi.useFakeTimers();
    try {
      renderPlayer();
      const gestureLayer = screen.getByLabelText("课程视频手势层");
      const video = screen.getByLabelText("课程视频播放器") as HTMLVideoElement;
      const setRate = vi.fn();
      let rateValue = 1.5;
      let pitchValue = true;
      Object.defineProperty(video, "playbackRate", {
        configurable: true,
        get: () => rateValue,
        set: (value: number) => {
          rateValue = value;
          setRate(value);
        },
      });
      Object.defineProperty(video, "preservesPitch", {
        configurable: true,
        get: () => pitchValue,
        set: (value: boolean) => {
          pitchValue = value;
        },
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
      // 1.5x 已是叠加后的有效速度；Apple 播放内核长按仍封顶 2x。
      expect(setRate).toHaveBeenLastCalledWith(2);
      expect(pitchValue).toBe(false);
      // 临时快进不能污染控制栏里的基础倍速。
      expect(screen.getByRole("button", { name: "倍速，当前 1.0x" })).toBeInTheDocument();

      fireEvent.pointerUp(gestureLayer, {
        pointerId: 1,
        pointerType: "touch",
        clientX: 120,
        clientY: 120,
      });
      expect(setRate).toHaveBeenLastCalledWith(1.5);
      expect(pitchValue).toBe(true);
      expect(screen.getByRole("button", { name: "倍速，当前 1.0x" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not rebuild the empty smart-rate plan while transcripts are pending", async () => {
    localStorage.setItem("smart-rate", "on");
    vi.mocked(ipc.transcripts.list).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      renderPlayer();
      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByLabelText("课程视频播放器")).toBeInTheDocument();
      expect(consoleError.mock.calls.flat().join(" ")).not.toContain(
        "Maximum update depth exceeded",
      );
    } finally {
      consoleError.mockRestore();
      localStorage.removeItem("smart-rate");
    }
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
      // 字幕框的 DOM 层级在可访问性重构后加深了（text → span → button → group），
      // transform 始终加在最外层 .group 上，不能再用 parentElement。
      const group = caption.closest(".group") as HTMLElement;
      expect(group.style.transform).toBe("translateY(-48px)");
    } finally {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetDesc);
      Object.defineProperty(Element.prototype, "clientHeight", clientDesc);
    }
  });
});
