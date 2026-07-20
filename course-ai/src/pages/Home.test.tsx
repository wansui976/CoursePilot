import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Home } from "./Home";
import type { Course, Video } from "@/lib/types";
import { durKey, posKey } from "@/lib/playback";
import { writeVideoResumeState } from "@/lib/resumeState";
import { displayTitle } from "@/lib/videoTitle";
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
      reorder: vi.fn(),
    },
    pipeline: {
      process: vi.fn(),
      jobs: vi.fn(),
      recorrect: vi.fn(),
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
  ImportVideoButton: () => <button>导入</button>,
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

const otherCourse: Course = {
  id: "course-2",
  name: "数学课程",
  root_path: "/tmp/course-2",
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
    document.documentElement.removeAttribute("data-theme");
    useJobs.getState().resetVideo(video.id);
    mockIpc.courses.list.mockResolvedValue([course, otherCourse]);
    mockIpc.videos.list.mockImplementation(async (courseId: string) =>
      courseId === course.id ? [video] : [],
    );
    mockIpc.videos.mediaUrl.mockResolvedValue("http://127.0.0.1:1234/m/video-1");
    mockIpc.videos.cover.mockResolvedValue([]);
    mockIpc.videos.updateTitle.mockResolvedValue({ ...video, title: "重命名.mp4" });
    mockIpc.videos.delete.mockResolvedValue(undefined);
    mockIpc.videos.reorder.mockReset();
    mockIpc.videos.reorder.mockResolvedValue(undefined);
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
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("course-ai-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "切换到白天模式" })).toBeInTheDocument();
  });

  it("initializes from a saved light theme", () => {
    localStorage.setItem("course-ai-theme", "light");

    const { container } = renderHome();

    expect(container.firstElementChild).toHaveAttribute("data-theme", "light");
    expect(screen.getByRole("button", { name: "切换到夜晚模式" })).toBeInTheDocument();
  });

  it("applies the chosen accent color as a CSS var on the app root", () => {
    // .ca-app 在 CSS 里本地定义了 --accent，必须把强调色写成 .ca-app 的内联 style 才生效。
    localStorage.setItem("course-ai-accent", "green");

    const { container } = renderHome();
    const root = container.firstElementChild as HTMLElement;

    expect(root.style.getPropertyValue("--accent")).toBe("#34a853");
    // Tailwind primary 系列也应跟随强调色。
    expect(root.style.getPropertyValue("--color-primary")).toBe("#34a853");
  });

  it("applies the user's custom accent color as a CSS var on the app root", () => {
    localStorage.setItem("course-ai-accent", "custom");
    localStorage.setItem("course-ai-custom-accent", "#123456");

    const { container } = renderHome();
    const root = container.firstElementChild as HTMLElement;

    expect(root.style.getPropertyValue("--accent")).toBe("#123456");
    expect(root.style.getPropertyValue("--color-primary")).toBe("#123456");
  });

  it("shows the faithful course-library homepage after selecting a course", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));

    // 标题层级：h1 是课程名（用户关心「我在哪个课程」），数量降为副标题。
    expect(await screen.findByRole("heading", { name: "申论课程" })).toBeInTheDocument();
    expect(await screen.findByText("1 个视频")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "课程视频" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "网格视图" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "列表视图" })).toBeInTheDocument();
    expect(screen.getByText("待处理")).toBeInTheDocument();
    expect(screen.getByText("01:45:18")).toBeInTheDocument();
  });

  it("keeps the generic heading before any course is selected", () => {
    renderHome();

    expect(screen.getByRole("heading", { name: "课程视频" })).toBeInTheDocument();
    expect(screen.getByText("选择课程后导入或管理视频")).toBeInTheDocument();
  });

  it("hides the duration chip instead of showing a fake 00:00", async () => {
    // 时长未知（DB 无、localStorage 也没记录）时不显示「00:00」误导用户。
    mockIpc.videos.list.mockResolvedValueOnce([{ ...video, duration_ms: null }]);

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    await screen.findByText(displayTitle(video.title));

    expect(screen.queryByText("00:00")).not.toBeInTheDocument();
  });

  it("uses the shared empty-state language when a selected course has no videos", async () => {
    mockIpc.videos.list.mockResolvedValueOnce([]);

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));

    const emptyState = await screen.findByRole("status");
    expect(emptyState).toHaveClass("ca-empty-state");
    expect(within(emptyState).getByRole("heading", { name: "还没有视频" })).toBeInTheDocument();
    // 空态就地给「导入」入口，新用户不用去找右上角的按钮。
    expect(within(emptyState).getByRole("button", { name: "导入" })).toBeInTheDocument();
  });

  it("turns a selected course and video into the reference-style learning workspace", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    expect(screen.getByRole("button", { name: "返回课程库" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "学习工作台" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: displayTitle(video.title) })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始处理" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("课程问答")).not.toBeInTheDocument();
    expect(await screen.findByLabelText("视频播放器")).toBeInTheDocument();
    expect(screen.getByLabelText("学习资料面板")).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "调整学习资料宽度" })).toBeInTheDocument();
  });

  it("resizes the study panel via inline grid-template-columns, not per-frame CSS var writes", async () => {
    // 拖动期间必须内联写 grid-template-columns 而不是每帧改 --study-panel-width：
    // 自定义属性向整棵工作台子树继承，每帧一写会让全量文稿 DOM（数千节点）做样式
    // 重算——这就是右侧打开文稿时拖动分隔条卡顿的来源。
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => {
        cb(0);
        return 1;
      });
    try {
      localStorage.setItem("course-ai-study-panel-width", "480");
      renderHome();
      fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
      fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));
      const separator = screen.getByRole("separator", {
        name: "调整学习资料宽度",
      });
      const wb = separator.parentElement as HTMLElement;

      fireEvent.pointerDown(separator, { clientX: 800 });
      fireEvent.pointerMove(window, { clientX: 700 });

      // 每帧只写内联 grid-template-columns（样式失效被限制在 .ca-wb 自身）……
      expect(wb.style.gridTemplateColumns).toBe("minmax(0, 1fr) 8px 580px");
      // ……继承型自定义属性保持拖动前的值，不再每帧变化。
      expect(wb.style.getPropertyValue("--study-panel-width")).toBe("480px");

      fireEvent.pointerUp(window);

      // 松手：撤掉内联覆盖，宽度交还给稳态的 CSS 变量。
      expect(wb.style.gridTemplateColumns).toBe("");
      expect(wb.style.getPropertyValue("--study-panel-width")).toBe("580px");
      expect(localStorage.getItem("course-ai-study-panel-width")).toBe("580");
    } finally {
      rafSpy.mockRestore();
    }
  });

  it("defaults the study panel width to 480 when nothing is saved", async () => {
    // 回归：Number(null) === 0 是有限数，曾被夹成下限 360，导致本意的默认 480 不可达。
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    const separator = screen.getByRole("separator", {
      name: "调整学习资料宽度",
    });
    const wb = separator.parentElement as HTMLElement;
    expect(wb.style.getPropertyValue("--study-panel-width")).toBe("480px");
  });

  it("does not show a separate continue-learning button for saved playback progress", async () => {
    localStorage.setItem(posKey(video.id), "600");
    localStorage.setItem(durKey(video.id), "3600");

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    await screen.findByText(displayTitle(video.title));

    expect(
      screen.queryByRole("button", { name: `继续学习：${video.title}` }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("已观看 17%")).toBeInTheDocument();
  });

  it("marks fully watched videos instead of leaving them identical to unwatched", async () => {
    // ratio ≥ 0.995 时进度条隐藏；没有任何标记的话「看完」和「没看过」长一样。
    localStorage.setItem(posKey(video.id), "3600");
    localStorage.setItem(durKey(video.id), "3600");

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    await screen.findByText(displayTitle(video.title));

    expect(screen.getByText("已看完")).toBeInTheDocument();
    expect(screen.queryByLabelText(/已观看/)).not.toBeInTheDocument();
  });

  it("restores the saved study panel width for the selected video", async () => {
    writeVideoResumeState(video.id, { studyPanelWidth: 620 });

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    expect(screen.getByLabelText("学习工作台响应布局")).toHaveStyle({
      "--study-panel-width": "620px",
    });
  });

  it("shows a rail with back button next to the learning workspace on wide screens", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    expect(screen.getByRole("navigation", { name: "工具栏" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回课程库" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "学习工作台" })).toBeInTheDocument();
    expect(screen.getByLabelText("学习资料面板")).toBeInTheDocument();
  });

  it("collapses the workbench sidebar by default and remembers expansion per view", async () => {
    const { container } = renderHome();
    const app = container.firstElementChild as HTMLElement;
    // 课程库默认展开
    expect(app).toHaveAttribute("data-sidebar", "expanded");
    expect(screen.getByRole("complementary", { name: "课程侧栏" })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));
    // 工作台默认折叠:图标栏 + 返回按钮
    expect(app).toHaveAttribute("data-sidebar", "collapsed");
    expect(screen.getByRole("navigation", { name: "工具栏" })).toBeInTheDocument();

    // 展开工作台侧栏 → 记忆写入 localStorage
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(app).toHaveAttribute("data-sidebar", "expanded");
    expect(
      JSON.parse(localStorage.getItem("course-ai-sidebar-collapsed") as string),
    ).toEqual({ library: false, workbench: false });

    // 回课程库仍展开(分视图记忆互不影响)
    fireEvent.click(screen.getByRole("button", { name: /申论课程/ }));
    expect(app).toHaveAttribute("data-sidebar", "expanded");
  });

  it("workbench expanded sidebar lists the course videos inline", async () => {
    localStorage.setItem(
      "course-ai-sidebar-collapsed",
      JSON.stringify({ library: false, workbench: false }),
    );
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    const sidebar = screen.getByRole("complementary", { name: "课程侧栏" });
    expect(
      within(sidebar).getByRole("button", { name: /底层逻辑/ }),
    ).toHaveAttribute("aria-current", "true");
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
      within(screen.getByLabelText("处理队列页面")).getByText(displayTitle(video.title)),
    ).toBeInTheDocument();
  });

  it("keeps queued videos visible and openable after switching courses", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /视频操作/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "开始处理" }));
    await waitFor(() => expect(mockIpc.pipeline.process).toHaveBeenCalledWith(video.id));

    fireEvent.click(await screen.findByRole("button", { name: /数学课程/ }));
    const sidebar = screen.getByRole("complementary", { name: "课程侧栏" });
    fireEvent.click(within(sidebar).getByRole("button", { name: "处理队列" }));

    const queuePage = screen.getByLabelText("处理队列页面");
    const queuedTitle = within(queuePage).getByText(displayTitle(video.title));
    expect(queuedTitle).toBeInTheDocument();

    fireEvent.click(queuedTitle);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: displayTitle(video.title) }),
      ).toBeInTheDocument(),
    );
  });

  it("lets the processing queue task list use the full main width", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /视频操作/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "开始处理" }));
    await waitFor(() => expect(mockIpc.pipeline.process).toHaveBeenCalledWith(video.id));

    fireEvent.click(
      within(screen.getByRole("complementary", { name: "课程侧栏" })).getByRole("button", {
        name: "处理队列",
      }),
    );

    const queuePage = screen.getByLabelText("处理队列页面");
    const queueTitle = within(queuePage).getByText(displayTitle(video.title));
    const queueList = queueTitle.closest(".flex-col");

    expect(queueTitle).toBeInTheDocument();
    expect(queueList).toHaveClass("w-full");
    expect(queueList).not.toHaveClass("max-w-3xl");
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

  it("offers move up/down in the video menu as a keyboard-accessible reorder path", async () => {
    // 拖拽排序没有键盘替代（刻意去掉了 dnd-kit 的键盘支持），菜单里补上移/下移。
    const video2: Video = {
      ...video,
      id: "video-2",
      title: "02.第二课.mp4",
      order_index: 1,
    };
    mockIpc.videos.list.mockResolvedValueOnce([video, video2]);

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    await screen.findByText(displayTitle(video2.title));

    fireEvent.click(screen.getAllByRole("button", { name: "视频操作" })[0]);
    // 第一个视频没有「上移」，只有「下移」。
    expect(screen.queryByRole("menuitem", { name: "上移" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "下移" }));

    await waitFor(() =>
      expect(mockIpc.videos.reorder).toHaveBeenCalledWith("course-1", [
        "video-2",
        "video-1",
      ]),
    );
  });

  it("filters videos by title from the topbar search box", async () => {
    const video2: Video = {
      ...video,
      id: "video-2",
      title: "02.第二课.mp4",
      order_index: 1,
    };
    mockIpc.videos.list.mockResolvedValueOnce([video, video2]);

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    await screen.findByText(displayTitle(video2.title));

    const search = screen.getByLabelText("搜索视频");
    fireEvent.change(search, { target: { value: "第二课" } });
    expect(screen.queryByText(displayTitle(video.title))).not.toBeInTheDocument();
    expect(screen.getByText(displayTitle(video2.title))).toBeInTheDocument();

    // 过滤态下排序无意义（子集顺序映射不回全量）：菜单里的上移/下移也不给。
    // 「0」同时命中「01.…」「02.…」两条（过滤按 displayTitle，不含扩展名）。
    fireEvent.change(search, { target: { value: "0" } });
    fireEvent.click(screen.getAllByRole("button", { name: "视频操作" })[0]);
    expect(screen.queryByRole("menuitem", { name: "下移" })).not.toBeInTheDocument();

    // 无匹配给明确的空态，而不是一片空白。
    fireEvent.change(search, { target: { value: "不存在的标题" } });
    expect(screen.getByText("没有匹配的视频")).toBeInTheDocument();

    // Escape 清空过滤。
    fireEvent.keyDown(search, { key: "Escape" });
    expect(await screen.findByText(displayTitle(video.title))).toBeInTheDocument();
  });

  it("keeps the destructive delete action last in the video menu", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /视频操作/ }));

    const items = screen.getAllByRole("menuitem");
    expect(items[items.length - 1]).toHaveTextContent("删除");
  });

  it("keeps the status badge away from the video action menu", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));

    expect(await screen.findByLabelText("视频操作")).toHaveClass("top-3", "right-3");
    expect(screen.getByTestId("video-status-badge")).not.toHaveClass("absolute", "right-3");
  });
});
