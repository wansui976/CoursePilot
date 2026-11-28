import { afterEach, describe, expect, it, vi } from "vitest";
import { isInPip, pipSupported, setPip } from "./pictureInPicture";

function defineDocument(props: Record<string, unknown>) {
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(document, key, { configurable: true, value });
  }
}

afterEach(() => {
  defineDocument({
    pictureInPictureEnabled: undefined,
    pictureInPictureElement: null,
    exitPictureInPicture: undefined,
  });
});

describe("picture in picture", () => {
  it("is unsupported when the WebView offers neither API (Android)", () => {
    const video = document.createElement("video");
    expect(pipSupported(video)).toBe(false);
    expect(pipSupported(null)).toBe(false);
  });

  it("uses the standard API and lifts disablePictureInPicture only for the request", async () => {
    const video = document.createElement("video");
    video.disablePictureInPicture = true;
    let allowedDuringRequest: boolean | null = null;
    video.requestPictureInPicture = vi.fn(async () => {
      allowedDuringRequest = !video.disablePictureInPicture;
      defineDocument({ pictureInPictureElement: video });
      return {} as PictureInPictureWindow;
    });
    const exit = vi.fn(async () => defineDocument({ pictureInPictureElement: null }));
    defineDocument({ pictureInPictureEnabled: true, exitPictureInPicture: exit });

    expect(pipSupported(video)).toBe(true);
    await setPip(video, true);
    expect(allowedDuringRequest).toBe(true);
    expect(isInPip(video)).toBe(true);

    await setPip(video, false);
    expect(exit).toHaveBeenCalled();
    expect(isInPip(video)).toBe(false);
  });

  it("falls back to WebKit presentation mode on iPhone / iPad", async () => {
    const video = document.createElement("video") as HTMLVideoElement & {
      webkitSupportsPresentationMode: (mode: string) => boolean;
      webkitSetPresentationMode: (mode: string) => void;
      webkitPresentationMode: string;
    };
    video.webkitPresentationMode = "inline";
    video.webkitSupportsPresentationMode = (mode) => mode === "picture-in-picture";
    video.webkitSetPresentationMode = vi.fn((mode: string) => {
      video.webkitPresentationMode = mode;
    });

    expect(pipSupported(video)).toBe(true);
    await setPip(video, true);
    expect(video.webkitSetPresentationMode).toHaveBeenCalledWith("picture-in-picture");
    expect(isInPip(video)).toBe(true);
    await setPip(video, false);
    expect(video.webkitSetPresentationMode).toHaveBeenLastCalledWith("inline");
  });

  it("restores disablePictureInPicture when the request is refused", async () => {
    const video = document.createElement("video");
    video.disablePictureInPicture = true;
    video.requestPictureInPicture = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    defineDocument({ pictureInPictureEnabled: true });
    await expect(setPip(video, true)).rejects.toThrow("NotAllowedError");
    expect(video.disablePictureInPicture).toBe(true);
  });
});
