import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportVideoButton } from "./ImportVideoDialog";

const { addLocalMock, pickPersistedFileMock, isMobileMock } = vi.hoisted(() => ({
  addLocalMock: vi.fn(),
  pickPersistedFileMock: vi.fn(),
  isMobileMock: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  ipc: {
    videos: {
      addLocal: addLocalMock,
    },
  },
}));
vi.mock("@/lib/mobileFiles", () => ({
  pickPersistedFile: pickPersistedFileMock,
  isMobile: isMobileMock,
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
    pickPersistedFileMock.mockReset();
    isMobileMock.mockReturnValue(true);
    addLocalMock.mockResolvedValue(undefined);
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

  it("marks the import trigger as a menu button and toggles aria-expanded", () => {
    renderButton();
    const trigger = screen.getByRole("button", { name: "导入" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
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
