import { describe, expect, it } from "vitest";
import { normalizeCrop } from "./imageCrop";

describe("normalizeCrop", () => {
  it("任意方向拖都规整成左上角 + 宽高，并夹在图内", () => {
    expect(normalizeCrop(0.8, 0.9, 0.2, 0.1)).toEqual({ x: 0.2, y: 0.1, w: 0.6000000000000001, h: 0.8 });
    expect(normalizeCrop(-0.5, 0.5, 0.5, 1.5)).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
  });

  it("太小的框当成没框", () => {
    expect(normalizeCrop(0.5, 0.5, 0.51, 0.7)).toBeNull();
  });
});
