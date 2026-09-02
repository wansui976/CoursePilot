import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMock, unlistenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  unlistenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { ipc } from "./ipc";

describe("ipc.assistant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenMock.mockResolvedValue(unlistenMock);
  });

  it("rejects an immediate command failure once and removes the stream listener", async () => {
    const error = new Error("assistant invoke failed");
    invokeMock.mockRejectedValueOnce(error);

    await expect(
      ipc.assistant.ask("问题", undefined, undefined, "request-1"),
    ).rejects.toBe(error);
    await Promise.resolve();

    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });
});

describe("ipc.danmaku", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches danmaku for a video", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await ipc.danmaku.list("video-1");
    expect(invokeMock).toHaveBeenCalledWith("cmd_get_danmaku", { videoId: "video-1" });
  });

  it("fetches comments for a video", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await ipc.danmaku.comments("video-1");
    expect(invokeMock).toHaveBeenCalledWith("cmd_get_comments", { videoId: "video-1" });
  });
});
