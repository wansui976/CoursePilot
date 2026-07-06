import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BilibiliImportDialog } from "./BilibiliImportDialog";

const { mockTools } = vi.hoisted(() => ({
  mockTools: {
    hasBilibiliCookies: vi.fn(),
    probeBilibili: vi.fn(),
    setBilibiliCookies: vi.fn(),
    importBilibili: vi.fn(),
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { tools: mockTools, settings: {} } }));

function renderDialog() {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <BilibiliImportDialog courseId="c1" onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe("BilibiliImportDialog", () => {
  beforeEach(() => {
    mockTools.hasBilibiliCookies.mockReset();
    mockTools.probeBilibili.mockReset();
    mockTools.setBilibiliCookies.mockReset();
    mockTools.importBilibili.mockReset();
  });

  it("starts at the URL step", () => {
    mockTools.hasBilibiliCookies.mockResolvedValue(true);
    renderDialog();
    expect(screen.getByLabelText("视频链接")).toBeTruthy();
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

    // 412 多为登录态失效：回到 cookie 步骤引导重新导出导入。
    expect(await screen.findByText(/HTTP 412/)).toBeInTheDocument();
    expect(screen.getByText("选择 cookies.txt")).toBeInTheDocument();
  });
});
