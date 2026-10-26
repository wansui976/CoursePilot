import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BilibiliImportDialog } from "./BilibiliImportDialog";
import { useDownloads } from "@/stores/downloads";
import type { DownloadJob } from "@/lib/ipc";

const { mockTools, mockSettings, mockDownloads } = vi.hoisted(() => ({
  mockTools: {
    hasBilibiliCookies: vi.fn(),
    probeBilibili: vi.fn(),
    setBilibiliCookies: vi.fn(),
  },
  mockSettings: { get: vi.fn() },
  mockDownloads: { enqueue: vi.fn() },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/ipc", () => ({
  ipc: { tools: mockTools, settings: mockSettings, downloads: mockDownloads },
}));

function downloadJob(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: "d1",
    batchId: "b1",
    courseId: "c1",
    url: "https://b23.tv/abc",
    title: "示例视频",
    status: "queued",
    downloaded: 0,
    total: null,
    speed: null,
    eta: null,
    retryHeight: null,
    error: null,
    videoId: null,
    attempt: 0,
    ...overrides,
  };
}

function renderDialog(onClose: () => void = () => {}) {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <BilibiliImportDialog courseId="c1" onClose={onClose} />
    </QueryClientProvider>,
  );
}

describe("BilibiliImportDialog", () => {
  beforeEach(() => {
    mockTools.hasBilibiliCookies.mockReset();
    mockTools.probeBilibili.mockReset();
    mockTools.setBilibiliCookies.mockReset();
    mockSettings.get.mockReset();
    mockDownloads.enqueue.mockReset();
    mockSettings.get.mockResolvedValue(null);
    mockDownloads.enqueue.mockResolvedValue([downloadJob()]);
    useDownloads.setState({ byId: {}, order: [] });
  });

  it("starts at the URL step", () => {
    mockTools.hasBilibiliCookies.mockResolvedValue(true);
    renderDialog();
    expect(screen.getByLabelText("视频链接")).toHaveClass(
      "focus:border-[var(--focus-ring)]",
    );
    expect(screen.getByText("下一步")).toBeTruthy();
  });

  it("guides to importing cookies.txt when none is imported", async () => {
    mockTools.hasBilibiliCookies.mockResolvedValue(false);
    renderDialog();

    fireEvent.change(screen.getByLabelText("视频链接"), {
      target: { value: "https://b23.tv/abc" },
    });
    fireEvent.click(screen.getByText("下一步"));

    // 未导入 cookie：引导用户用 Get cookies.txt LOCALLY 扩展导出后导入。
    expect(await screen.findByText(/Get cookies.txt LOCALLY/)).toBeInTheDocument();
    expect(screen.getByText("选择 cookies.txt")).toBeInTheDocument();
    expect(mockTools.probeBilibili).not.toHaveBeenCalled();
  });

  it("probes directly when cookies are already imported", async () => {
    mockTools.hasBilibiliCookies.mockResolvedValue(true);
    mockTools.probeBilibili.mockResolvedValue({
      title: "示例视频",
      qualities: [1080],
      tracks: [],
    });
    renderDialog();

    fireEvent.change(screen.getByLabelText("视频链接"), {
      target: { value: "https://b23.tv/abc" },
    });
    fireEvent.click(screen.getByText("下一步"));

    await waitFor(() =>
      expect(mockTools.probeBilibili).toHaveBeenCalledWith("https://b23.tv/abc"),
    );
    expect(await screen.findByText("示例视频")).toBeInTheDocument();
  });

  it("exposes quality as a labeled radio group and labels the subtitle selector", async () => {
    mockTools.hasBilibiliCookies.mockResolvedValue(true);
    mockTools.probeBilibili.mockResolvedValue({
      title: "示例视频",
      qualities: [1080, 720],
      tracks: [{ lang: "zh-CN", name: "中文", auto: false }],
    });
    renderDialog();

    fireEvent.change(screen.getByLabelText("视频链接"), { target: { value: "https://b23.tv/abc" } });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    const qualityGroup = await screen.findByRole("group", { name: "清晰度" });
    const quality1080 = within(qualityGroup).getByRole("radio", { name: "1080P" });
    const quality720 = within(qualityGroup).getByRole("radio", { name: "720P" });
    expect(quality1080).toBeChecked();
    fireEvent.click(quality720);
    expect(quality720).toBeChecked();
    expect(
      screen.getByRole("combobox", { name: "检测到自带字幕，可以直接用它，省去语音识别" }),
    ).toBeInTheDocument();
  });

  it("shows cookie-check failures instead of leaving an unhandled rejection", async () => {
    mockTools.hasBilibiliCookies.mockRejectedValue(new Error("cookie check failed"));
    renderDialog();

    fireEvent.change(screen.getByLabelText("视频链接"), {
      target: { value: "https://b23.tv/abc" },
    });
    fireEvent.click(screen.getByText("下一步"));

    expect(await screen.findByRole("alert")).toHaveTextContent("cookie check failed");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一步" })).toBeEnabled();
    expect(mockTools.probeBilibili).not.toHaveBeenCalled();
  });

  it("shows the AI-correct checkbox for subtitle imports, defaulting from the global setting", async () => {
    mockTools.hasBilibiliCookies.mockResolvedValue(true);
    mockSettings.get.mockResolvedValue("false"); // 全局设置关 → 默认不勾选
    mockTools.probeBilibili.mockResolvedValue({
      title: "示例视频",
      qualities: [1080],
      tracks: [{ lang: "zh-CN", name: "中文（中国）", auto: false }],
    });
    renderDialog();

    fireEvent.change(screen.getByLabelText("视频链接"), {
      target: { value: "https://b23.tv/abc" },
    });
    fireEvent.click(screen.getByText("下一步"));

    const checkbox = await screen.findByRole("checkbox", {
      name: "下载后用 AI 纠错字幕",
    });
    await waitFor(() => expect(checkbox).not.toBeChecked());
    expect(mockSettings.get).toHaveBeenCalledWith("subtitle_autocorrect");
  });

  it("enqueues the chosen quality and subtitle options", async () => {
    mockTools.hasBilibiliCookies.mockResolvedValue(true);
    mockSettings.get.mockResolvedValue(null); // 未设置 → 默认开（与后端一致）
    mockTools.probeBilibili.mockResolvedValue({
      title: "示例视频",
      qualities: [1080],
      tracks: [{ lang: "zh-CN", name: "中文（中国）", auto: false }],
    });
    renderDialog();

    fireEvent.change(screen.getByLabelText("视频链接"), {
      target: { value: "https://b23.tv/abc" },
    });
    fireEvent.click(screen.getByText("下一步"));

    const checkbox = await screen.findByRole("checkbox", {
      name: "下载后用 AI 纠错字幕",
    });
    await waitFor(() => expect(checkbox).toBeChecked());
    fireEvent.click(checkbox); // 用户取消勾选
    fireEvent.click(screen.getByText("用所选字幕下载"));

    await waitFor(() =>
      expect(mockDownloads.enqueue).toHaveBeenCalledWith("c1", [
        {
          url: "https://b23.tv/abc",
          title: "示例视频",
          maxHeight: 1080,
          subLang: "zh-CN",
          subtitleAutocorrect: false,
          autoProcess: true,
        },
      ]),
    );
  });

  it("closes immediately and keeps the job in the download store", async () => {
    const onClose = vi.fn();
    mockTools.hasBilibiliCookies.mockResolvedValue(true);
    mockTools.probeBilibili.mockResolvedValue({
      title: "示例视频",
      qualities: [1080],
      tracks: [],
    });
    mockDownloads.enqueue.mockResolvedValue([
      downloadJob({ status: "downloading", downloaded: 42, total: 100 }),
    ]);
    renderDialog(onClose);

    fireEvent.change(screen.getByLabelText("视频链接"), {
      target: { value: "https://b23.tv/abc" },
    });
    fireEvent.click(screen.getByText("下一步"));
    fireEvent.click(await screen.findByText("下载"));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(useDownloads.getState().byId.d1?.downloaded).toBe(42);
  });

  it("shows a queueing label and stays open while enqueueing", async () => {
    mockTools.hasBilibiliCookies.mockResolvedValue(true);
    mockTools.probeBilibili.mockResolvedValue({
      title: "示例视频",
      qualities: [1080],
      tracks: [],
    });
    // 入队请求一直挂着：按钮显示「入队中…」，弹窗也不可关闭。
    mockDownloads.enqueue.mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    renderDialog(onClose);

    fireEvent.change(screen.getByLabelText("视频链接"), {
      target: { value: "https://b23.tv/abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    await screen.findByText("示例视频");
    fireEvent.click(screen.getByRole("button", { name: "下载" }));

    expect(await screen.findByRole("button", { name: "入队中…" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("omits the subtitle options when the video has no subtitles", async () => {
    mockTools.hasBilibiliCookies.mockResolvedValue(true);
    mockTools.probeBilibili.mockResolvedValue({
      title: "示例视频",
      qualities: [1080],
      tracks: [],
    });
    renderDialog();

    fireEvent.change(screen.getByLabelText("视频链接"), {
      target: { value: "https://b23.tv/abc" },
    });
    fireEvent.click(screen.getByText("下一步"));

    await screen.findByText("示例视频");
    expect(
      screen.queryByRole("checkbox", { name: "下载后用 AI 纠错字幕" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("下载"));
    await waitFor(() =>
      expect(mockDownloads.enqueue).toHaveBeenCalledWith("c1", [
        {
          url: "https://b23.tv/abc",
          title: "示例视频",
          maxHeight: 1080,
          subLang: undefined,
          subtitleAutocorrect: undefined,
          autoProcess: false,
        },
      ]),
    );
  });

  it("routes an HTTP 412 probe failure back to cookie re-import", async () => {
    mockTools.hasBilibiliCookies.mockResolvedValue(true);
    mockTools.probeBilibili.mockRejectedValue(
      "yt-dlp failed: HTTP Error 412: Precondition Failed",
    );
    renderDialog();

    fireEvent.change(screen.getByLabelText("视频链接"), {
      target: { value: "https://b23.tv/abc" },
    });
    fireEvent.click(screen.getByText("下一步"));

    // 412 多为登录态失效：回到 cookie 步骤引导重新导出导入，
    // 并把原始报错映射成人话（而不是原样抛 yt-dlp 英文）。
    expect(
      await screen.findByText(/服务器拒绝了请求（HTTP 412）/),
    ).toBeInTheDocument();
    expect(screen.getByText("选择 cookies.txt")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("exposes modal dialog semantics labelled by its title", () => {
    mockTools.hasBilibiliCookies.mockResolvedValue(true);
    renderDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("下载网络视频");
    expect(dialog).toHaveClass(
      "max-h-[calc(100dvh-2rem)]",
      "w-full",
      "max-w-[420px]",
      "overflow-y-auto",
    );
    expect(screen.getByTestId("bilibili-import-overlay")).toHaveClass("p-4");
  });

  it("closes on Escape", () => {
    mockTools.hasBilibiliCookies.mockResolvedValue(true);
    const onClose = vi.fn();
    renderDialog(onClose);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });

  it("focuses the URL field and keeps Tab focus inside the dialog", async () => {
    mockTools.hasBilibiliCookies.mockResolvedValue(true);
    renderDialog();

    const input = screen.getByLabelText("视频链接");
    await waitFor(() => expect(input).toHaveFocus());

    const lastButton = screen.getByRole("button", { name: "下一步" });
    lastButton.focus();
    fireEvent.keyDown(lastButton, { key: "Tab" });

    expect(input).toHaveFocus();
  });
});
