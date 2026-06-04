import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptionOverlay } from "./CaptionOverlay";

class ResizeObserverMock {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: target.getBoundingClientRect(),
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }

  disconnect() {}
  unobserve() {}
}

describe("CaptionOverlay", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the caption font safely below a tall caption box height", () => {
    localStorage.setItem(
      "caption-box",
      JSON.stringify({ left: 0.08, top: 0.4, width: 0.84, height: 0.5 }),
    );

    const stage = document.createElement("div");
    Object.defineProperty(stage, "clientHeight", {
      configurable: true,
      value: 400,
    });

    render(<CaptionOverlay text="这是一条字幕测试" stageRef={{ current: stage }} />);

    const caption = screen.getByText("这是一条字幕测试");
    const fontSize = Number.parseFloat(window.getComputedStyle(caption).fontSize);

    expect(fontSize).toBeLessThan(80);
  });
});
