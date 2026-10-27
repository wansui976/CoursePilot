import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/queryKeys";
import type { Video } from "@/lib/types";
import { useJobs } from "@/stores/jobs";
import { useProcessingQueue } from "./useProcessingQueue";

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

  it("drops a failed queue item once the video is no longer active (deleted)", async () => {
    const { result } = renderHook(
      () => useProcessingQueue({ selectedCourseId: "c1" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.queuedVideos).toHaveLength(1));

    // 视频被删除后 active 列表不再返回它，但本地 job 状态仍是 failed。
    await act(async () => {
      useJobs.getState().setOne({
        video_id: video.id,
        job_id: "j1",
        stage: "asr",
        status: "failed",
        progress: 0.2,
        message: "boom",
      });
      client.setQueryData(qk.processingVideos(), []);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.queuedVideos).toHaveLength(0), {
      timeout: 2000,
    });
  });
});
