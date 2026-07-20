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
// 缩略图走 IPC 拉字节，单测里替换为空占位。
vi.mock("./VideoCover", () => ({
  VideoCover: () => <div data-testid="cover" />,
}));

function trashedVideo(
  id: string,
  courseName: string,
  daysLeft: number,
  durationMs: number | null = 90_000,
) {
  return {
    id,
    title: `${id}.mp4`,
    course_id: `course-${courseName}`,
    course_name: courseName,
    duration_ms: durationMs,
    deleted_at: Date.now(),
    expires_at: Date.now() + daysLeft * 86_400_000,
  };
}

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

describe("RecycleBin 分组与批量操作", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIpc.trash.purgeAll.mockResolvedValue(2);
    mockIpc.videos.restore.mockResolvedValue(undefined);
    mockIpc.videos.purge.mockResolvedValue(undefined);
  });

  it("groups items by course with a count in the header", async () => {
    mockIpc.trash.list.mockResolvedValue([
      trashedVideo("v1", "申论", 26),
      trashedVideo("v2", "申论", 26),
      trashedVideo("v3", "数学", 12),
    ]);
    renderBin();

    expect(await screen.findByText("申论 (2)")).toBeInTheDocument();
    expect(screen.getByText("数学 (1)")).toBeInTheDocument();
    // 时长展示在行内。
    expect(screen.getAllByText("01:30").length).toBe(3);
  });

  it("group checkbox selects the whole group and shows the action bar", async () => {
    mockIpc.trash.list.mockResolvedValue([
      trashedVideo("v1", "申论", 26),
      trashedVideo("v2", "申论", 26),
      trashedVideo("v3", "数学", 12),
    ]);
    renderBin();

    fireEvent.click(await screen.findByRole("checkbox", { name: "选择 申论 全部" }));

    expect(screen.getByRole("checkbox", { name: "选择 v1.mp4" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "选择 v2.mp4" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "选择 v3.mp4" })).not.toBeChecked();
    expect(screen.getByText("已选 2 项")).toBeInTheDocument();

    // 取消其中一项 → 组头变半选。
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 v2.mp4" }));
    const groupBox = screen.getByRole("checkbox", {
      name: "选择 申论 全部",
    }) as HTMLInputElement;
    expect(groupBox.indeterminate).toBe(true);
  });

  it("batch restore calls restore per selected id without confirmation", async () => {
    mockIpc.trash.list.mockResolvedValue([
      trashedVideo("v1", "申论", 26),
      trashedVideo("v2", "申论", 26),
    ]);
    renderBin();

    fireEvent.click(await screen.findByRole("checkbox", { name: "选择 申论 全部" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复所选" }));

    await waitFor(() => expect(mockIpc.videos.restore).toHaveBeenCalledTimes(2));
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("batch purge confirms with the count before deleting", async () => {
    mockIpc.trash.list.mockResolvedValue([
      trashedVideo("v1", "申论", 26),
      trashedVideo("v2", "申论", 26),
    ]);
    confirmMock.mockResolvedValue(true);
    renderBin();

    fireEvent.click(await screen.findByRole("checkbox", { name: "选择 申论 全部" }));
    fireEvent.click(screen.getByRole("button", { name: "彻底删除所选" }));

    await waitFor(() => expect(mockIpc.videos.purge).toHaveBeenCalledTimes(2));
    expect(confirmMock.mock.calls[0][0]).toContain("2 个视频");
  });

  it("batch purge does nothing when the user cancels", async () => {
    mockIpc.trash.list.mockResolvedValue([trashedVideo("v1", "申论", 26)]);
    confirmMock.mockResolvedValue(false);
    renderBin();

    fireEvent.click(await screen.findByRole("checkbox", { name: "选择 v1.mp4" }));
    fireEvent.click(screen.getByRole("button", { name: "彻底删除所选" }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(mockIpc.videos.purge).not.toHaveBeenCalled();
  });

  it("refreshes after a partially failed batch purge", async () => {
    const items = [
      trashedVideo("v1", "申论", 26),
      trashedVideo("v2", "申论", 26),
    ];
    mockIpc.trash.list
      .mockResolvedValueOnce(items)
      .mockResolvedValueOnce([items[1]]);
    mockIpc.videos.purge
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("purge failed"));
    confirmMock.mockResolvedValue(true);
    renderBin();

    fireEvent.click(await screen.findByRole("checkbox", { name: "选择 申论 全部" }));
    fireEvent.click(screen.getByRole("button", { name: "彻底删除所选" }));

    await waitFor(() => expect(mockIpc.trash.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("checkbox", { name: "选择 v1.mp4" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "选择 v2.mp4" })).toBeInTheDocument();
  });

  it("highlights items expiring within 3 days", async () => {
    mockIpc.trash.list.mockResolvedValue([
      trashedVideo("v1", "申论", 2),
      trashedVideo("v2", "申论", 26),
    ]);
    renderBin();

    const urgent = await screen.findByText("剩余 2 天");
    expect(urgent.className).toContain("status-err");
    expect(screen.getByText("剩余 26 天").className).not.toContain("status-err");
  });
});

describe("RecycleBin 清空回收站", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIpc.trash.purgeAll.mockResolvedValue(2);
  });

  it("purges everything after the user confirms", async () => {
    mockIpc.trash.list.mockResolvedValue([
      trashedVideo("v1", "申论", 26),
      trashedVideo("v2", "申论", 26),
    ]);
    confirmMock.mockResolvedValue(true);
    renderBin();

    fireEvent.click(await screen.findByRole("button", { name: "清空回收站" }));

    await waitFor(() => expect(mockIpc.trash.purgeAll).toHaveBeenCalled());
    expect(confirmMock.mock.calls[0][0]).toContain("2 个视频");
  });

  it("hides the button and shows the empty hint when the bin is empty", async () => {
    mockIpc.trash.list.mockResolvedValue([]);
    renderBin();

    expect(await screen.findByText("回收站是空的")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "清空回收站" }),
    ).not.toBeInTheDocument();
  });
});
