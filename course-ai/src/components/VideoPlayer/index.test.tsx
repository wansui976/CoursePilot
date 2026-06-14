import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VideoPlayer } from ".";

const setFullscreen = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ipc", () => ({
  ipc: { transcripts: { list: vi.fn().mockResolvedValue([]) } },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setFullscreen }),
}));

function renderPlayer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <VideoPlayer src="http://127.0.0.1:1234/m/abc" videoId="video-1" />
    </QueryClientProvider>,
  );
}

describe("VideoPlayer", () => {
  it("keeps video playback inline inside the learning workspace", () => {
    renderPlayer();

    const video = screen.getByLabelText("课程视频播放器");

    expect(video).toHaveAttribute("playsinline");
    expect(video).toHaveAttribute("webkit-playsinline");
    expect(video).toHaveAttribute("disablepictureinpicture");
    expect(video).toHaveAttribute("src", "http://127.0.0.1:1234/m/abc");
  });

  it("exposes a 字幕 toggle in the controls", () => {
    renderPlayer();
    fireEvent.mouseEnter(screen.getByLabelText("课程视频舞台"));
    expect(screen.getByRole("button", { name: "字幕" })).toBeInTheDocument();
  });

  it("uses the active accent color for video progress controls", () => {
    renderPlayer();
    fireEvent.mouseEnter(screen.getByLabelText("课程视频舞台"));

    expect(screen.getByLabelText("播放进度")).toHaveStyle({
      "--video-control-color": "var(--accent)",
    });
    expect(screen.getByRole("button", { name: "字幕" })).toHaveClass(
      "text-[var(--accent)]",
    );
  });

  it("hides the desktop control bar until the video is hovered", async () => {
    renderPlayer();

    const stage = screen.getByLabelText("课程视频舞台");
    const controls = screen.getByLabelText("视频播放控制栏");

    expect(controls).toHaveClass("shrink-0");
    expect(controls).toHaveClass("invisible", "opacity-0", "pointer-events-none");

    fireEvent.mouseEnter(stage);

    expect(controls).not.toHaveClass("invisible", "opacity-0", "pointer-events-none");

    fireEvent.mouseLeave(stage);

    await waitFor(() =>
      expect(controls).toHaveClass("invisible", "opacity-0", "pointer-events-none"),
    );
  });

  it("does not wrap the video in an extra rounded black frame", () => {
    renderPlayer();

    expect(screen.getByLabelText("课程视频舞台")).not.toHaveClass("rounded-[14px]");
  });

  it("enters video fullscreen (window fullscreen + overlay) and toggles the control", async () => {
    setFullscreen.mockClear();
    setFullscreen.mockResolvedValue(undefined);

    renderPlayer();
    fireEvent.mouseEnter(screen.getByLabelText("课程视频舞台"));

    fireEvent.click(screen.getByRole("button", { name: "全屏" }));
    await waitFor(() => expect(setFullscreen).toHaveBeenCalledWith(true));
    expect(screen.getByRole("button", { name: "退出全屏" })).toBeInTheDocument();
  });

  it("exits video fullscreen when toggled again", async () => {
    setFullscreen.mockClear();
    setFullscreen.mockResolvedValue(undefined);

    renderPlayer();
    fireEvent.mouseEnter(screen.getByLabelText("课程视频舞台"));

    fireEvent.click(screen.getByRole("button", { name: "全屏" }));
    fireEvent.click(await screen.findByRole("button", { name: "退出全屏" }));
    await waitFor(() => expect(setFullscreen).toHaveBeenLastCalledWith(false));
    expect(screen.getByRole("button", { name: "全屏" })).toBeInTheDocument();
  });
});
