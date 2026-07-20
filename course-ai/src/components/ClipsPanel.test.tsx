import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClipsPanel } from "./ClipsPanel";

const { mockIpc, player, confirmMock } = vi.hoisted(() => ({
  mockIpc: {
    clips: {
      list: vi.fn(),
      add: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
  player: { currentMs: 0, requestSeek: vi.fn() },
  confirmMock: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: confirmMock }));
vi.mock("@/stores/player", () => {
  const usePlayer = (selector: (s: typeof player) => unknown) => selector(player);
  usePlayer.getState = () => player;
  return { usePlayer };
});

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui = (videoId: string) => (
    <QueryClientProvider client={queryClient}>
      <ClipsPanel videoId={videoId} />
    </QueryClientProvider>
  );
  const view = render(ui("video-1"));
  // 模拟 TabsPanel 保活下的换视频：同一实例仅 prop 变化，不重挂。
  const switchVideo = (videoId: string) => view.rerender(ui(videoId));
  return { ...view, switchVideo };
}

describe("ClipsPanel", () => {
  beforeEach(() => {
    mockIpc.clips.list.mockReset().mockResolvedValue([]);
    mockIpc.clips.add.mockReset().mockResolvedValue({
      id: 1,
      video_id: "video-1",
      start_ms: 5000,
      end_ms: 8000,
      note: "",
      created_at: 0,
    });
    mockIpc.clips.update.mockReset().mockResolvedValue(undefined);
    mockIpc.clips.delete.mockReset().mockResolvedValue(undefined);
    player.currentMs = 0;
    player.requestSeek.mockReset();
    confirmMock.mockReset().mockResolvedValue(true);
  });

  it("captures a clip from two playhead clicks", async () => {
    renderPanel();
    player.currentMs = 5000;
    fireEvent.click(await screen.findByRole("button", { name: "标记起点" }));
    player.currentMs = 8000;
    fireEvent.click(await screen.findByRole("button", { name: /标记终点/ }));
    await waitFor(() =>
      expect(mockIpc.clips.add).toHaveBeenCalledWith("video-1", 5000, 8000, ""),
    );
  });

  it("discards the pending start mark when switching videos", async () => {
    const { switchVideo } = renderPanel();
    player.currentMs = 5000;
    fireEvent.click(await screen.findByRole("button", { name: "标记起点" }));

    switchVideo("video-2");

    // 起点标记属于 video-1：在新视频里按钮回到「标记起点」，不会拼出跨视频片段。
    const button = await screen.findByRole("button", { name: "标记起点" });
    player.currentMs = 8000;
    fireEvent.click(button);
    expect(mockIpc.clips.add).not.toHaveBeenCalled();
  });

  it("jumps to a clip's start via requestSeek", async () => {
    mockIpc.clips.list.mockResolvedValue([
      { id: 1, video_id: "video-1", start_ms: 5000, end_ms: 8000, note: "", created_at: 0 },
    ]);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "跳转" }));
    expect(player.requestSeek).toHaveBeenCalledWith(5000);
  });

  it("deletes a clip after confirmation", async () => {
    mockIpc.clips.list.mockResolvedValue([
      { id: 7, video_id: "video-1", start_ms: 1000, end_ms: 2000, note: "", created_at: 0 },
    ]);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "删除片段" }));
    await waitFor(() => expect(mockIpc.clips.delete).toHaveBeenCalledWith(7));
    // 片段没有回收站兜底：删除必须先确认。
    expect(confirmMock).toHaveBeenCalled();
  });

  it("keeps the clip when the delete confirmation is cancelled", async () => {
    confirmMock.mockResolvedValue(false);
    mockIpc.clips.list.mockResolvedValue([
      { id: 7, video_id: "video-1", start_ms: 1000, end_ms: 2000, note: "", created_at: 0 },
    ]);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "删除片段" }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(mockIpc.clips.delete).not.toHaveBeenCalled();
  });

  it("clamps start/end resets so the clip range never inverts", async () => {
    mockIpc.clips.list.mockResolvedValue([
      { id: 7, video_id: "video-1", start_ms: 1000, end_ms: 2000, note: "", created_at: 0 },
    ]);
    renderPanel();

    // 播放头已越过终点时「重设起点」：夹到终点，不产生 start > end 的倒置区间。
    player.currentMs = 5000;
    fireEvent.click(await screen.findByRole("button", { name: "重设起点" }));
    await waitFor(() =>
      expect(mockIpc.clips.update).toHaveBeenCalledWith(7, 2000, 2000, ""),
    );

    // 播放头早于起点时「重设终点」：夹到起点。
    player.currentMs = 200;
    fireEvent.click(screen.getByRole("button", { name: "重设终点" }));
    await waitFor(() =>
      expect(mockIpc.clips.update).toHaveBeenCalledWith(7, 1000, 1000, ""),
    );
  });
});
