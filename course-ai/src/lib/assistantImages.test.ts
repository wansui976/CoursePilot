import { describe, expect, it } from "vitest";
import { fitWithin, imageFilesFromClipboard, MAX_IMAGE_EDGE } from "./assistantImages";

describe("assistantImages", () => {
  it("本来就够小的图不缩放", () => {
    expect(fitWithin(1280, 720)).toEqual({ width: 1280, height: 720 });
  });

  it("超出的按长边等比缩到上限", () => {
    expect(fitWithin(3840, 2160)).toEqual({ width: MAX_IMAGE_EDGE, height: 1152 });
    expect(fitWithin(1000, 4096)).toEqual({ width: 500, height: MAX_IMAGE_EDGE });
  });

  it("极端长条图的短边不会被缩成 0", () => {
    expect(fitWithin(100_000, 10).height).toBe(1);
  });

  it("只从剪贴板里拿图片文件，文字和其他文件不动", () => {
    const png = new File(["x"], "a.png", { type: "image/png" });
    const pdf = new File(["x"], "a.pdf", { type: "application/pdf" });
    const data = {
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => png },
        { kind: "file", type: "application/pdf", getAsFile: () => pdf },
      ],
    } as unknown as DataTransfer;
    expect(imageFilesFromClipboard(data)).toEqual([png]);
    expect(imageFilesFromClipboard(null)).toEqual([]);
  });
});
