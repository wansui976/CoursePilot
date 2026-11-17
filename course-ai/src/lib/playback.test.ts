import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoProgress } from "./ipc";
import {
  atKey,
  durKey,
  hydratePlaybackProgress,
  lastVideoKey,
  mergePlaybackProgress,
  posKey,
  readLastVideoId,
  readPlaybackProgress,
  usePlaybackRevision,
  writePlaybackPosition,
} from "./playback";

vi.mock("./ipc", () => ({
  ipc: { stats: { videoProgress: vi.fn(), saveVideoProgress: vi.fn() } },
}));

import { ipc } from "./ipc";

function row(partial: Partial<VideoProgress> & { video_id: string }): VideoProgress {
  return {
    position_ms: 60_000,
    duration_ms: 600_000,
    course_id: "c1",
    updated_at: 1_000,
    ...partial,
  };
}

describe("播放进度：库为准、本地为缓存", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("本地没有记录时用库里的（换了台设备、或本地存储被清过）", () => {
    expect(mergePlaybackProgress([row({ video_id: "v1", position_ms: 90_000 })])).toBe(true);
    expect(readPlaybackProgress("v1")).toMatchObject({ positionSec: 90, durationSec: 600 });
    expect(localStorage.getItem(atKey("v1"))).toBe("1000");
  });

  it("库里更新（别的设备看过）时覆盖本地", () => {
    localStorage.setItem(posKey("v1"), "30");
    localStorage.setItem(atKey("v1"), "500");
    expect(mergePlaybackProgress([row({ video_id: "v1", position_ms: 120_000, updated_at: 900 })])).toBe(true);
    expect(readPlaybackProgress("v1").positionSec).toBe(120);
  });

  it("本地更新（正在看、还没同步进库）时保留本地", () => {
    localStorage.setItem(posKey("v1"), "300");
    localStorage.setItem(atKey("v1"), "2000");
    expect(mergePlaybackProgress([row({ video_id: "v1", position_ms: 60_000, updated_at: 1_500 })])).toBe(false);
    expect(readPlaybackProgress("v1").positionSec).toBe(300);
  });

  it("升级前留下的本地记录没有时刻：保留本地，时刻记成库里的，之后更新的同步能盖过来", () => {
    localStorage.setItem(posKey("v1"), "300");
    expect(mergePlaybackProgress([row({ video_id: "v1", position_ms: 60_000, updated_at: 1_000 })])).toBe(false);
    expect(readPlaybackProgress("v1").positionSec).toBe(300);
    expect(localStorage.getItem(atKey("v1"))).toBe("1000");

    expect(mergePlaybackProgress([row({ video_id: "v1", position_ms: 90_000, updated_at: 1_001 })])).toBe(true);
    expect(readPlaybackProgress("v1").positionSec).toBe(90);
  });

  it("库里没有时长时不抹掉本地时长", () => {
    localStorage.setItem(durKey("v1"), "600");
    mergePlaybackProgress([row({ video_id: "v1", duration_ms: null })]);
    expect(readPlaybackProgress("v1").durationSec).toBe(600);
  });

  it("别的设备上最近看的视频成为这门课的「继续学习」", () => {
    localStorage.setItem(lastVideoKey("c1"), "v1");
    localStorage.setItem(posKey("v1"), "30");
    localStorage.setItem(atKey("v1"), "500");
    mergePlaybackProgress([
      row({ video_id: "v2", updated_at: 800 }),
      row({ video_id: "v3", updated_at: 900 }),
    ]);
    expect(readLastVideoId("c1")).toBe("v3");
  });

  it("本机最近看的更新时，「继续学习」不被同步来的旧记录抢走", () => {
    localStorage.setItem(lastVideoKey("c1"), "v1");
    localStorage.setItem(posKey("v1"), "30");
    localStorage.setItem(atKey("v1"), "5000");
    mergePlaybackProgress([row({ video_id: "v2", updated_at: 900 })]);
    expect(readLastVideoId("c1")).toBe("v1");
  });

  it("本地写入带上时刻，并且本地存储写满时不抛错", () => {
    vi.spyOn(Date, "now").mockReturnValue(42);
    writePlaybackPosition("v1", 12);
    expect(localStorage.getItem(posKey("v1"))).toBe("12");
    expect(localStorage.getItem(atKey("v1"))).toBe("42");

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(() => writePlaybackPosition("v1", 13)).not.toThrow();
  });

  it("回填改动了东西才通知视图重渲染；查库失败静默", async () => {
    const list = vi.mocked(ipc.stats.videoProgress);
    const before = usePlaybackRevision.getState().revision;

    list.mockResolvedValueOnce([row({ video_id: "v1" })]);
    await expect(hydratePlaybackProgress()).resolves.toBe(true);
    expect(usePlaybackRevision.getState().revision).toBe(before + 1);

    list.mockResolvedValueOnce([row({ video_id: "v1" })]);
    await expect(hydratePlaybackProgress()).resolves.toBe(false);
    expect(usePlaybackRevision.getState().revision).toBe(before + 1);

    list.mockRejectedValueOnce(new Error("ipc down"));
    await expect(hydratePlaybackProgress()).resolves.toBe(false);
  });
});
