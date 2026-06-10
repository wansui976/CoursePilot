import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CourseSidebar } from "./CourseSidebar";

const { mockIpc, pickDirectoryPathMock } = vi.hoisted(() => ({
  mockIpc: {
    courses: {
      list: vi.fn(),
      create: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(),
    },
  },
  pickDirectoryPathMock: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/lib/mobileFiles", () => ({ pickDirectoryPath: pickDirectoryPathMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), confirm: vi.fn() }));

function renderSidebar(overrides: Partial<ComponentProps<typeof CourseSidebar>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <CourseSidebar
        selectedCourseId={null}
        onSelect={() => undefined}
        onOpenSettings={() => undefined}
        onToggleTheme={() => undefined}
        theme="light"
        themeToggleLabel="切换到夜晚模式"
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

describe("CourseSidebar", () => {
  beforeEach(() => {
    mockIpc.courses.list.mockResolvedValue([]);
    mockIpc.courses.create.mockResolvedValue(undefined);
    pickDirectoryPathMock.mockResolvedValue(
      "/data/user/0/dev.courseai.app.debug/courses/新课程",
    );
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

  it("lets the processing queue nav item span the sidebar width", () => {
    renderSidebar({ onToggleQueue: () => undefined });

    expect(screen.getByRole("button", { name: "处理队列" })).toHaveClass(
      "w-full",
    );
  });
});
