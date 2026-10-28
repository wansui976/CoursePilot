import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidebar } from "./AppSidebar";
import type { ShellNav } from "./shellNav";
import { makeNav } from "./testNav";

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

type SidebarOverrides = Partial<Omit<Parameters<typeof AppSidebar>[0], "nav">> & {
  nav?: Partial<ShellNav>;
};

function renderSidebar({ nav, ...overrides }: SidebarOverrides = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const props = {
    nav: makeNav(nav),
    onToggleCollapsed: vi.fn(),
    selectedCourseId: "course-1",
    onSelectCourse: vi.fn(),
    ...overrides,
  };
  render(
    <QueryClientProvider client={queryClient}>
      <AppSidebar {...props} />
    </QueryClientProvider>,
  );
  return props;
}

describe("AppSidebar", () => {
  beforeEach(() => {
    mockIpc.courses.list.mockReset().mockResolvedValue([course]);
  });

  it("renders the expanded library sidebar: add button and course list", async () => {
    renderSidebar();
    expect(screen.getByRole("complementary", { name: "课程侧栏" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加课程文件夹" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /申论课程/ })).toBeInTheDocument();
  });

  it("renders a collapse button in the header that triggers collapse", () => {
    const onToggleCollapsed = vi.fn();
    renderSidebar({ onToggleCollapsed });
    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("lists every global entry in the same column as the courses", async () => {
    const props = renderSidebar({ nav: { queueCount: 2 } });
    await screen.findByRole("button", { name: /申论课程/ });
    for (const name of ["课程库", "学习面板", /处理队列/, "AI 助手", "设置", "回收站", "切换到夜晚模式"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(props.nav.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "处理队列" })).toHaveTextContent("2");
  });

  it("marks the current page without the accent color", () => {
    renderSidebar({ nav: { dashboardOpen: true } });
    const dashboard = screen.getByRole("button", { name: "学习面板" });
    expect(dashboard).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "课程库" })).not.toHaveAttribute("aria-current");
  });

  it("workbench: offers a way back to the library instead of the queue", () => {
    const props = renderSidebar({ nav: { view: "workbench" } });
    fireEvent.click(screen.getByRole("button", { name: "返回课程库" }));
    expect(props.nav.onBackToLibrary).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /处理队列/ })).not.toBeInTheDocument();
  });

  it("workbench expanded: inlines the current course videos under the selected course", async () => {
    const onOpenVideo = vi.fn();
    renderSidebar({
      nav: { view: "workbench" },
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
    renderSidebar({ nav: { view: "workbench" } });
    expect(screen.queryByRole("button", { name: "添加课程文件夹" })).not.toBeInTheDocument();
  });

  it("library expanded: does not inline videos", async () => {
    renderSidebar({ videos: [video] });
    await screen.findByRole("button", { name: /申论课程/ });
    expect(screen.queryByRole("button", { name: /底层逻辑/ })).not.toBeInTheDocument();
  });

  it("clears the selected course highlight while the processing queue is open", async () => {
    renderSidebar({ selectedCourseId: "course-1", nav: { queueOpen: true } });
    const item = await screen.findByRole("button", { name: /申论课程/ });
    expect(item.closest(".ca-nav-item")).not.toHaveClass("active");
  });

  it("highlights the selected course when the queue is closed", async () => {
    renderSidebar({ selectedCourseId: "course-1", nav: { queueOpen: false } });
    const item = await screen.findByRole("button", { name: /申论课程/ });
    expect(item.closest(".ca-nav-item")).toHaveClass("active");
  });
});