import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { Video } from "@/lib/types";
import { LanDownloadBar } from "./LanDownloadBar";

const { mockIpc, listeners } = vi.hoisted(() => ({
  mockIpc: { lanShare: { downloadVideo: vi.fn() } },
  listeners: [] as Array<(event: { payload: unknown }) => void>,
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_name: string, callback: (event: { payload: unknown }) => void) => {
    listeners.push(callback);
    return Promise.resolve(() => {});
  }),
}));

const video = { id: "v1", course_id: "c1", title: "01 概括", file_path: "" } as unknown as Video;

function renderBar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LanDownloadBar video={video} />
    </QueryClientProvider>,
  );
}

describe("LanDownloadBar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    listeners.length = 0;
    mockIpc.lanShare.downloadVideo.mockReset().mockResolvedValue({ ...video, file_path: "/data/v1.mp4" });
  });

  it("点「存到本机」从这个视频开始整段下载", async () => {
    renderBar();
    fireEvent.click(await screen.findByRole("button", { name: "存到本机" }));
    await waitFor(() => expect(mockIpc.lanShare.downloadVideo).toHaveBeenCalledWith("v1"));
  });

  it("下载中显示进度；别的视频的进度不串台", async () => {
    mockIpc.lanShare.downloadVideo.mockReturnValue(new Promise(() => {}));
    renderBar();
    fireEvent.click(await screen.findByRole("button", { name: "存到本机" }));
    await waitFor(() => expect(listeners.length).toBeGreaterThan(0));
    act(() => listeners[0]({ payload: { videoId: "other", downloaded: 10, total: 100, done: false, error: null } }));
    expect(screen.queryByText(/正在存到本机/)).not.toBeInTheDocument();
    act(() => listeners[0]({ payload: { videoId: "v1", downloaded: 50, total: 100, done: false, error: null } }));
    expect(await screen.findByText("正在存到本机 50%")).toBeInTheDocument();
  });
});
