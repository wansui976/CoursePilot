import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { DownloadJob } from "@/lib/ipc";
import { useDownloads } from "@/stores/downloads";
import { ProcessingQueueView } from "./ProcessingQueueView";
import type { ProcessingQueue } from "./useProcessingQueue";

const { mockIpc, calls } = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    mockIpc: {
      downloads: {
        cancelAll: vi.fn(async () => {
          calls.push("downloads.cancelAll");
        }),
        cancel: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
      pipeline: { cancel: vi.fn(async () => {}) },
    },
  };
});

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

function downloadJob(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: "d1",
    batchId: "b1",
    courseId: "c1",
    url: "u1",
    title: "第 7 集",
    status: "downloading",
    downloaded: 10,
    total: 100,
    speed: null,
    eta: null,
    retryHeight: null,
    error: null,
    videoId: null,
    attempt: 1,
    ...overrides,
  };
}

function fakeQueue(): ProcessingQueue {
  return {
    queuedVideos: [],
    jobLoadStateByVideo: {},
    activeProcessingLoading: false,
    activeProcessingError: false,
    activeProcessingErrorObj: null,
    retryActiveProcessing: vi.fn(),
    retryJobsForVideo: vi.fn(),
    startProcessing: vi.fn(),
    dismissProcessing: {
      isError: false,
      isPending: false,
      variables: undefined,
      error: null,
      mutate: vi.fn(),
    },
    removeQueuedVideo: vi.fn(),
    cancelAllProcessing: vi.fn(() => {
      calls.push("queue.cancelAllProcessing");
    }),
    retryFailedAll: vi.fn(),
    activeJobFor: () => undefined,
    pipelineProgressFor: () => 0,
  } as unknown as ProcessingQueue;
}

describe("ProcessingQueueView", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    calls.length = 0;
    const job = downloadJob();
    useDownloads.setState({ byId: { [job.id]: job }, order: [job.id] });
  });

  it("stops the download queue in the backend before canceling running processing", async () => {
    // 逐个取消下载会让整批「结束」、把已下完的视频送去处理；必须先让后端整体取消，
    // 再取消正在跑的处理。
    render(<ProcessingQueueView queue={fakeQueue()} onBack={vi.fn()} onOpenVideo={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /全部取消/ }));

    await waitFor(() =>
      expect(calls).toEqual(["downloads.cancelAll", "queue.cancelAllProcessing"]),
    );
    expect(mockIpc.downloads.cancel).not.toHaveBeenCalled();
  });
});
