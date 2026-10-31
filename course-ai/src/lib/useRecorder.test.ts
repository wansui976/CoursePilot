import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canRecord, pickMimeType, useRecorder } from "./useRecorder";

/** 假的 MediaRecorder：只实现这条链路用到的部分。 */
class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = () => true;
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(public stream: unknown) {
    FakeRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
}

let originalMediaDevices: PropertyDescriptor | undefined;

/** 装一套「权限弹窗还挂着」的麦克风环境：getUserMedia 由测试自己 resolve。 */
function stubPendingPermission() {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  let resolve!: (value: MediaStream) => void;
  const getUserMedia = vi.fn(
    () =>
      new Promise<MediaStream>((done) => {
        resolve = done;
      }),
  );
  originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  return {
    getUserMedia,
    stop,
    grant: () => resolve(stream),
  };
}

describe("useRecorder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeRecorder.instances = [];
    if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    else Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("按引擎支持挑编码：Chromium 用 WebM，WebKit 退到 MP4", () => {
    expect(pickMimeType((type) => type.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(pickMimeType((type) => type === "audio/mp4")).toBe("audio/mp4");
    expect(pickMimeType(() => false)).toBeUndefined();
  });

  it("没有 MediaRecorder 或 getUserMedia 就当录不了", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    expect(canRecord()).toBe(false);
  });

  it("权限弹窗还没结束时连点两次，只请求一次麦克风", async () => {
    const media = stubPendingPermission();
    const { result } = renderHook(() => useRecorder());

    act(() => {
      void result.current.start();
    });
    act(() => {
      void result.current.start();
    });
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      media.grant();
      await Promise.resolve();
    });
    expect(result.current.state.status).toBe("recording");
    expect(FakeRecorder.instances).toHaveLength(1);
  });

  it("权限弹窗期间关掉对话框：拿到流后立刻还回去，不留下没人停的麦克风", async () => {
    const media = stubPendingPermission();
    const { result, unmount } = renderHook(() => useRecorder());

    act(() => {
      void result.current.start();
    });
    unmount();
    await act(async () => {
      media.grant();
      await Promise.resolve();
    });

    expect(media.stop).toHaveBeenCalled();
    expect(FakeRecorder.instances).toHaveLength(0);
  });

  it("拒绝麦克风权限时给出 denied", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(
      Object.assign(new Error("denied"), { name: "NotAllowedError" }),
    );
    originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const { result } = renderHook(() => useRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toEqual({ status: "error", reason: "denied" });
  });

  it("卸载时停掉录音与麦克风", async () => {
    const media = stubPendingPermission();
    const { result, unmount } = renderHook(() => useRecorder());
    act(() => {
      void result.current.start();
    });
    await act(async () => {
      media.grant();
      await Promise.resolve();
    });
    expect(result.current.state.status).toBe("recording");

    unmount();
    expect(media.stop).toHaveBeenCalled();
    expect(FakeRecorder.instances[0].state).toBe("inactive");
  });
});
