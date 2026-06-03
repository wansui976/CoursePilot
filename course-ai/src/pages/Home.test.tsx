import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Home } from "./Home";
import type { Course, Video } from "@/lib/types";
import { useJobs } from "@/stores/jobs";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    courses: {
      list: vi.fn(),
      create: vi.fn(),
    },
    videos: {
      list: vi.fn(),
      mediaUrl: vi.fn(),
      cover: vi.fn(),
      updateTitle: vi.fn(),
      delete: vi.fn(),
    },
    pipeline: {
      process: vi.fn(),
      jobs: vi.fn(),
    },
    ai: {
      generate: vi.fn(),
    },
    slides: {
      extract: vi.fn(),
    },
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), confirm: vi.fn() }));
vi.mock("@/components/ImportVideoDialog", () => ({
  ImportVideoButton: () => <button>导入本地视频</button>,
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
  TabsPanel: () => <aside>学习资料面板</aside>,
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
    localStorage.clear();
    useJobs.getState().resetVideo(video.id);
    mockIpc.courses.list.mockResolvedValue([course]);
    mockIpc.videos.list.mockResolvedValue([video]);
    mockIpc.videos.mediaUrl.mockResolvedValue("http://127.0.0.1:1234/m/video-1");
    mockIpc.videos.cover.mockResolvedValue([]);
    mockIpc.videos.updateTitle.mockResolvedValue({ ...video, title: "重命名.mp4" });
    mockIpc.videos.delete.mockResolvedValue(undefined);
    mockIpc.pipeline.process.mockResolvedValue(undefined);
    mockIpc.pipeline.jobs.mockResolvedValue([]);
    mockIpc.ai.generate.mockResolvedValue(undefined);
    mockIpc.slides.extract.mockResolvedValue(0);
  });

  it("starts in light theme without an in-app macOS titlebar", () => {
    const { container } = renderHome();

    expect(container.firstElementChild).toHaveAttribute("data-theme", "light");
    expect(screen.getByRole("button", { name: "切换到夜晚模式" })).toBeInTheDocument();
    expect(screen.queryByText("course-ai")).not.toBeInTheDocument();
  });

  it("toggles to dark theme and stores the selection", () => {
    const { container } = renderHome();

    fireEvent.click(screen.getByRole("button", { name: "切换到夜晚模式" }));

    expect(container.firstElementChild).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("course-ai-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "切换到白天模式" })).toBeInTheDocument();
  });

  it("initializes from a saved light theme", () => {
    localStorage.setItem("course-ai-theme", "light");

    const { container } = renderHome();

    expect(container.firstElementChild).toHaveAttribute("data-theme", "light");
    expect(screen.getByRole("button", { name: "切换到夜晚模式" })).toBeInTheDocument();
  });

  it("shows the faithful course-library homepage after selecting a course", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));

    expect(screen.getByRole("heading", { name: "课程视频" })).toBeInTheDocument();
    expect(await screen.findByText("申论课程 · 1 个视频")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入本地视频" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("B 站 / 视频链接…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载" })).toBeInTheDocument();
    expect(screen.getByText("最近添加")).toBeInTheDocument();
    expect(screen.getByText("待处理")).toBeInTheDocument();
    expect(screen.getByText("01:45:18")).toBeInTheDocument();
  });

  it("turns a selected course and video into the reference-style learning workspace", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    expect(screen.getByRole("button", { name: "返回课程库" })).toBeInTheDocument();
    expect(screen.getByText("学习工作台")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: video.title })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始处理" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("课程问答")).not.toBeInTheDocument();
    expect(await screen.findByLabelText("视频播放器")).toBeInTheDocument();
    expect(screen.getByLabelText("学习资料面板")).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "调整学习资料宽度" })).toBeInTheDocument();
  });

  it("collapses the library columns after selecting a video so the player keeps usable width", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    expect(screen.queryByText("课程库")).not.toBeInTheDocument();
    expect(screen.queryByText("课程视频")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "返回课程库" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("学习资料面板")).toHaveClass("min-w-[380px]");
  });

  it("starts processing from the homepage video card menu and shows the queue page", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /视频操作/ }));

    expect(screen.getByRole("menuitem", { name: "修改标题" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "删除" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "开始处理" }));
    await waitFor(() => expect(mockIpc.pipeline.process).toHaveBeenCalledWith(video.id));

    const sidebar = screen.getByRole("complementary", { name: "课程侧栏" });
    fireEvent.click(within(sidebar).getByRole("button", { name: "处理队列" }));
    expect(
      within(screen.getByLabelText("处理队列页面")).getByText(video.title),
    ).toBeInTheDocument();
  });

  it("shows detailed ASR progress text in the processing queue page", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /视频操作/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "开始处理" }));
    await waitFor(() => expect(mockIpc.pipeline.process).toHaveBeenCalledWith(video.id));

    act(() => {
      useJobs.getState().setOne({
        video_id: video.id,
        job_id: "asr-job",
        stage: "asr",
        status: "running",
        progress: 0.42,
        message: "识别音频中",
      });
    });

    fireEvent.click(
      within(screen.getByRole("complementary", { name: "课程侧栏" })).getByRole("button", {
        name: "处理队列",
      }),
    );

    expect(screen.getByText("识别音频中")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("renames a video through an inline editor instead of a browser prompt", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /视频操作/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "修改标题" }));

    const titleInput = screen.getByLabelText("视频标题");
    fireEvent.change(titleInput, { target: { value: "重命名.mp4" } });
    fireEvent.click(screen.getByRole("button", { name: "保存标题" }));

    await waitFor(() =>
      expect(mockIpc.videos.updateTitle).toHaveBeenCalledWith(video.id, "重命名.mp4"),
    );
  });

  it("keeps the status badge away from the video action menu", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));

    expect(await screen.findByLabelText("视频操作")).toHaveClass("top-3", "right-3");
    expect(screen.getByTestId("video-status-badge")).not.toHaveClass("absolute", "right-3");
  });
});
