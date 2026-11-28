import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { DownloadJob } from "@/lib/ipc";
import { useDownloads } from "@/stores/downloads";
import { ProcessingQueueView } from "./ProcessingQueueView";
import type { ProcessingQueue } from "./useProcessingQueue";

const { mockIpc, calls, pickBilibiliCookies } = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    pickBilibiliCookies: vi.fn(async () => true),
    mockIpc: {
      downloads: {
        cancelAll: vi.fn(async () => {
          calls.push("downloads.cancelAll");
        }),
        cancel: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        retry: vi.fn(async () => {}),
      },
      pipeline: {
        asrReady: vi.fn(async () => true),
        cancel: vi.fn(async () => {}),
        recent: vi.fn(async (): Promise<unknown[]> => []),
      },
      courses: { list: vi.fn(async () => [{ id: "c1", name: "机器学习导论" }]) },
      settings: { get: vi.fn(async (): Promise<string | null> => null) },
    },
  };
});

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
vi.mock("@/lib/bilibiliCookies", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bilibiliCookies")>()),
  pickBilibiliCookies,
}));

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
    subtitle: null,
    subtitleWait: null,
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
    stagePositionFor: () => null,
  } as unknown as ProcessingQueue;
}

describe("ProcessingQueueView", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    calls.length = 0;
    vi.clearAllMocks();
    const job = downloadJob();
    useDownloads.setState({ byId: { [job.id]: job }, order: [job.id] });
  });

  it("语音识别没配好时提示导入的视频不会自动处理，关掉「导入后立刻处理」就不提示", async () => {
    mockIpc.pipeline.asrReady.mockResolvedValueOnce(false);
    const first = render(<ProcessingQueueView queue={fakeQueue()} onBack={vi.fn()} onOpenVideo={vi.fn()} />);
    expect(await screen.findByRole("note")).toHaveTextContent("语音识别还没配好");
    first.unmount();

    mockIpc.pipeline.asrReady.mockResolvedValueOnce(false);
    mockIpc.settings.get.mockResolvedValueOnce("false");
    render(<ProcessingQueueView queue={fakeQueue()} onBack={vi.fn()} onOpenVideo={vi.fn()} />);
    await waitFor(() => expect(mockIpc.settings.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
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

  it("lists recently finished videos under the queue and opens one on click", async () => {
    useDownloads.setState({ byId: {}, order: [] });
    const finished = {
      id: "v9",
      course_id: "c1",
      title: "03 梯度下降的直觉",
      finished_at: Date.now() - 6 * 60_000,
    };
    mockIpc.pipeline.recent.mockResolvedValueOnce([finished]);
    const onOpenVideo = vi.fn();
    render(<ProcessingQueueView queue={fakeQueue()} onBack={vi.fn()} onOpenVideo={onOpenVideo} />);

    const section = await screen.findByRole("region", { name: "最近完成" });
    expect(section).toHaveTextContent("机器学习导论");
    expect(section).toHaveTextContent("6 分钟前完成");
    // 有最近完成时，空队列不再是一整页的「暂无正在处理的视频」大空状态。
    expect(screen.queryByText(/导入或处理视频后会出现在这里/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /梯度下降的直觉/ }));
    expect(onOpenVideo).toHaveBeenCalledWith(expect.objectContaining({ id: "v9" }));
  });

  function showFailed(job: Partial<DownloadJob>) {
    const failed = downloadJob({ status: "failed", ...job });
    useDownloads.setState({ byId: { [failed.id]: failed }, order: [failed.id] });
    render(<ProcessingQueueView queue={fakeQueue()} onBack={vi.fn()} onOpenVideo={vi.fn()} />);
  }

  it("retries an ordinary failed download from the queue", async () => {
    showFailed({ error: "yt-dlp failed: network unreachable" });

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(mockIpc.downloads.retry).toHaveBeenCalledWith("d1"));
  });

  it("explains an expired Bilibili sign-in and retries after new cookies are imported", async () => {
    showFailed({
      url: "https://www.bilibili.com/video/BV1xx",
      error: "ERROR: [BiliBili] HTTP Error 412: Precondition Failed",
    });

    expect(screen.getByRole("alert")).toHaveTextContent("B 站登录凭证可能已失效");
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新导入 cookies 并重试" }));

    await waitFor(() => expect(mockIpc.downloads.retry).toHaveBeenCalledWith("d1"));
    expect(pickBilibiliCookies).toHaveBeenCalledTimes(1);
  });

  it("offers new cookies when Bilibili returns its sign-in wall instead of the video page", async () => {
    showFailed({
      url: "https://www.bilibili.com/video/BV1uv411q7Mv",
      error: "yt-dlp failed: ERROR: [BiliBili] 1uv411q7Mv: Unable to extract initial state",
    });

    expect(screen.getByRole("button", { name: "重新导入 cookies 并重试" })).toBeInTheDocument();
  });

  it("does not retry when the cookie file picker is dismissed", async () => {
    pickBilibiliCookies.mockResolvedValueOnce(false);
    showFailed({ url: "https://b23.tv/abc", error: "HTTP Error 412" });

    fireEvent.click(screen.getByRole("button", { name: "重新导入 cookies 并重试" }));

    await waitFor(() => expect(pickBilibiliCookies).toHaveBeenCalled());
    expect(mockIpc.downloads.retry).not.toHaveBeenCalled();
  });

  it("把处理和下载分成两个有标题的小节，处理中写出走到第几步", async () => {
    const video = {
      id: "v7",
      course_id: "c1",
      title: "07 反向传播推导.mp4",
    } as unknown as import("@/lib/types").Video;
    const queue = {
      ...fakeQueue(),
      queuedVideos: [video],
      activeJobFor: () => ({ stage: "asr", status: "running", progress: 0.4, message: null }),
      pipelineProgressFor: () => 0.25,
      stagePositionFor: () => ({ index: 3, total: 10 }),
    } as unknown as ProcessingQueue;
    useDownloads.setState({
      byId: { d1: downloadJob({ title: "10 强化学习入门.mp4" }) },
      order: ["d1"],
    });
    render(<ProcessingQueueView queue={queue} onBack={vi.fn()} onOpenVideo={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "正在处理" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "正在下载" })).toBeInTheDocument();
    expect(screen.getByText(/第 3 步，共 10 步/)).toBeInTheDocument();
    // 下载标题和课程里一样去掉扩展名；两种取消都叫「取消」，读屏能听出取消的是哪一个。
    expect(screen.getByText("10 强化学习入门")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消下载「10 强化学习入门」" }));
    expect(mockIpc.downloads.cancel).toHaveBeenCalledWith("d1");
    fireEvent.click(screen.getByRole("button", { name: "取消处理「07 反向传播推导」" }));
    expect(mockIpc.pipeline.cancel).toHaveBeenCalledWith("v7");
  });

  it("只登记了一个阶段时不写「第 1 步，共 1 步」", () => {
    const queue = {
      ...fakeQueue(),
      queuedVideos: [{ id: "v7", course_id: "c1", title: "07" }],
      activeJobFor: () => ({ stage: "asr", status: "running", progress: 0.4, message: null }),
      stagePositionFor: () => ({ index: 1, total: 1 }),
    } as unknown as ProcessingQueue;
    render(<ProcessingQueueView queue={queue} onBack={vi.fn()} onOpenVideo={vi.fn()} />);
    expect(screen.queryByText(/第 1 步/)).toBeNull();
  });
});
