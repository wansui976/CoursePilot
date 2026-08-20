import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderPanel(queryClient = createQueryClient()) {
  const ui = (videoId: string) => (
    <QueryClientProvider client={queryClient}>
      <ClipsPanel videoId={videoId} />
    </QueryClientProvider>
  );
  const view = render(ui("video-1"));
  // 模拟 TabsPanel 保活下的换视频：同一实例仅 prop 变化，不重挂。
  const switchVideo = (videoId: string) => view.rerender(ui(videoId));
  return { ...view, queryClient, switchVideo };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

  it("saves a dirty note before Android system back can leave the workspace", async () => {
    mockIpc.clips.list.mockResolvedValue([
      { id: 7, video_id: "video-1", start_ms: 1000, end_ms: 2000, note: "", created_at: 0 },
    ]);
    renderPanel();

    const input = await screen.findByRole("textbox", { name: "片段备注" });
    expect(input).toHaveClass("focus:border-[var(--focus-ring)]");
    fireEvent.change(input, { target: { value: "重点例题" } });
    expect(screen.getByRole("status")).toHaveTextContent("未保存");
    const layer = input.closest<HTMLElement>("[data-system-back-layer]");
    expect(layer).not.toBeNull();

    fireEvent.keyDown(layer!, { key: "Escape" });

    await waitFor(() =>
      expect(mockIpc.clips.update).toHaveBeenCalledWith(7, 1000, 2000, "重点例题"),
    );
    expect(input).toHaveValue("重点例题");
  });

  it("submits a dirty note when switching videos without waiting for blur", async () => {
    mockIpc.clips.list.mockImplementation((videoId: string) =>
      Promise.resolve(
        videoId === "video-1"
          ? [{ id: 7, video_id: "video-1", start_ms: 1000, end_ms: 2000, note: "", created_at: 0 }]
          : [],
      ),
    );
    const { switchVideo } = renderPanel();

    const input = await screen.findByRole("textbox", { name: "片段备注" });
    fireEvent.change(input, { target: { value: "切换前保存" } });
    switchVideo("video-2");

    await waitFor(() =>
      expect(mockIpc.clips.update).toHaveBeenCalledWith(7, 1000, 2000, "切换前保存"),
    );
    expect(mockIpc.clips.update).toHaveBeenCalledTimes(1);
  });

  it("submits on unmount and restores a failed draft for retry after remount", async () => {
    const firstSave = deferred<void>();
    mockIpc.clips.list.mockResolvedValue([
      { id: 7, video_id: "video-1", start_ms: 1000, end_ms: 2000, note: "", created_at: 0 },
    ]);
    mockIpc.clips.update
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(undefined);
    const queryClient = createQueryClient();
    const first = renderPanel(queryClient);

    const input = await screen.findByRole("textbox", { name: "片段备注" });
    fireEvent.change(input, { target: { value: "卸载也不丢" } });
    first.unmount();

    await waitFor(() =>
      expect(mockIpc.clips.update).toHaveBeenCalledWith(7, 1000, 2000, "卸载也不丢"),
    );
    await act(async () => {
      firstSave.reject(new Error("database locked"));
      await firstSave.promise.catch(() => undefined);
    });

    renderPanel(queryClient);
    const restored = await screen.findByRole("textbox", { name: "片段备注" });
    expect(restored).toHaveValue("卸载也不丢");
    expect(await screen.findByRole("alert")).toHaveTextContent("database locked");

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(mockIpc.clips.update).toHaveBeenCalledTimes(2));
  });

  it("does not duplicate a note write when blur is followed by unmount", async () => {
    const save = deferred<void>();
    mockIpc.clips.list.mockResolvedValue([
      { id: 7, video_id: "video-1", start_ms: 1000, end_ms: 2000, note: "", created_at: 0 },
    ]);
    mockIpc.clips.update.mockReturnValue(save.promise);
    const view = renderPanel();

    const input = await screen.findByRole("textbox", { name: "片段备注" });
    fireEvent.change(input, { target: { value: "只写一次" } });
    fireEvent.blur(input);
    await waitFor(() => expect(mockIpc.clips.update).toHaveBeenCalledTimes(1));
    view.unmount();

    expect(mockIpc.clips.update).toHaveBeenCalledTimes(1);
    await act(async () => {
      save.resolve(undefined);
      await save.promise;
    });
  });

  it("keeps a failed note draft visible and retryable", async () => {
    mockIpc.clips.list.mockResolvedValue([
      { id: 7, video_id: "video-1", start_ms: 1000, end_ms: 2000, note: "", created_at: 0 },
    ]);
    mockIpc.clips.update
      .mockRejectedValueOnce(new Error("database locked"))
      .mockResolvedValueOnce(undefined);
    renderPanel();

    const input = await screen.findByRole("textbox", { name: "片段备注" });
    fireEvent.change(input, { target: { value: "不要丢失" } });
    fireEvent.blur(input);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(input).toHaveValue("不要丢失");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(mockIpc.clips.update).toHaveBeenCalledTimes(2));
  });

  it("shows a retryable read error instead of an empty clip list", async () => {
    mockIpc.clips.list
      .mockRejectedValueOnce(new Error("片段读取失败"))
      .mockResolvedValueOnce([]);

    renderPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent("片段读取失败");
    expect(screen.queryByText(/还没有收藏的片段/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "标记起点" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(mockIpc.clips.list).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/还没有收藏的片段/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "标记起点" })).toBeInTheDocument();
  });
});
