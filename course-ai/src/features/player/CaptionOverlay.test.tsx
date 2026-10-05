import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  function renderCaption(initial?: {
    left: number;
    top: number;
    width: number;
    height: number;
  }) {
    if (initial) localStorage.setItem("caption-box", JSON.stringify(initial));
    const stage = document.createElement("div");
    Object.defineProperty(stage, "clientHeight", {
      configurable: true,
      value: 400,
    });
    stage.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1000,
        bottom: 400,
        width: 1000,
        height: 400,
        toJSON: () => ({}),
      }) as DOMRect;

    render(<CaptionOverlay text="这是一条字幕测试" containerRef={{ current: stage }} />);
    const move = screen.getByRole("button", { name: /移动字幕框/ });
    return { move, box: move.parentElement as HTMLDivElement };
  }

  function numericStyle(box: HTMLDivElement, property: "left" | "top" | "width" | "height") {
    return Number.parseFloat(box.style[property]) / 100;
  }

  it("keeps the caption font safely below a tall caption box height", () => {
    renderCaption({ left: 0.08, top: 0.4, width: 0.84, height: 0.5 });

    const caption = screen.getByText("这是一条字幕测试");
    const fontSize = Number.parseFloat(window.getComputedStyle(caption).fontSize);

    expect(fontSize).toBeLessThan(80);
    // 量高必须真的生效：若 stageHeight 卡在 0，字号会退到最小 12，这条测试就白测了。
    expect(fontSize).toBeGreaterThan(12);
  });

  it("exposes the move surface and four resize corners as named focusable controls", () => {
    const { move } = renderCaption();
    const handles = ["左上角", "右上角", "左下角", "右下角"].map((corner) =>
      screen.getByRole("button", { name: new RegExp(`调整字幕框${corner}`) }),
    );

    expect(move).toHaveAccessibleName(/左侧 8%.*顶部 80%/);
    expect(move).toHaveAccessibleDescription(
      /这是一条字幕测试.*使用方向键微调/,
    );
    const [captionTextId, keyboardHintId] =
      move.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(document.getElementById(captionTextId)).toHaveTextContent(
      "这是一条字幕测试",
    );
    expect(move).toHaveAttribute("aria-keyshortcuts", expect.stringContaining("Home"));
    expect(move).toHaveClass("focus-visible:ring-[var(--focus-ring)]");
    move.focus();
    expect(move).toHaveFocus();

    for (const handle of handles) {
      expect(handle).toHaveAttribute("aria-describedby", keyboardHintId);
      expect(handle).not.toHaveAccessibleDescription(/这是一条字幕测试/);
      expect(handle).toHaveClass("focus-visible:ring-[var(--focus-ring)]");
    }
  });

  it("moves by a small arrow step and a larger Shift+Arrow step, then persists", async () => {
    const { move, box } = renderCaption();

    fireEvent.keyDown(move, { key: "ArrowLeft" });
    fireEvent.keyDown(move, { key: "ArrowUp", shiftKey: true });

    expect(numericStyle(box, "left")).toBeCloseTo(0.07);
    expect(numericStyle(box, "top")).toBeCloseTo(0.75);
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("caption-box") ?? "{}")).toMatchObject({
        left: 0.07,
        top: 0.75,
      }),
    );
  });

  it.each([
    ["左上角", "ArrowRight", { left: 0.09, width: 0.83 }],
    ["右上角", "ArrowRight", { left: 0.08, width: 0.85 }],
    ["左下角", "ArrowLeft", { left: 0.07, width: 0.85 }],
    ["右下角", "ArrowDown", { top: 0.8, height: 0.15 }],
  ])("resizes from the %s handle with the arrow keys", (corner, key, expected) => {
    const { box } = renderCaption();
    const handle = screen.getByRole("button", {
      name: new RegExp(`调整字幕框${corner}`),
    });

    fireEvent.keyDown(handle, { key });

    for (const [property, value] of Object.entries(expected)) {
      expect(
        numericStyle(box, property as "left" | "top" | "width" | "height"),
      ).toBeCloseTo(value);
    }
  });

  it("clamps movement, resize, and the minimum box size at every edge", () => {
    const { move, box } = renderCaption({ left: 0, top: 0, width: 0.05, height: 0.05 });
    const northwest = screen.getByRole("button", { name: /调整字幕框左上角/ });

    fireEvent.keyDown(move, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(move, { key: "ArrowUp", shiftKey: true });
    fireEvent.keyDown(northwest, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(northwest, { key: "ArrowDown", shiftKey: true });

    expect(numericStyle(box, "left")).toBe(0);
    expect(numericStyle(box, "top")).toBe(0);
    expect(numericStyle(box, "width")).toBeCloseTo(0.05);
    expect(numericStyle(box, "height")).toBeCloseTo(0.05);
  });

  it("restores and persists the default layout with Home", async () => {
    const { box } = renderCaption({ left: 0.2, top: 0.3, width: 0.4, height: 0.2 });
    const southeast = screen.getByRole("button", { name: /调整字幕框右下角/ });

    fireEvent.keyDown(southeast, { key: "Home" });

    expect(numericStyle(box, "left")).toBeCloseTo(0.08);
    expect(numericStyle(box, "top")).toBeCloseTo(0.8);
    expect(numericStyle(box, "width")).toBeCloseTo(0.84);
    expect(numericStyle(box, "height")).toBeCloseTo(0.14);
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("caption-box") ?? "{}")).toEqual({
        left: 0.08,
        top: 0.8,
        width: 0.84,
        height: 0.14,
      }),
    );
  });

  it("keeps pointer dragging available on the newly focusable move surface", () => {
    const { move, box } = renderCaption();

    fireEvent.pointerDown(move, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 120 });
    fireEvent.pointerUp(window);

    expect(numericStyle(box, "left")).toBeCloseTo(0.16);
    expect(numericStyle(box, "top")).toBeCloseTo(0.85);
  });
});
