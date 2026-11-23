import "@testing-library/jest-dom/vitest";
import i18n from "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CABLE_POLL_MS, CableImportDialog } from "./CableImportDialog";

const { mockFiles, mockIpc } = vi.hoisted(() => ({
  mockFiles: {
    isAndroid: vi.fn(() => false),
    listCableFiles: vi.fn(),
    takeCableFile: vi.fn(),
    returnCableFile: vi.fn(),
  },
  mockIpc: { videos: { addLocal: vi.fn() } },
}));
vi.mock("@/lib/mobileFiles", () => mockFiles);
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

const MB = 1024 * 1024;
const file = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  path: `/cable/${name}`,
  size: 300 * MB,
  ...extra,
});

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <CableImportDialog courseId="c1" onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose };
}

describe("CableImportDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    mockFiles.isAndroid.mockReset().mockReturnValue(false);
    mockFiles.listCableFiles.mockReset();
    mockFiles.takeCableFile.mockReset();
    mockFiles.returnCableFile.mockReset();
    mockIpc.videos.addLocal.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("勾上拷完的文件，还在拷的显示「正在拷贝」且不能勾", async () => {
    mockFiles.listCableFiles.mockResolvedValue({
      files: [file("01 导论.mp4"), file("02 梯度.mp4", { settling: true })],
      scanned: 2,
    });
    renderDialog();
    const ready = await screen.findByRole("checkbox", { name: "选择 01 导论.mp4" });
    const copying = screen.getByRole("checkbox", { name: "选择 02 梯度.mp4" });
    expect(ready).toBeChecked();
    expect(copying).not.toBeChecked();
    expect(copying).toBeDisabled();
    expect(screen.getByText("正在拷贝…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入 (1)" })).toBeEnabled();
  });

  it("定时重新列文件夹：取消勾选的不会被勾回来，新拷进来的默认勾上", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFiles.listCableFiles.mockResolvedValue({ files: [file("01 导论.mp4")], scanned: 1 });
    renderDialog();
    const first = await screen.findByRole("checkbox", { name: "选择 01 导论.mp4" });
    fireEvent.click(first);
    expect(first).not.toBeChecked();

    mockFiles.listCableFiles.mockResolvedValue({
      files: [file("01 导论.mp4"), file("02 梯度.mp4")],
      scanned: 2,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CABLE_POLL_MS);
    });
    expect(await screen.findByRole("checkbox", { name: "选择 02 梯度.mp4" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "选择 01 导论.mp4" })).not.toBeChecked();
  });

  it("加进课程失败时把文件放回原文件夹，并告诉用户", async () => {
    mockFiles.listCableFiles.mockResolvedValue({ files: [file("01 导论.mp4")], scanned: 1 });
    mockFiles.takeCableFile.mockResolvedValue({ path: "/library/01 导论.mp4", durationMs: 1000 });
    mockFiles.returnCableFile.mockResolvedValue("/cable/01 导论.mp4");
    mockIpc.videos.addLocal.mockRejectedValue(new Error("database is locked"));
    const { onClose } = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "导入 (1)" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("有 1 个视频没导入");
    expect(alert).toHaveTextContent("文件已放回原来的文件夹");
    expect(mockFiles.returnCableFile).toHaveBeenCalledWith("/library/01 导论.mp4");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("全部导入成功就关掉对话框", async () => {
    mockFiles.listCableFiles.mockResolvedValue({ files: [file("01 导论.mp4")], scanned: 1 });
    mockFiles.takeCableFile.mockResolvedValue({ path: "/library/01 导论.mp4", durationMs: 1000 });
    const { onClose } = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "导入 (1)" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockIpc.videos.addLocal).toHaveBeenCalledWith("c1", "/library/01 导论.mp4", 1000);
    expect(mockFiles.returnCableFile).not.toHaveBeenCalled();
  });

  it("Android 上给出「导入」文件夹的路径和 USB 文件传输的说明", async () => {
    mockFiles.isAndroid.mockReturnValue(true);
    mockFiles.listCableFiles.mockResolvedValue({
      files: [],
      scanned: 0,
      folder: "Android/media/dev.courseai.app/导入",
    });
    renderDialog();
    expect(
      await screen.findByText("内部存储 › Android › media › dev.courseai.app › 导入"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Windows：打开「此电脑」/)).toBeInTheDocument();
    expect(screen.getByText(/「导入」文件夹里还没看到文件/)).toBeInTheDocument();
  });
});
