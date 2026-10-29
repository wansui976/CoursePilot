import { afterEach, describe, expect, it, vi } from "vitest";
import { canRecord, pickMimeType } from "./useRecorder";

describe("useRecorder helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("按引擎支持挑编码：Chromium 用 WebM，WebKit 退到 MP4", () => {
    expect(pickMimeType((type) => type.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(pickMimeType((type) => type === "audio/mp4")).toBe("audio/mp4");
    expect(pickMimeType(() => false)).toBeUndefined();
  });

  it("没有 MediaRecorder 或 getUserMedia 就当录不了", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    expect(canRecord()).toBe(false);
  });
});
