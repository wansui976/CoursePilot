import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlaylistImportDialog } from "./PlaylistImportDialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
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

function renderDialog(onStartProcessing = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <PlaylistImportDialog courseId="c1" onClose={vi.fn()} onStartProcessing={onStartProcessing} />
    </QueryClientProvider>,
  );
  return { onStartProcessing };
}

describe("PlaylistImportDialog", () => {
  beforeEach(() => {
    mockIpc.tools.probePlaylist.mockReset();
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
});
