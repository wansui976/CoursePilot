import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidebar } from "./AppSidebar";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    courses: {
      list: vi.fn(),
      create: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(),
      relinkRoot: vi.fn(),
    },
  },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), message: vi.fn() }));
vi.mock("@/lib/mobileFiles", () => ({ isIOS: () => false, pickDirectoryPath: vi.fn() }));

const course = {
  id: "course-1",
  name: "申论课程",
  root_path: "/tmp/c",
  cover_image: null,
  created_at: 1,
  updated_at: 1,
};

function baseProps(overrides: Partial<Parameters<typeof AppSidebar>[0]> = {}) {
  return {
    view: "library" as const,
    collapsed: false,
    onToggleCollapsed: vi.fn(),
    selectedCourseId: "course-1",
    onSelectCourse: vi.fn(),
    theme: "light" as const,
    themeToggleLabel: "切换到夜晚模式",
    onToggleTheme: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenRecycleBin: vi.fn(),
    queueOpen: false,
    queueCount: 0,
    onToggleQueue: vi.fn(),
    ...overrides,
  };
}

function renderSidebar(overrides: Partial<Parameters<typeof AppSidebar>[0]> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppSidebar {...baseProps(overrides)} />
    </QueryClientProvider>,
  );
}

describe("AppSidebar", () => {
  beforeEach(() => {
    mockIpc.courses.list.mockReset().mockResolvedValue([course]);
  });

  it("renders the expanded library sidebar with unified entries", async () => {
    renderSidebar();
    expect(screen.getByRole("complementary", { name: "课程侧栏" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建课程" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "处理队列" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /申论课程/ })).toBeInTheDocument();
    // 底部固定功能区
    expect(screen.getByRole("button", { name: "切换到夜晚模式" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "回收站" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });

  it("shows the queue badge and collapse toggle in the expanded state", async () => {
    const onToggleCollapsed = vi.fn();
    renderSidebar({ queueCount: 4, onToggleCollapsed });
    expect(screen.getByText("4")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(onToggleCollapsed).toHaveBeenCalled();
  });
});
