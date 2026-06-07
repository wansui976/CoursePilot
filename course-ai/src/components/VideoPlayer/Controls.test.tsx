import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Controls } from "./Controls";

describe("Controls", () => {
  it("renders the caption toggle", () => {
    render(
      <Controls
        playing={false}
        currentMs={0}
        durationMs={0}
        rate={1}
        volume={1}
        muted={false}
        captionsOn={true}
        fullscreen={false}
        onToggleCaptions={vi.fn()}
        onPlayPause={vi.fn()}
        onSeek={vi.fn()}
        onRate={vi.fn()}
        onVolume={vi.fn()}
        onMuteToggle={vi.fn()}
        onFullscreenToggle={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "字幕" })).toBeInTheDocument();
  });
});
