import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/queryKeys";
import type { Video } from "@/lib/types";
import { useJobs } from "@/stores/jobs";
import { DONE_LINGER_MS, GONE_VERIFY_DELAY_MS, useProcessingQueue } from "./useProcessingQueue";

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

  const finish = (videoId: string) =>
    useJobs.getState().setOne({
      video_id: videoId,
      job_id: `j-${videoId}`,
      stage: "mindmap",
      status: "done",
      progress: 1,
      message: null,
    });

  it("drops a finished video for good even though the cached active list still has it", async () => {
    // active 列表是处理中拉的（启动、切回窗口都会拉），里面还带着这个视频；
    // 移出队列后不能又被「恢复」逻辑加回来，一直停在 100%。
    const { result } = renderHook(
      () => useProcessingQueue({ selectedCourseId: "c1" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.queuedVideos).toHaveLength(1));
    act(() => finish(video.id));
    await waitFor(() => expect(result.current.queuedVideos).toHaveLength(0), {
      timeout: DONE_LINGER_MS + 1000,
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, DONE_LINGER_MS + 300)));
    expect(result.current.queuedVideos).toHaveLength(0);
  });

  it("drops a finished video while another video keeps reporting progress", async () => {
    // 这个视频是本机刚点「开始处理」的，不在缓存的 active 列表里，只考计时器。
    const other: Video = { ...video, id: "v2", processed_status: "processing" };
    mockIpc.pipeline.active.mockResolvedValue([other]);
    const { result } = renderHook(
      () => useProcessingQueue({ selectedCourseId: "c1" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.queuedVideos).toHaveLength(1));
    act(() => result.current.startProcessing(video));
    expect(result.current.queuedVideos).toHaveLength(2);
    // 同时处理两个视频时，另一个的进度事件比「停留 1.2 秒」来得勤。
    let progress = 0;
    const ticker = setInterval(() => {
      progress += 0.01;
      useJobs.getState().setOne({
        video_id: other.id,
        job_id: `j-${other.id}`,
        stage: "asr",
        status: "running",
        progress,
        message: null,
      });
    }, 200);
    try {
      act(() => finish(video.id));
      await waitFor(
        () => expect(result.current.queuedVideos.map((item) => item.id)).toEqual([other.id]),
        { timeout: DONE_LINGER_MS + 1500 },
      );
    } finally {
      clearInterval(ticker);
    }
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
