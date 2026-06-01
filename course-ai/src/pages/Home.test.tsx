import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Home } from "./Home";
import type { Course, Video } from "@/lib/types";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    courses: {
      list: vi.fn(),
      create: vi.fn(),
    },
    videos: {
      list: vi.fn(),
    },
    pipeline: {
      process: vi.fn(),
    },
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/components/ImportVideoDialog", () => ({
  ImportVideoButton: () => <button>导入视频</button>,
}));
vi.mock("@/components/JobProgress", () => ({
  JobProgress: () => <div>处理进度</div>,
}));
vi.mock("@/components/RagSearchPanel", () => ({
  RagSearchPanel: () => <input aria-label="课程问答" placeholder="向这节课提问或搜索文稿" />,
}));
vi.mock("@/components/SettingsDialog", () => ({
  SettingsPanel: () => <div>设置面板</div>,
}));
vi.mock("@/components/TabsPanel", () => ({
  TabsPanel: () => <aside aria-label="课程资料">课程资料</aside>,
}));
vi.mock("@/components/VideoPlayer", () => ({
  VideoPlayer: () => <div aria-label="视频播放器">视频播放器</div>,
}));

const course: Course = {
  id: "course-1",
  name: "申论课程",
  root_path: "/tmp/course",
  cover_image: null,
  created_at: 1,
  updated_at: 1,
};

const video: Video = {
  id: "video-1",
  course_id: course.id,
  title: "01.【申论之根】底层逻辑.mp4",
  source_type: "local",
  source_uri: null,
  file_path: "/tmp/video.mp4",
  duration_ms: 6_318_000,
  width: 1920,
  height: 1080,
  order_index: 0,
  data_dir: "/tmp/data",
  processed_status: "pending",
  created_at: 1,
};

function renderHome() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <Home />
    </QueryClientProvider>,
  );
}

describe("Home", () => {
  beforeEach(() => {
    mockIpc.courses.list.mockResolvedValue([course]);
    mockIpc.videos.list.mockResolvedValue([video]);
    mockIpc.pipeline.process.mockResolvedValue(undefined);
  });

  it("turns a selected course and video into the reference-style learning workspace", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    expect(screen.getByText("课程视频")).toBeInTheDocument();
    expect(screen.getByText("学习工作台")).toBeInTheDocument();
    expect(screen.getByText("下一步：处理视频生成文稿和学习资料")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: video.title })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始处理" })).toBeInTheDocument();
    expect(screen.getByLabelText("课程问答")).toBeInTheDocument();
    expect(screen.getByLabelText("视频播放器")).toBeInTheDocument();
    expect(screen.getByLabelText("课程资料")).toBeInTheDocument();
    expect(screen.getByText("处理进度")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await waitFor(() => expect(mockIpc.pipeline.process).toHaveBeenCalledWith(video.id));
  });
});
