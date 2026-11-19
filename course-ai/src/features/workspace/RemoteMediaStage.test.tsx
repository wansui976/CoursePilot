import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { Video } from "@/lib/types";
import { RemoteMediaStage } from "./RemoteMediaStage";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: { remoteSync: { mediaSize: vi.fn(), downloadVideo: vi.fn() } },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const video = { id: "v1", course_id: "c1", title: "01 概括", file_path: "" } as unknown as Video;

function renderStage(props: { lanChecking?: boolean; onRetryLan?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RemoteMediaStage video={video} {...props} />
    </QueryClientProvider>,
  );
}

describe("RemoteMediaStage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    mockIpc.remoteSync.mediaSize.mockReset();
    mockIpc.remoteSync.downloadVideo.mockReset().mockResolvedValue("/data/v1.mp4");
  });

  it("网盘上有文件：给出带大小的下载按钮", async () => {
    mockIpc.remoteSync.mediaSize.mockResolvedValue(700 * 1024 * 1024);
    renderStage();
    fireEvent.click(await screen.findByRole("button", { name: "从网盘下载（700 MB）" }));
    await waitFor(() => expect(mockIpc.remoteSync.downloadVideo).toHaveBeenCalledWith("v1"));
  });

  it("还没传到网盘：说明要去有文件的设备上打开上传，不给下载按钮", async () => {
    mockIpc.remoteSync.mediaSize.mockResolvedValue(null);
    renderStage();
    expect(await screen.findByText(/上传视频文件/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("没连网盘：提示去设置里连上", async () => {
    mockIpc.remoteSync.mediaSize.mockRejectedValue(new Error("还没设置多设备同步"));
    renderStage();
    expect(await screen.findByText(/连上同一个网盘/)).toBeInTheDocument();
  });

  it("局域网里正在找电脑时显示进度，没找到时可以再找一次", async () => {
    mockIpc.remoteSync.mediaSize.mockResolvedValue(null);
    const retry = vi.fn();
    const { rerender } = renderStage({ lanChecking: true, onRetryLan: retry });
    expect(await screen.findByText("正在局域网里找有这个视频的电脑…")).toBeInTheDocument();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <RemoteMediaStage video={video} lanChecking={false} onRetryLan={retry} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "在局域网里再找一次" }));
    expect(retry).toHaveBeenCalled();
  });

  it("网盘「在线看」的视频：只说去连上那个网盘，不再说「从别的设备同步过来」", async () => {
    mockIpc.remoteSync.mediaSize.mockResolvedValue(null);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const drive = { ...video, source_type: "url", source_uri: "http://192.168.1.5:5244/dav/%E8%AF%BE/01.mp4" } as unknown as Video;
    render(
      <QueryClientProvider client={client}>
        <RemoteMediaStage video={drive} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/这台设备还没连上能访问它的网盘/)).toBeInTheDocument();
    expect(screen.queryByText(/从别的设备同步过来/)).not.toBeInTheDocument();
  });
});
