import "@testing-library/jest-dom/vitest";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { DanmakuOverlay } from "./DanmakuOverlay";
import type { DanmakuEntry } from "@/lib/types";

// jsdom 没有 2d context：给一个够用的桩，验证「到点的弹幕被画上画布」这条链路。
const ctx = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  measureText: vi.fn(() => ({ width: 40 })),
  strokeText: vi.fn(),
  fillText: vi.fn(),
  font: "",
  textBaseline: "",
  globalAlpha: 1,
  lineWidth: 1,
  strokeStyle: "",
  lineJoin: "",
  fillStyle: "",
};

let stageWidth = 800;
let stageHeight = 450;

beforeEach(() => {
  stageWidth = 800;
  stageHeight = 450;
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => stageWidth,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    () => stageHeight,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ENTRIES: DanmakuEntry[] = [
  { mode: "scroll", start_ms: 10_000, text: "前方高能", color: "#ff0000", font_size: null },
  { mode: "top", start_ms: 60_000, text: "片头", color: null, font_size: null },
];

function nextFrame() {
  return act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

describe("DanmakuOverlay", () => {
  it("renders a decorative canvas layered over the video", () => {
    const videoRef = createRef<HTMLVideoElement>();
    const { container } = render(
      <DanmakuOverlay entries={ENTRIES} videoRef={videoRef} />,
    );

    const canvas = container.querySelector("canvas");
    expect(canvas).toHaveAttribute("data-danmaku-overlay");
    expect(canvas).toHaveAttribute("aria-hidden");
    expect(canvas?.className).toContain("pointer-events-none");
  });

  it("draws danmaku that come due at the current video time", async () => {
    const videoRef = {
      current: { currentTime: 10 },
    } as React.RefObject<HTMLVideoElement | null>;
    render(<DanmakuOverlay entries={ENTRIES} videoRef={videoRef} />);

    await nextFrame();

    expect(ctx.fillText).toHaveBeenCalledWith(
      "前方高能",
      expect.any(Number),
      expect.any(Number),
    );
    // 弹幕颜色落到 fillStyle；默认色（null）用白色。
    expect(ctx.fillStyle).toBe("#ff0000");
  });

  it("does not draw danmaku from other moments", async () => {
    const videoRef = {
      current: { currentTime: 30 },
    } as React.RefObject<HTMLVideoElement | null>;
    render(<DanmakuOverlay entries={ENTRIES} videoRef={videoRef} />);

    await nextFrame();

    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it("keeps drawing nothing when the canvas reports zero size", async () => {
    stageWidth = 0;
    stageHeight = 0;
    const videoRef = {
      current: { currentTime: 10 },
    } as React.RefObject<HTMLVideoElement | null>;
    render(<DanmakuOverlay entries={ENTRIES} videoRef={videoRef} />);

    await nextFrame();

    expect(ctx.fillText).not.toHaveBeenCalled();
  });
});
