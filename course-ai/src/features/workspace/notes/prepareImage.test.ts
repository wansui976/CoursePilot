import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blobToBase64, ImageTooLargeError, prepareImage, TARGET_BYTES } from "./prepareImage";

// jsdom 没有图像解码与画布编码：解码给一个固定尺寸，编码按「像素数 × 每像素字节」估大小。
let size = { width: 800, height: 600 };
let bytesPerPixel: Record<string, number> = {};
const encoded: { mime: string; width: number; quality?: number }[] = [];

beforeEach(() => {
  encoded.length = 0;
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ ...size, close: vi.fn() })));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    callback,
    mime = "image/png",
    quality,
  ) {
    encoded.push({ mime, width: this.width, quality });
    const perPixel = (bytesPerPixel[mime] ?? 1) * (quality ?? 1);
    callback(new Blob([new Uint8Array(Math.round(this.width * this.height * perPixel))], { type: mime }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const blob = (bytes: number, type: string) => new Blob([new Uint8Array(bytes)], { type });

describe("插图前压缩", () => {
  it("本来就小的图原样保留，不重新编码", async () => {
    size = { width: 800, height: 600 };
    const input = blob(50_000, "image/png");
    const result = await prepareImage(input);
    expect(result).toEqual({ blob: input, mime: "image/png", width: 800, height: 600 });
    expect(encoded).toEqual([]);
  });

  it("大截图先缩到 2000 宽试 PNG，够小就用 PNG", async () => {
    size = { width: 4000, height: 2000 };
    bytesPerPixel = { "image/png": 0.1 };
    const result = await prepareImage(blob(3_000_000, "image/png"));
    expect(result.mime).toBe("image/png");
    expect([result.width, result.height]).toEqual([2000, 1000]);
    expect(result.blob.size).toBeLessThanOrEqual(TARGET_BYTES);
  });

  it("PNG 太大就转 JPEG 逐级降质", async () => {
    size = { width: 2000, height: 1000 };
    bytesPerPixel = { "image/png": 2, "image/jpeg": 0.35 };
    const result = await prepareImage(blob(3_000_000, "image/png"));
    expect(result.mime).toBe("image/jpeg");
    expect(result.blob.size).toBeLessThanOrEqual(TARGET_BYTES);
    expect(encoded.filter((e) => e.mime === "image/jpeg").map((e) => e.quality)).toEqual([0.9, 0.82, 0.72]);
  });

  it("怎么压都超限时报 ImageTooLargeError", async () => {
    size = { width: 2000, height: 1000 };
    bytesPerPixel = { "image/jpeg": 100 };
    await expect(prepareImage(blob(3_000_000, "image/jpeg"))).rejects.toBeInstanceOf(ImageTooLargeError);
  });

  it("base64 编码与 btoa 一致", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(await blobToBase64(new Blob([bytes]))).toBe(btoa(String.fromCharCode(...bytes)));
  });
});
