import "@testing-library/jest-dom/vitest";
import "@/i18n";
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
  video_count: 1,
};
const video = {
  id: "video-1",
  course_id: "course-1",
  title: "01.底层逻辑.mp4",
  source_type: "local",
  source_uri: null,
  file_path: "/tmp/v.mp4",
  duration_ms: 1000,
  width: null,
  height: null,
  order_index: 0,
  data_dir: "/tmp/d",
  processed_status: "pending",
  created_at: 1,
} as const;

function baseProps(overrides: Partial<Parameters<typeof AppSidebar>[0]> = {}) {
  return {
    view: "library" as const,
    onToggleCollapsed: vi.fn(),
    selectedCourseId: "course-1",
    onSelectCourse: vi.fn(),
    queueOpen: false,
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

  it("renders the expanded library sidebar: brand, add button, course list", async () => {
    renderSidebar();
    expect(screen.getByRole("complementary", { name: "课程侧栏" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加课程文件夹" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /申论课程/ })).toBeInTheDocument();
  });

  it("renders a collapse button in the brand row that triggers collapse", () => {
    const onToggleCollapsed = vi.fn();
    renderSidebar({ onToggleCollapsed });
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("does not render any navigation/global actions (now owned by AppRail)", async () => {
    renderSidebar();
    await screen.findByRole("button", { name: /申论课程/ });
    expect(screen.queryByRole("button", { name: "处理队列" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回收站" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "切换到夜晚模式" })).not.toBeInTheDocument();
  });

  it("workbench expanded: inlines the current course videos under the selected course", async () => {
    const onOpenVideo = vi.fn();
    renderSidebar({
      view: "workbench",
      videos: [video],
      selectedVideoId: "video-1",
      onOpenVideo,
    });
    const item = await screen.findByRole("button", { name: /底层逻辑/ });
    expect(item).toHaveAttribute("aria-current", "page");
    fireEvent.click(item);
    expect(onOpenVideo).toHaveBeenCalledWith("video-1");
  });

  it("workbench expanded: hides course creation", () => {
    renderSidebar({ view: "workbench" });
    expect(screen.queryByRole("button", { name: "添加课程文件夹" })).not.toBeInTheDocument();
  });

  it("library expanded: does not inline videos", async () => {
    renderSidebar({ videos: [video] });
    await screen.findByRole("button", { name: /申论课程/ });
    expect(screen.queryByRole("button", { name: /底层逻辑/ })).not.toBeInTheDocument();
  });

  it("clears the selected course highlight while the processing queue is open", async () => {
    renderSidebar({ selectedCourseId: "course-1", queueOpen: true });
    const item = await screen.findByRole("button", { name: /申论课程/ });
    expect(item.closest(".ca-nav-item")).not.toHaveClass("active");
  });

  it("highlights the selected course when the queue is closed", async () => {
    renderSidebar({ selectedCourseId: "course-1", queueOpen: false });
    const item = await screen.findByRole("button", { name: /申论课程/ });
    expect(item.closest(".ca-nav-item")).toHaveClass("active");
  });
});