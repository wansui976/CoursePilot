import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/queryKeys";
import type { Video } from "@/lib/types";
import { useJobs } from "@/stores/jobs";
import { GONE_VERIFY_DELAY_MS, useProcessingQueue } from "./useProcessingQueue";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    pipeline: {
      active: vi.fn(),
      jobs: vi.fn(),
      process: vi.fn(),
      cancel: vi.fn(),
      dismiss: vi.fn(),
    },
  },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

const video: Video = {
  id: "v1",
  course_id: "c1",
  title: "第一讲",
  source_type: "local",
  source_uri: null,
  file_path: "/tmp/v1.mp4",
  duration_ms: 1_000,
  width: 1920,
  height: 1080,
  order_index: 0,
  data_dir: "/tmp/v1",
  processed_status: "failed",
  created_at: 1,
};

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useProcessingQueue", () => {
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    useJobs.setState({ byVideo: {} });
    mockIpc.pipeline.active.mockReset().mockResolvedValue([video]);
    mockIpc.pipeline.jobs.mockReset().mockResolvedValue([]);
    mockIpc.pipeline.dismiss.mockReset().mockResolvedValue(undefined);
    mockIpc.pipeline.process.mockReset().mockResolvedValue(undefined);
    mockIpc.pipeline.cancel.mockReset().mockResolvedValue(undefined);
  });

  const fail = (videoId: string) =>
    useJobs.getState().setOne({
      video_id: videoId,
      job_id: `j-${videoId}`,
      stage: "asr",
      status: "failed",
      progress: 0.2,
      message: "boom",
    });

  it("drops a failed queue item once the backend confirms the video is gone (deleted)", async () => {
    const { result } = renderHook(
      () => useProcessingQueue({ selectedCourseId: "c1" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.queuedVideos).toHaveLength(1));

    // 视频被删除后 active 列表不再返回它（后端也确认），但本地 job 状态仍是 failed。
    mockIpc.pipeline.active.mockResolvedValue([]);
    await act(async () => {
      fail(video.id);
      client.setQueryData(qk.processingVideos(), []);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.queuedVideos).toHaveLength(0), {
      timeout: GONE_VERIFY_DELAY_MS + 3000,
    });
  });

  it("keeps a video that just failed even though the cached active list predates it", async () => {
    // 缓存里的 active 列表是开始处理之前拉的，里面没有这个视频；它刚刚处理失败，
    // 后端重新拉一次就会返回它（失败的视频仍在 active 里）。不能当成已删除清掉。
    mockIpc.pipeline.active.mockResolvedValue([]);
    const fresh: Video = { ...video, id: "v2", processed_status: "pending" };
    const { result } = renderHook(
      () => useProcessingQueue({ selectedCourseId: "c1" }),
      { wrapper },
    );
    await waitFor(() => expect(mockIpc.pipeline.active).toHaveBeenCalled());
    const realNow = Date.now;
    act(() => result.current.startProcessing(fresh));
    // 过了「刚开始处理」的 10 秒宽限之后才失败
    vi.spyOn(Date, "now").mockReturnValue(realNow() + 60_000);
    mockIpc.pipeline.active.mockResolvedValue([{ ...fresh, processed_status: "failed" }]);
    await act(async () => {
      fail(fresh.id);
      await Promise.resolve();
    });
    await waitFor(() => expect(mockIpc.pipeline.active.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: GONE_VERIFY_DELAY_MS + 3000,
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(result.current.queuedVideos.map((item) => item.id)).toContain(fresh.id);
    vi.restoreAllMocks();
  });

  it("treats removing an item whose video row was purged as done", async () => {
    mockIpc.pipeline.dismiss.mockRejectedValue(new Error("not found: video v1"));
    const { result } = renderHook(
      () => useProcessingQueue({ selectedCourseId: "c1" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.queuedVideos).toHaveLength(1));
    act(() => result.current.removeQueuedVideo(video.id));
    await waitFor(() => expect(result.current.queuedVideos).toHaveLength(0));
    expect(result.current.dismissProcessing.isError).toBe(false);
  });

  it("still reports other errors when removing", async () => {
    mockIpc.pipeline.dismiss.mockRejectedValue(new Error("database is locked"));
    const { result } = renderHook(
      () => useProcessingQueue({ selectedCourseId: "c1" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.queuedVideos).toHaveLength(1));
    act(() => result.current.removeQueuedVideo(video.id));
    await waitFor(() => expect(result.current.dismissProcessing.isError).toBe(true));
    expect(result.current.queuedVideos).toHaveLength(1);
  });
});
