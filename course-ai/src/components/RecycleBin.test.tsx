import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecycleBin } from "./RecycleBin";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    trash: {
      list: vi.fn(),
      purgeAll: vi.fn(),
    },
    videos: {
      restore: vi.fn(),
      purge: vi.fn(),
    },
  },
}));
const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: confirmMock }));

const trashedVideo = (id: string) => ({
  id,
  title: `${id}.mp4`,
  course_id: "course-1",
  course_name: "申论课程",
  deleted_at: Date.now(),
  expires_at: Date.now() + 30 * 86_400_000,
});

function renderBin() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <RecycleBin onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

describe("RecycleBin 清空回收站", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIpc.trash.purgeAll.mockResolvedValue(2);
  });

  it("purges everything after the user confirms", async () => {
    mockIpc.trash.list.mockResolvedValue([trashedVideo("v1"), trashedVideo("v2")]);
    confirmMock.mockResolvedValue(true);
    renderBin();

    fireEvent.click(await screen.findByRole("button", { name: "清空回收站" }));

    await waitFor(() => expect(mockIpc.trash.purgeAll).toHaveBeenCalled());
    // 确认文案必须提示数量与不可撤销。
    expect(confirmMock.mock.calls[0][0]).toContain("2 个视频");
  });

  it("does nothing when the user cancels", async () => {
    mockIpc.trash.list.mockResolvedValue([trashedVideo("v1")]);
    confirmMock.mockResolvedValue(false);
    renderBin();

    fireEvent.click(await screen.findByRole("button", { name: "清空回收站" }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(mockIpc.trash.purgeAll).not.toHaveBeenCalled();
  });

  it("hides the button when the bin is empty", async () => {
    mockIpc.trash.list.mockResolvedValue([]);
    renderBin();

    expect(await screen.findByText("回收站是空的")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "清空回收站" }),
    ).not.toBeInTheDocument();
  });
});
