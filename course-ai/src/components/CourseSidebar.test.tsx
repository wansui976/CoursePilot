import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CourseSidebar } from "./CourseSidebar";

const { mockIpc, pickDirectoryPathMock, isIOSMock, confirmMock } = vi.hoisted(() => ({
  mockIpc: {
    courses: {
      list: vi.fn(),
      create: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(),
      relinkRoot: vi.fn(),
    },
  },
  pickDirectoryPathMock: vi.fn(),
  isIOSMock: vi.fn(),
  confirmMock: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/lib/mobileFiles", () => ({
  pickDirectoryPath: pickDirectoryPathMock,
  isIOS: isIOSMock,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), confirm: confirmMock, message: vi.fn() }));

function renderSidebar(overrides: Partial<ComponentProps<typeof CourseSidebar>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <CourseSidebar
        selectedCourseId={null}
        onSelect={() => undefined}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

describe("CourseSidebar", () => {
  beforeEach(() => {
    isIOSMock.mockReturnValue(false);
    mockIpc.courses.list.mockResolvedValue([]);
    mockIpc.courses.create.mockResolvedValue(undefined);
    mockIpc.courses.delete.mockResolvedValue(undefined);
    mockIpc.courses.relinkRoot.mockResolvedValue({
      total: 2,
      relinked: 1,
      ambiguous: [],
      missing: ["b"],
    });
    pickDirectoryPathMock.mockResolvedValue(
      "/data/user/0/dev.courseai.app.debug/courses/新课程",
    );
    confirmMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a default course under app data on Android", async () => {
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "新建课程" }));

    await waitFor(() =>
      expect(pickDirectoryPathMock).toHaveBeenCalledWith(["courses", "新课程"]),
    );
    await waitFor(() =>
      expect(mockIpc.courses.create).toHaveBeenCalledWith(
        "新课程",
        "/data/user/0/dev.courseai.app.debug/courses/新课程",
      ),
    );
  });

  it("creates a default course under app data on iPadOS desktop-class user agents", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "新建课程" }));

    await waitFor(() =>
      expect(mockIpc.courses.create).toHaveBeenCalledWith(
        "新课程",
        "/data/user/0/dev.courseai.app.debug/courses/新课程",
      ),
    );
  });

  it("shows a loading state while creating a course", async () => {
    pickDirectoryPathMock.mockResolvedValueOnce(
      "/data/user/0/dev.courseai.app.debug/courses/新课程",
    );
    mockIpc.courses.create.mockImplementation(
      () => new Promise(() => undefined),
    );

    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "新建课程" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "新建课程" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "新建课程" })).toHaveTextContent("创建中");
  });

  it("relinks a course root through the directory picker", async () => {
    mockIpc.courses.list.mockResolvedValue([{ id: "c1", name: "线性代数" }]);
    pickDirectoryPathMock.mockResolvedValue("/new/root");
    renderSidebar();

    await screen.findByRole("button", { name: "线性代数" });
    fireEvent.click(screen.getByRole("button", { name: "课程操作" }));
    fireEvent.click(screen.getByRole("button", { name: "重新选择根目录" }));

    await waitFor(() =>
      expect(pickDirectoryPathMock).toHaveBeenCalledWith(["courses", "线性代数"]),
    );
    await waitFor(() =>
      expect(mockIpc.courses.relinkRoot).toHaveBeenCalledWith("c1", "/new/root"),
    );
  });

  it("shows the course actions button by default on iPadOS", async () => {
    isIOSMock.mockReturnValue(true);
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    mockIpc.courses.list.mockResolvedValue([{ id: "c1", name: "线性代数" }]);
    renderSidebar();

    await screen.findByRole("button", { name: "线性代数" });
    expect(screen.getByRole("button", { name: "课程操作" })).toHaveClass("opacity-100");
  });

  it("opens the course actions menu after a left swipe on iPadOS", async () => {
    isIOSMock.mockReturnValue(true);
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    mockIpc.courses.list.mockResolvedValue([{ id: "c1", name: "线性代数" }]);
    renderSidebar();

    const course = await screen.findByRole("button", { name: "线性代数" });
    fireEvent.pointerDown(course.parentElement!, { pointerType: "touch", clientX: 200, clientY: 30 });
    fireEvent.pointerMove(course.parentElement!, { pointerType: "touch", clientX: 140, clientY: 36 });
    fireEvent.pointerUp(course.parentElement!, { pointerType: "touch", clientX: 140, clientY: 36 });

    expect(await screen.findByRole("button", { name: "重命名" })).toBeInTheDocument();
  });

  it("clears the selection after deleting the only selected course", async () => {
    const onClearSelection = vi.fn();
    mockIpc.courses.list.mockResolvedValue([{ id: "c1", name: "线性代数" }]);
    renderSidebar({ selectedCourseId: "c1", onClearSelection });

    await screen.findByRole("button", { name: "线性代数" });
    fireEvent.click(screen.getByRole("button", { name: "课程操作" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => expect(mockIpc.courses.delete).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(onClearSelection).toHaveBeenCalledTimes(1));
  });
});
