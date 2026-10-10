import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlaylistImportDialog } from "./PlaylistImportDialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    subscriptions: { create: vi.fn() },
    tools: {
      probePlaylist: vi.fn(),
      hasBilibiliCookies: vi.fn(),
      importBilibili: vi.fn(),
      setBilibiliCookies: vi.fn(),
    },
    settings: { get: vi.fn() },
    pipeline: { process: vi.fn() },
  },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

function renderDialog(onStartProcessing = vi.fn(), onClose = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <PlaylistImportDialog courseId="c1" onClose={onClose} onStartProcessing={onStartProcessing} />
    </QueryClientProvider>,
  );
  return { onClose, onStartProcessing };
}

describe("PlaylistImportDialog", () => {
  beforeEach(() => {
    mockIpc.tools.probePlaylist.mockReset();
    mockIpc.subscriptions.create.mockReset().mockResolvedValue({ id: "s1" });
    mockIpc.tools.hasBilibiliCookies.mockReset().mockResolvedValue(true);
    mockIpc.tools.importBilibili.mockReset();
    mockIpc.settings.get.mockReset().mockResolvedValue(null);
    mockIpc.pipeline.process.mockReset();
  });

  it("enumerates episodes then batch-imports, continuing past a failure", async () => {
    mockIpc.tools.probePlaylist.mockResolvedValue({
      title: "我的合集",
      episodes: [
        { url: "u1", title: "第一讲", duration_ms: 600000 },
        { url: "u2", title: "第二讲", duration_ms: null },
        { url: "u3", title: "第三讲", duration_ms: null },
      ],
    });
    mockIpc.tools.importBilibili
      .mockResolvedValueOnce({ id: "v1" })
      .mockRejectedValueOnce(new Error("会员专享"))
      .mockResolvedValueOnce({ id: "v3" });

    const { onStartProcessing } = renderDialog();

    fireEvent.change(screen.getByLabelText("播放列表链接"), {
      target: { value: "https://b.com/list" },
    });
    fireEvent.click(screen.getByRole("button", { name: "枚举各集" }));

    // 确认步：合集标题 + 3 集，默认全选 → 「导入 3 个」。
    expect(await screen.findByText("我的合集")).toBeInTheDocument();
    expect(screen.getByText("第一讲")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导入 3 个" }));

    // 三集都尝试导入；成功的两集进处理流水线。
    await waitFor(() => expect(mockIpc.tools.importBilibili).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(onStartProcessing).toHaveBeenCalledTimes(2));

    // 完成汇总：成功 2、失败 1，并列出失败的那一集。
    expect(await screen.findByText(/成功 2 个，失败 1 个/)).toBeInTheDocument();
    expect(screen.getByText("第二讲")).toBeInTheDocument();
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

  it("lets you deselect episodes before importing", async () => {
    mockIpc.tools.probePlaylist.mockResolvedValue({
      title: "合集",
      episodes: [
        { url: "u1", title: "第一讲", duration_ms: null },
        { url: "u2", title: "第二讲", duration_ms: null },
      ],
    });
    mockIpc.tools.importBilibili.mockResolvedValue({ id: "v1" });
    const { onStartProcessing } = renderDialog();

    fireEvent.change(screen.getByLabelText("播放列表链接"), { target: { value: "u" } });
    fireEvent.click(screen.getByRole("button", { name: "枚举各集" }));
    await screen.findByText("合集");

    // 取消勾选第二讲 → 只导入 1 个。
    fireEvent.click(screen.getByText("第二讲"));
    fireEvent.click(screen.getByRole("button", { name: "导入 1 个" }));

    await waitFor(() => expect(mockIpc.tools.importBilibili).toHaveBeenCalledTimes(1));
    expect(mockIpc.tools.importBilibili).toHaveBeenCalledWith(
      "c1",
      "u1",
      undefined,
      "ai-zh",
      true,
    );
    expect(onStartProcessing).toHaveBeenCalledTimes(1);
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

  it("cannot close with Escape or an outside pointer while importing", async () => {
    let finishImport!: (video: { id: string }) => void;
    const importing = new Promise<{ id: string }>((resolve) => {
      finishImport = resolve;
    });
    mockIpc.tools.probePlaylist.mockResolvedValue({
      title: "合集",
      episodes: [{ url: "u1", title: "第一讲", duration_ms: null }],
    });
    mockIpc.tools.importBilibili.mockReturnValue(importing);
    const { onClose } = renderDialog();

    fireEvent.change(screen.getByLabelText("播放列表链接"), {
      target: { value: "u" },
    });
    fireEvent.click(screen.getByRole("button", { name: "枚举各集" }));
    await screen.findByText("合集");
    fireEvent.click(screen.getByRole("button", { name: "导入 1 个" }));
    await screen.findByText(/正在导入 0 \/ 1/);
    expect(
      screen.getByRole("progressbar", { name: "播放列表导入进度" }),
    ).toHaveAttribute("aria-valuenow", "0");

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerDown(screen.getByTestId("playlist-import-overlay"));
    expect(onClose).not.toHaveBeenCalled();

    finishImport({ id: "v1" });
    const result = await screen.findByText(/导入完成：成功 1 个/);
    expect(result).toHaveAttribute("role", "status");
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
    expect(mockIpc.tools.importBilibili).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
