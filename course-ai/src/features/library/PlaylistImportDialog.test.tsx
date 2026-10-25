import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlaylistImportDialog } from "./PlaylistImportDialog";
import { useDownloads } from "@/stores/downloads";
import type { DownloadJob } from "@/lib/ipc";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    subscriptions: { create: vi.fn() },
    tools: {
      probePlaylist: vi.fn(),
      hasBilibiliCookies: vi.fn(),
      setBilibiliCookies: vi.fn(),
    },
    settings: { get: vi.fn() },
    downloads: { enqueue: vi.fn() },
  },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

function downloadJob(id: string, title: string): DownloadJob {
  return {
    id,
    batchId: "b1",
    courseId: "c1",
    url: `u-${id}`,
    title,
    status: "queued",
    downloaded: 0,
    total: null,
    speed: null,
    eta: null,
    retryHeight: null,
    error: null,
    videoId: null,
    attempt: 0,
  };
}

function renderDialog(onClose = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <PlaylistImportDialog courseId="c1" onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose };
}

describe("PlaylistImportDialog", () => {
  beforeEach(() => {
    mockIpc.tools.probePlaylist.mockReset();
    mockIpc.subscriptions.create.mockReset().mockResolvedValue({ id: "s1" });
    mockIpc.tools.hasBilibiliCookies.mockReset().mockResolvedValue(true);
    mockIpc.settings.get.mockReset().mockResolvedValue(null);
    mockIpc.downloads.enqueue.mockReset();
    mockIpc.downloads.enqueue.mockImplementation(
      (_courseId: string, items: { title?: string }[]) =>
        Promise.resolve(
          items.map((item, index) =>
            downloadJob(`d${index}`, item.title ?? `第 ${index} 讲`),
          ),
        ),
    );
    useDownloads.setState({ byId: {}, order: [] });
  });

  it("enqueues every selected episode as one batch", async () => {
    mockIpc.tools.probePlaylist.mockResolvedValue({
      title: "我的合集",
      episodes: [
        { url: "u1", title: "第一讲", duration_ms: 600000 },
        { url: "u2", title: "第二讲", duration_ms: null },
        { url: "u3", title: "第三讲", duration_ms: null },
      ],
    });

    const { onClose } = renderDialog();

    fireEvent.change(screen.getByLabelText("播放列表链接"), {
      target: { value: "https://b.com/list" },
    });
    fireEvent.click(screen.getByRole("button", { name: "枚举各集" }));

    // 确认步：合集标题 + 3 集，默认全选 → 「导入 3 个」。
    expect(await screen.findByText("我的合集")).toBeInTheDocument();
    expect(screen.getByText("第一讲")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导入 3 个" }));

    // 三集一次性入队；autoProcess 让后端在整批下完后统一开始处理。
    await waitFor(() =>
      expect(mockIpc.downloads.enqueue).toHaveBeenCalledWith("c1", [
        {
          url: "u1",
          title: "第一讲",
          maxHeight: undefined,
          subLang: "ai-zh",
          subtitleAutocorrect: true,
          autoProcess: true,
        },
        {
          url: "u2",
          title: "第二讲",
          maxHeight: undefined,
          subLang: "ai-zh",
          subtitleAutocorrect: true,
          autoProcess: true,
        },
        {
          url: "u3",
          title: "第三讲",
          maxHeight: undefined,
          subLang: "ai-zh",
          subtitleAutocorrect: true,
          autoProcess: true,
        },
      ]),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(useDownloads.getState().order).toEqual(["d0", "d1", "d2"]);
  });

  it("toggles every episode with the 全选 / 全不选 button", async () => {
    mockIpc.tools.probePlaylist.mockResolvedValue({
      title: "合集",
      episodes: [
        { url: "u1", title: "一", duration_ms: null },
        { url: "u2", title: "二", duration_ms: null },
        { url: "u3", title: "三", duration_ms: null },
      ],
    });
    renderDialog();
    fireEvent.change(screen.getByLabelText("播放列表链接"), { target: { value: "u" } });
    fireEvent.click(screen.getByRole("button", { name: "枚举各集" }));
    await screen.findByText("合集");

    // 默认全选。
    expect(screen.getByText("已选 3 / 3")).toBeInTheDocument();

    // 全不选 → 0 选，导入按钮禁用。
    fireEvent.click(screen.getByRole("button", { name: "全不选" }));
    expect(screen.getByText("已选 0 / 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /导入 0 个/ })).toBeDisabled();

    // 再全选 → 恢复。
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    expect(screen.getByText("已选 3 / 3")).toBeInTheDocument();
  });

  it("exposes the quality limit as a keyboard-selectable radio group", async () => {
    mockIpc.tools.probePlaylist.mockResolvedValue({
      title: "合集",
      episodes: [{ url: "u1", title: "第一讲", duration_ms: null }],
    });
    renderDialog();
    fireEvent.change(screen.getByLabelText("播放列表链接"), { target: { value: "u" } });
    fireEvent.click(screen.getByRole("button", { name: "枚举各集" }));

    const qualityGroup = await screen.findByRole("group", { name: "清晰度上限" });
    const best = within(qualityGroup).getByRole("radio", { name: "最高" });
    const quality720 = within(qualityGroup).getByRole("radio", { name: "720P" });
    expect(best).toBeChecked();
    fireEvent.click(quality720);
    expect(quality720).toBeChecked();
  });

  it("only enqueues the episodes that stay selected", async () => {
    mockIpc.tools.probePlaylist.mockResolvedValue({
      title: "合集",
      episodes: [
        { url: "u1", title: "第一讲", duration_ms: null },
        { url: "u2", title: "第二讲", duration_ms: null },
      ],
    });
    renderDialog();

    fireEvent.change(screen.getByLabelText("播放列表链接"), { target: { value: "u" } });
    fireEvent.click(screen.getByRole("button", { name: "枚举各集" }));
    await screen.findByText("合集");

    // 取消勾选第二讲 → 只入队 1 个。
    fireEvent.click(screen.getByText("第二讲"));
    fireEvent.click(screen.getByRole("button", { name: "导入 1 个" }));

    await waitFor(() =>
      expect(mockIpc.downloads.enqueue).toHaveBeenCalledWith("c1", [
        {
          url: "u1",
          title: "第一讲",
          maxHeight: undefined,
          subLang: "ai-zh",
          subtitleAutocorrect: true,
          autoProcess: true,
        },
      ]),
    );
  });

  it("uses modal semantics, focuses the URL field, and closes on an outside pointer", async () => {
    const { onClose } = renderDialog();
    const dialog = screen.getByRole("dialog", {
      name: "导入播放列表 / 合集",
    });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveClass(
      "max-h-[calc(100dvh-2rem)]",
      "w-full",
      "max-w-[460px]",
      "overflow-y-auto",
    );
    expect(screen.getByTestId("playlist-import-overlay")).toHaveClass("p-4");
    expect(screen.getByLabelText("播放列表链接")).toHaveClass(
      "focus:border-[var(--focus-ring)]",
    );
    await waitFor(() =>
      expect(screen.getByLabelText("播放列表链接")).toHaveFocus(),
    );

    fireEvent.pointerDown(screen.getByTestId("playlist-import-overlay"));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("cannot close while the batch is being queued", async () => {
    let finishEnqueue!: (jobs: DownloadJob[]) => void;
    const enqueueing = new Promise<DownloadJob[]>((resolve) => {
      finishEnqueue = resolve;
    });
    mockIpc.tools.probePlaylist.mockResolvedValue({
      title: "合集",
      episodes: [{ url: "u1", title: "第一讲", duration_ms: null }],
    });
    mockIpc.downloads.enqueue.mockReturnValue(enqueueing);
    const { onClose } = renderDialog();

    fireEvent.change(screen.getByLabelText("播放列表链接"), {
      target: { value: "u" },
    });
    fireEvent.click(screen.getByRole("button", { name: "枚举各集" }));
    await screen.findByText("合集");
    fireEvent.click(screen.getByRole("button", { name: "导入 1 个" }));

    expect(await screen.findByRole("button", { name: "入队中…" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerDown(screen.getByTestId("playlist-import-overlay"));
    expect(onClose).not.toHaveBeenCalled();

    finishEnqueue([downloadJob("d1", "第一讲")]);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("announces URL-check failures and offers an in-place retry", async () => {
    mockIpc.tools.hasBilibiliCookies.mockRejectedValue(new Error("cookie check failed"));
    renderDialog();

    fireEvent.change(screen.getByLabelText("播放列表链接"), {
      target: { value: "https://www.bilibili.com/list/1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "枚举各集" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("cookie check failed");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("probes non-Bilibili links without asking for Bilibili cookies", async () => {
    mockIpc.tools.hasBilibiliCookies.mockResolvedValue(false);
    mockIpc.tools.probePlaylist.mockResolvedValue({
      title: "Lecture series",
      episodes: [{ url: "https://www.youtube.com/watch?v=a", title: "Lecture 1", duration_ms: null }],
    });
    renderDialog();

    fireEvent.change(screen.getByLabelText("播放列表链接"), {
      target: { value: "https://www.youtube.com/playlist?list=PL1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "枚举各集" }));

    expect(await screen.findByText("Lecture series")).toBeInTheDocument();
    expect(mockIpc.tools.hasBilibiliCookies).not.toHaveBeenCalled();
  });

  it("can follow a collection without importing the existing episodes", async () => {
    mockIpc.tools.probePlaylist.mockResolvedValue({
      title: "我的合集",
      episodes: [
        { url: "u1", title: "第一讲", duration_ms: null },
        { url: "u2", title: "第二讲", duration_ms: null },
      ],
    });
    const { onClose } = renderDialog();
    fireEvent.change(screen.getByLabelText("播放列表链接"), {
      target: { value: "https://www.bilibili.com/list/1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "枚举各集" }));
    expect(await screen.findByText("我的合集")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "全不选" }));
    fireEvent.click(screen.getByLabelText(/订阅这个合集/));
    fireEvent.click(screen.getByRole("button", { name: "只订阅以后的新视频" }));

    await waitFor(() =>
      expect(mockIpc.subscriptions.create).toHaveBeenCalledWith(
        "c1",
        "https://www.bilibili.com/list/1",
        "我的合集",
        ["u1", "u2"],
      ),
    );
    expect(mockIpc.downloads.enqueue).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  async function openWithSubscription() {
    mockIpc.tools.probePlaylist.mockResolvedValue({
      title: "我的合集",
      episodes: [
        { url: "u1", title: "第一讲", duration_ms: null },
        { url: "u2", title: "第二讲", duration_ms: null },
      ],
    });
    const result = renderDialog();
    fireEvent.change(screen.getByLabelText("播放列表链接"), {
      target: { value: "https://www.bilibili.com/list/1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "枚举各集" }));
    await screen.findByText("我的合集");
    fireEvent.click(screen.getByLabelText(/订阅这个合集/));
    return result;
  }

  it("still queues the episodes when the subscription fails, and a retry only retries the subscription", async () => {
    mockIpc.subscriptions.create.mockRejectedValueOnce(new Error("subscription table locked"));
    const { onClose } = await openWithSubscription();
    const importButton = () => screen.getByRole("button", { name: /^导入/ });

    fireEvent.click(importButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("订阅没有建成");
    expect(mockIpc.downloads.enqueue).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(importButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(mockIpc.subscriptions.create).toHaveBeenCalledTimes(2);
    // 各集已经排过了，重试订阅时不能再排一遍。
    expect(mockIpc.downloads.enqueue).toHaveBeenCalledTimes(1);
  });

  it("does not create a second subscription when only the enqueue has to be retried", async () => {
    mockIpc.downloads.enqueue.mockRejectedValueOnce(new Error("course root missing"));
    const { onClose } = await openWithSubscription();
    const importButton = () => screen.getByRole("button", { name: /^导入/ });

    fireEvent.click(importButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("course root missing");

    fireEvent.click(importButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(mockIpc.subscriptions.create).toHaveBeenCalledTimes(1);
    expect(mockIpc.downloads.enqueue).toHaveBeenCalledTimes(2);
  });
});
