import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClipsPanel } from "./ClipsPanel";

const { mockIpc, player } = vi.hoisted(() => ({
  mockIpc: {
    clips: {
      list: vi.fn(),
      add: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
  player: { currentMs: 0, requestSeek: vi.fn() },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/stores/player", () => {
  const usePlayer = (selector: (s: typeof player) => unknown) => selector(player);
  usePlayer.getState = () => player;
  return { usePlayer };
});

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ClipsPanel videoId="video-1" />
    </QueryClientProvider>,
  );
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

  it("jumps to a clip's start via requestSeek", async () => {
    mockIpc.clips.list.mockResolvedValue([
      { id: 1, video_id: "video-1", start_ms: 5000, end_ms: 8000, note: "", created_at: 0 },
    ]);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "跳转" }));
    expect(player.requestSeek).toHaveBeenCalledWith(5000);
  });

  it("deletes a clip", async () => {
    mockIpc.clips.list.mockResolvedValue([
      { id: 7, video_id: "video-1", start_ms: 1000, end_ms: 2000, note: "", created_at: 0 },
    ]);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "删除片段" }));
    await waitFor(() => expect(mockIpc.clips.delete).toHaveBeenCalledWith(7));
  });
});
