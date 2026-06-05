import { describe, expect, it } from "vitest";
import { detectBlackBars, type Insets } from "./blackBars";

/** 造一帧 RGBA 像素：paint(x,y) 返回 [r,g,b]。 */
function makeFrame(
  w: number,
  h: number,
  paint: (x: number, y: number) => [number, number, number],
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] = paint(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

const BLACK: [number, number, number] = [0, 0, 0];
const GRAY: [number, number, number] = [128, 128, 128];

describe("detectBlackBars", () => {
  it("detects top/bottom letterbox bars", () => {
    const data = makeFrame(100, 100, (_x, y) =>
      y < 10 || y >= 90 ? BLACK : GRAY,
    );
    const insets: Insets = detectBlackBars(data, 100, 100);
    expect(insets.top).toBeCloseTo(0.1, 5);
    expect(insets.bottom).toBeCloseTo(0.1, 5);
    expect(insets.left).toBe(0);
    expect(insets.right).toBe(0);
  });

  it("detects left/right pillarbox bars", () => {
    const data = makeFrame(100, 100, (x, _y) =>
      x < 10 || x >= 90 ? BLACK : GRAY,
    );
    const insets = detectBlackBars(data, 100, 100);
    expect(insets.left).toBeCloseTo(0.1, 5);
    expect(insets.right).toBeCloseTo(0.1, 5);
    expect(insets.top).toBe(0);
    expect(insets.bottom).toBe(0);
  });

  it("returns no insets for a clean frame", () => {
    const data = makeFrame(100, 100, () => GRAY);
    expect(detectBlackBars(data, 100, 100)).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });

  it("does not crop an all-black frame (over-MAX guard)", () => {
    const data = makeFrame(100, 100, () => BLACK);
    expect(detectBlackBars(data, 100, 100)).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });

  it("tolerates a few outlier bright pixels inside a black bar", () => {
    const data = makeFrame(100, 100, (x, y) => {
      const inBar = y < 10 || y >= 90;
      if (inBar && x === 0) return [255, 255, 255]; // 1% 离群点
      return inBar ? BLACK : GRAY;
    });
    expect(detectBlackBars(data, 100, 100).top).toBeCloseTo(0.1, 5);
  });

  it("ignores a sub-threshold 1px bar (under MIN guard)", () => {
    const data = makeFrame(100, 100, (_x, y) => (y < 1 ? BLACK : GRAY));
    expect(detectBlackBars(data, 100, 100).top).toBe(0);
  });
});
