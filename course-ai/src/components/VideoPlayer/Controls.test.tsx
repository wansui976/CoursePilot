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

    const button = screen.getByRole("button", { name: "跳停顿" });
    // 开着时按钮要看得出来是开着的，否则用户不知道画面为什么会自己往前跳。
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button.className).toContain("text-[var(--accent)]");

    fireEvent.click(button);
    expect(onToggleSkipSilence).toHaveBeenCalledTimes(1);
  });
});
