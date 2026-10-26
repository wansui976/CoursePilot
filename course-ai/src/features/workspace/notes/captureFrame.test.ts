import { describe, expect, it, vi } from "vitest";

const { ipc } = vi.hoisted(() => ({
  ipc: {
    slides: { capture: vi.fn(), image: vi.fn(), captureImage: vi.fn() },
    ai: { saveNoteImage: vi.fn() },
  },
}));
vi.mock("@/lib/ipc", () => ({ ipc }));
vi.mock("./prepareImage", () => ({
  prepareImage: vi.fn(async (blob: Blob) => ({ blob, mime: "image/jpeg", width: 1280, height: 720 })),
  blobToBase64: vi.fn(async () => "AAAA"),
}));
vi.mock("./noteImage", () => ({ primeNoteImage: vi.fn() }));

describe("笔记里截取画面", () => {
  it("只取图片字节，不登记成课件页「我的截图」", async () => {
    const { captureFrameBlocks } = await import("./insertImages");
    ipc.slides.captureImage.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    ipc.ai.saveNoteImage.mockResolvedValue({ id: "x", src: "note-image:x" });

    const blocks = await captureFrameBlocks("v1", 95_400.4);

    expect(ipc.slides.captureImage).toHaveBeenCalledWith("v1", 95_400);
    expect(ipc.slides.capture).not.toHaveBeenCalled();
    expect(blocks[0]).toEqual({
      type: "image",
      attrs: { src: "note-image:x", width: 1280, height: 720, alt: null },
    });
    expect(blocks[1].content?.[0]).toEqual({ type: "timestamp", attrs: { ms: 95_400 } });
  });
});
