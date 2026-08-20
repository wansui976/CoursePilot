import "@/i18n";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportVideoButton } from "./ImportVideoDialog";

const {
  addLocalMock,
  scanFolderMock,
  addLocalBatchMock,
  pickPersistedFileMock,
  pickDirectoryPathMock,
  isMobileMock,
} = vi.hoisted(() => ({
  addLocalMock: vi.fn(),
  scanFolderMock: vi.fn(),
  addLocalBatchMock: vi.fn(),
  pickPersistedFileMock: vi.fn(),
  pickDirectoryPathMock: vi.fn(),
  isMobileMock: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  ipc: {
    videos: {
      addLocal: addLocalMock,
      scanFolder: scanFolderMock,
      addLocalBatch: addLocalBatchMock,
    },
  },
}));
vi.mock("@/lib/mobileFiles", () => ({
  pickPersistedFile: pickPersistedFileMock,
  pickDirectoryPath: pickDirectoryPathMock,
}));
// 组件从 @/lib/platform 取 isMobile（不是 mobileFiles）——mock 必须打在这里。
vi.mock("@/lib/platform", () => ({
  isMobile: isMobileMock,
  isDesktop: () => !isMobileMock(),
  isAndroid: () => false,
  isIOS: () => false,
  isTablet: () => false,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

function renderButton() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <ImportVideoButton courseId="course-1" />
    </QueryClientProvider>,
  );
}

describe("ImportVideoButton", () => {
  beforeEach(() => {
    addLocalMock.mockReset();
    scanFolderMock.mockReset();
    addLocalBatchMock.mockReset().mockResolvedValue([]);
    pickPersistedFileMock.mockReset();
    pickDirectoryPathMock.mockReset();
    isMobileMock.mockReturnValue(true);
    addLocalMock.mockResolvedValue(undefined);
  });

  it("scans a picked folder and opens the batch import checklist (desktop)", async () => {
    isMobileMock.mockReturnValue(false);
    pickDirectoryPathMock.mockResolvedValue("/course/folder");
    scanFolderMock.mockResolvedValue([
      { path: "/course/folder/01.mp4", name: "01" },
      { path: "/course/folder/02.mp4", name: "02" },
    ]);

    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    fireEvent.click(screen.getByText("导入整个文件夹").closest("button")!);

    await waitFor(() => expect(scanFolderMock).toHaveBeenCalledWith("/course/folder"));
    // 懒加载的清单对话框出现，默认全选两个。
    expect(await screen.findByText("已选 2 / 2")).toBeInTheDocument();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("hides the folder-import entry on mobile", () => {
    isMobileMock.mockReturnValue(true);
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    expect(screen.queryByText("导入整个文件夹")).not.toBeInTheDocument();
  });

  it("passes the picked video's duration into addLocal", async () => {
    pickPersistedFileMock.mockResolvedValue({
      path: "/tmp/clip.mov",
      durationMs: 12_345,
    });

    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    fireEvent.click(screen.getByText("上传本地视频").closest("button")!);

    await waitFor(() =>
      expect(addLocalMock).toHaveBeenCalledWith("course-1", "/tmp/clip.mov", 12_345),
    );
  });

  it("opens an announced menu and focuses its first item", async () => {
    renderButton();
    const trigger = screen.getByRole("button", { name: "导入" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "导入" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", menu.id);
    await waitFor(() => expect(screen.getAllByRole("menuitem")[0]).toHaveFocus());
  });

  it("supports arrow, Home, End and Escape keyboard navigation", async () => {
    isMobileMock.mockReturnValue(false);
    renderButton();
    const trigger = screen.getByRole("button", { name: "导入" });

    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "导入" });
    const items = screen.getAllByRole("menuitem");
    expect(items.every((item) => item.tabIndex === -1)).toBe(true);
    await waitFor(() => expect(items[0]).toHaveFocus());

    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1], { key: "End" });
    expect(items[items.length - 1]).toHaveFocus();
    fireEvent.keyDown(items[items.length - 1]!, { key: "Home" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: "ArrowUp" });
    expect(items[items.length - 1]).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes on Tab without forcing focus back to the trigger", async () => {
    renderButton();
    const trigger = screen.getByRole("button", { name: "导入" });
    fireEvent.click(trigger);

    const first = screen.getAllByRole("menuitem")[0];
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.keyDown(first, { key: "Tab" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).not.toHaveFocus();
  });

  it("closes on an outside click and restores trigger focus", async () => {
    renderButton();
    const trigger = screen.getByRole("button", { name: "导入" });

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getAllByRole("menuitem")[0]).toHaveFocus());
    fireEvent.click(document.body);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("surfaces an import failure as a themed alert", async () => {
    pickPersistedFileMock.mockResolvedValue({ path: "/tmp/clip.mov", durationMs: 1 });
    addLocalMock.mockRejectedValue(new Error("磁盘已满"));

    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    fireEvent.click(screen.getByText("上传本地视频").closest("button")!);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/导入失败/);
  });
});
