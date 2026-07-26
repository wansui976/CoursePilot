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
    fullscreen: false,
    onToggleCaptions: vi.fn(),
    onToggleSkipSilence: vi.fn(),
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

  it("shows 分析中 while the first scan is still running", () => {
    renderControls({ skipSilence: true, skipSilenceLoading: true });
    // 首次开启要扫音轨，这几秒内还跳不了，按钮上得说实话。
    expect(screen.getByRole("button", { name: "跳停顿，已开启" })).toHaveTextContent(
      "跳停顿 · 分析中",
    );
  });
});
