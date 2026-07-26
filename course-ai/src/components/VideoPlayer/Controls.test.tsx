import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Controls } from "./Controls";
import { usePlayer } from "@/stores/player";

function renderControls(props: Partial<Parameters<typeof Controls>[0]> = {}) {
  const base = {
    playing: false,
    rate: 1,
    volume: 1,
    muted: false,
    captionsOn: false,
    skipSilence: false,
    skipSilenceLoading: false,
    skipRanges: [],
    fullscreen: false,
    onToggleCaptions: vi.fn(),
    onToggleSkipSilence: vi.fn(),
    onPreviewSkip: vi.fn(),
    onPlayPause: vi.fn(),
    onSeek: vi.fn(),
    onRate: vi.fn(),
    onVolume: vi.fn(),
    onMuteToggle: vi.fn(),
    onFullscreenToggle: vi.fn(),
  };
  return render(<Controls {...base} {...props} />);
}

describe("Controls speed button", () => {
  beforeEach(() => {
    usePlayer.setState({ currentMs: 0, durationMs: 60_000 });
  });

  it("labels the button 倍速 at 1x", () => {
    renderControls({ rate: 1 });
    expect(
      screen.getByRole("button", { name: /倍速，当前 1\.0x/ }),
    ).toHaveTextContent("倍速");
  });

  it("shows the current rate on the button when not 1x", () => {
    renderControls({ rate: 1.5 });
    const button = screen.getByRole("button", { name: /倍速，当前 1\.5x/ });
    expect(button).toHaveTextContent("1.5x");
    expect(button.className).toContain("text-[var(--accent)]");
  });

  it("closes the speed menu on Escape", () => {
    renderControls({ rate: 1 });
    fireEvent.click(screen.getByRole("button", { name: /倍速/ }));
    expect(screen.getByRole("menu", { name: "倍速" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu", { name: "倍速" })).not.toBeInTheDocument();
  });
});

describe("Controls skip-silence toggle", () => {
  beforeEach(() => {
    usePlayer.setState({ currentMs: 0, durationMs: 60_000 });
  });

  it("reflects and toggles the skip-silence switch", () => {
    const onToggleSkipSilence = vi.fn();
    renderControls({ skipSilence: true, onToggleSkipSilence });

    const button = screen.getByRole("button", { name: "跳停顿，已开启" });
    // 开着时按钮要看得出来是开着的，否则用户不知道画面为什么会自己往前跳。
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button.className).toContain("text-[var(--accent)]");

    fireEvent.click(button);
    expect(onToggleSkipSilence).toHaveBeenCalledTimes(1);
  });

  it("says 开 on the button so the state is readable at a glance", () => {
    const { rerender } = renderControls({ skipSilence: false });
    // 关着时只有名字，没有多余的状态字。
    expect(screen.getByRole("button", { name: "跳停顿，已关闭" })).toHaveTextContent(
      /^跳停顿$/,
    );

    rerender(<div />);
    renderControls({ skipSilence: true });
    expect(screen.getByRole("button", { name: "跳停顿，已开启" })).toHaveTextContent(
      "跳停顿 · 开",
    );
  });

  it("offers try-it buttons that land just before a pause", () => {
    const onPreviewSkip = vi.fn();
    usePlayer.setState({ currentMs: 0, durationMs: 60_000 });
    renderControls({
      skipSilence: true,
      skipRanges: [
        { start_ms: 10_000, end_ms: 20_000 },
        { start_ms: 40_000, end_ms: 45_000 },
      ],
      onPreviewSkip,
    });

    // 在开头：没有上一处可去，下一处落在第一段停顿前 1.5 秒。
    expect(screen.getByRole("button", { name: "上一处" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "下一处" }));
    expect(onPreviewSkip).toHaveBeenCalledWith(8_500);
  });

  it("hides the try-it buttons when there is nothing to skip", () => {
    renderControls({ skipSilence: true, skipRanges: [] });
    expect(screen.queryByRole("button", { name: "下一处" })).not.toBeInTheDocument();

    // 开关没打开时也不该出现——那两个按钮只为验证跳停顿而存在。
    renderControls({
      skipSilence: false,
      skipRanges: [{ start_ms: 10_000, end_ms: 20_000 }],
    });
    expect(screen.queryByRole("button", { name: "下一处" })).not.toBeInTheDocument();
  });

  it("shows 分析中 while the first scan is still running", () => {
    renderControls({ skipSilence: true, skipSilenceLoading: true });
    // 首次开启要扫音轨，这几秒内还跳不了，按钮上得说实话。
    expect(screen.getByRole("button", { name: "跳停顿，已开启" })).toHaveTextContent(
      "跳停顿 · 分析中",
    );
  });
});
