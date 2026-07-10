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

  it("renders the collapsed rail with all tool entries", () => {
    renderSidebar({ collapsed: true, queueCount: 2 });
    const rail = screen.getByRole("navigation", { name: "工具栏" });
    expect(rail).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开侧栏" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "处理队列" })).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换到夜晚模式" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "回收站" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
    // 课程库折叠态没有「返回课程库」与「课程视频」
    expect(screen.queryByRole("button", { name: "返回课程库" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "课程视频" })).not.toBeInTheDocument();
  });

  it("hides the expand button in the collapsed rail when collapse is locked", () => {
    renderSidebar({ collapsed: true, lockCollapsed: true });
    // 细栏仍在，但「展开侧栏」按钮被隐藏（窄桌面强制折叠，不允许展开）。
    expect(screen.getByRole("navigation", { name: "工具栏" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "展开侧栏" }),
    ).not.toBeInTheDocument();
    // 其它工具项照常在场。
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });

  it("still shows the expand button in the collapsed rail when not locked", () => {
    renderSidebar({ collapsed: true, lockCollapsed: false });
    expect(screen.getByRole("button", { name: "展开侧栏" })).toBeInTheDocument();
  });

  it("workbench collapsed rail: logo goes back, list button opens the video flyout", () => {
    const onBackToLibrary = vi.fn();
    const onOpenVideo = vi.fn();
    renderSidebar({
      collapsed: true,
      view: "workbench",
      courseName: "申论课程",
      videos: [video],
      selectedVideoId: "video-1",
      onBackToLibrary,
      onOpenVideo,
    });
    expect(screen.queryByRole("button", { name: "处理队列" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回课程库" }));
    expect(onBackToLibrary).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "课程视频" }));
    const flyout = screen.getByRole("dialog", { name: "课程视频列表" });
    expect(flyout).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /底层逻辑/ }));
    expect(onOpenVideo).toHaveBeenCalledWith("video-1");
    // 选择后弹层关闭
    expect(screen.queryByRole("dialog", { name: "课程视频列表" })).not.toBeInTheDocument();
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
    expect(item).toHaveAttribute("aria-current", "true");
    expect(item.querySelector("svg")).not.toBeInTheDocument();
    fireEvent.click(item);
    expect(onOpenVideo).toHaveBeenCalledWith("video-1");
  });

  it("workbench expanded: hides course creation and processing queue entries", () => {
    renderSidebar({ view: "workbench" });
    expect(screen.queryByRole("button", { name: "新建课程" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "处理队列" })).not.toBeInTheDocument();
  });

  it("library expanded: does not inline videos", async () => {
    renderSidebar({ videos: [video] });
    await screen.findByRole("button", { name: /申论课程/ });
    expect(screen.queryByRole("button", { name: /底层逻辑/ })).not.toBeInTheDocument();
  });

  it("lets the processing queue nav item span the sidebar width", () => {
    renderSidebar();
    expect(screen.getByRole("button", { name: "处理队列" })).toHaveClass("w-full");
  });

  it("clears the selected course highlight while the processing queue is open", async () => {
    renderSidebar({ selectedCourseId: "course-1", queueOpen: true });
    const item = await screen.findByRole("button", { name: /申论课程/ });
    // 队列是当前视图时，下方已选课程不应再保留蓝色高亮。
    expect(item.closest(".ca-nav-item")).not.toHaveClass("active");
    expect(screen.getByRole("button", { name: "处理队列" })).toHaveClass("active");
  });

  it("highlights the selected course when the queue is closed", async () => {
    renderSidebar({ selectedCourseId: "course-1", queueOpen: false });
    const item = await screen.findByRole("button", { name: /申论课程/ });
    expect(item.closest(".ca-nav-item")).toHaveClass("active");
  });
});
