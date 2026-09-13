import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Home } from "./Home";
import type { Course, Video } from "@/lib/types";
import { durKey, posKey } from "@/lib/playback";
import { readVideoResumeState, writeVideoResumeState } from "@/lib/resumeState";
import { displayTitle } from "@/lib/videoTitle";
import { useJobs } from "@/stores/jobs";
import { useAssistantUi } from "@/stores/assistant";

const { mockIpc, confirmMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(),
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
      dismiss: vi.fn(),
      jobs: vi.fn(),
      active: vi.fn(),
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
const settingsExitRequestMock = vi.hoisted(() =>
  vi.fn<(continuation: () => void) => void>(),
);

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), confirm: confirmMock }));
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
  SettingsPanel: ({
    onRegisterExitRequest,
  }: {
    onRegisterExitRequest?: (
      request: ((continuation: () => void) => void) | null,
    ) => void;
  }) => {
    onRegisterExitRequest?.(settingsExitRequestMock);
    return <div>设置面板</div>;
  },
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
  video_count: 1,
};

const otherCourse: Course = {
  id: "course-2",
  name: "数学课程",
  root_path: "/tmp/course-2",
  cover_image: null,
  created_at: 1,
  updated_at: 1,
  video_count: 1,
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

  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <Home />
      </QueryClientProvider>,
    ),
  };
}

describe("Home", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    // 本文件只测 Home 自身布局；助手停靠让位是集成测试的事，这里固定浮动态。
    useAssistantUi.setState({ open: false, side: "right", width: 380, mode: "float" });
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
    mockIpc.pipeline.dismiss.mockReset().mockResolvedValue(undefined);
    mockIpc.pipeline.jobs.mockReset().mockResolvedValue([]);
    mockIpc.pipeline.active.mockReset().mockResolvedValue([]);
    mockIpc.pipeline.recorrect.mockReset().mockResolvedValue(undefined);
    confirmMock.mockReset().mockResolvedValue(true);
    settingsExitRequestMock.mockReset();
    mockIpc.ai.generate.mockResolvedValue(undefined);
    mockIpc.slides.extract.mockResolvedValue(0);
  });

  it("starts in light theme without an in-app macOS titlebar", () => {
    const { container } = renderHome();

    expect(container.firstElementChild).toHaveAttribute("data-theme", "light");
    expect(screen.getByRole("button", { name: "切换到夜晚模式" })).toBeInTheDocument();
    expect(screen.queryByText("course-ai")).not.toBeInTheDocument();
  });

  it("toggles to dark theme and stores the selection", async () => {
    const { container } = renderHome();

    fireEvent.click(screen.getByRole("button", { name: "切换到夜晚模式" }));

    // 从按钮扩散的切色圆：新主题在圆盖满整屏时才落到 DOM（没有 View Transitions 的
    // 环境走覆盖层兜底路径），所以这里等它结算，而不是断言点击后立刻变色。
    await waitFor(() => {
      expect(container.firstElementChild).toHaveAttribute("data-theme", "dark");
    });
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
    expect(screen.getAllByText("01:45:18").length).toBeGreaterThan(0);
  });

  it("toggles grid density between roomy and compact", async () => {
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    await screen.findByText("1 个视频");

    // 默认舒适；点一下切成紧凑（grid 容器挂 data-density=compact）。
    const toggle = screen.getByRole("button", { name: "紧凑网格" });
    fireEvent.click(toggle);
    expect(screen.getByLabelText("课程视频网格")).toHaveAttribute(
      "data-density",
      "compact",
    );

    // 再点回舒适。
    fireEvent.click(screen.getByRole("button", { name: "舒适网格" }));
    expect(screen.getByLabelText("课程视频网格")).toHaveAttribute(
      "data-density",
      "cozy",
    );
  });

  it("keeps the generic heading before any course is selected", () => {
    renderHome();

    expect(screen.getByRole("heading", { name: "课程视频" })).toBeInTheDocument();
    expect(screen.getByText("选择课程后导入或管理视频")).toBeInTheDocument();
    const emptyState = screen.getByRole("status");
    expect(within(emptyState).getByRole("heading", { name: "还没有课程" })).toBeInTheDocument();
    expect(
      within(emptyState).getByRole("button", { name: "添加课程文件夹" }),
    ).toBeInTheDocument();
    expect(within(emptyState).queryByText(/从左侧选择/)).not.toBeInTheDocument();
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

    await new Promise((r) => setTimeout(r, 30));
    const roles = screen.queryAllByRole("status");
    console.log("DEBUG statuses:", roles.map((el) => el.className + " | " + (el.getAttribute("aria-label") ?? "")));
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

  it("supports keyboard resizing and exposes the current panel width", async () => {
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    const separator = screen.getByRole("separator", {
      name: "调整学习资料宽度",
    });
    expect(separator).toHaveAttribute("tabindex", "0");
    expect(separator).toHaveAttribute("aria-valuemin", "384");
    // 1024px 宽的工作台要为播放器保留至少 320px：右栏最大只能到 640px。
    expect(separator).toHaveAttribute("aria-valuemax", "640");
    expect(separator).toHaveAttribute("aria-valuenow", "480");

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveAttribute("aria-valuenow", "504");
    expect(localStorage.getItem("course-ai-study-panel-width")).toBe("504");

    fireEvent.keyDown(separator, { key: "ArrowRight", shiftKey: true });
    expect(separator).toHaveAttribute("aria-valuenow", "432");

    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator).toHaveAttribute("aria-valuenow", "384");

    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveAttribute("aria-valuenow", "640");

    fireEvent.keyDown(separator, { key: "Enter" });
    expect(separator).toHaveAttribute("aria-valuenow", "480");
  });

  it("offers a continue-last banner after opening a video and returning to the library", async () => {
    localStorage.setItem(posKey(video.id), "600");
    localStorage.setItem(durKey(video.id), "3600");

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    // 打开视频会记录「该课程最近打开的视频」……
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));
    await screen.findByRole("region", { name: "学习工作台" });
    fireEvent.click(screen.getByRole("button", { name: "返回课程库" }));

    // ……回到课程库后顶部给「继续学习」hero 卡，点击直达工作台（播放器自带断点续播）。
    const banner = await screen.findByRole("button", { name: /继续学习/ });
    expect(banner).toHaveTextContent(displayTitle(video.title));
    expect(banner).toHaveTextContent("从 10:00 继续");

    fireEvent.click(banner);
    expect(await screen.findByRole("region", { name: "学习工作台" })).toBeInTheDocument();
  });

  it("hides the continue banner when the last video was watched through", async () => {
    localStorage.setItem(posKey(video.id), "3600");
    localStorage.setItem(durKey(video.id), "3600");
    localStorage.setItem(`course-ai-last-video:${course.id}`, video.id);

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    await screen.findByText(displayTitle(video.title));

    expect(
      screen.queryByRole("button", { name: /继续学习/ }),
    ).not.toBeInTheDocument();
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
    // 2.1 meta 行：看完态显示「✓ 已看完」（与封面徽标不重复计数）。
    expect(screen.getByText(/✓ 已看完/)).toBeInTheDocument();
  });

  it("shows a loading skeleton while the course videos query is pending", async () => {
    // 查询挂起：不应闪现空态；顶栏课程名来自 courses 查询（已解析），正文是骨架。
    mockIpc.videos.list.mockImplementationOnce(() => new Promise(() => {}));

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    expect(
      await screen.findByRole("status", { name: "正在加载课程视频" }),
    ).toBeInTheDocument();
  });

  it("clears the library search with the explicit clear button", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    const search = await screen.findByLabelText("搜索本课程视频");
    fireEvent.change(search, { target: { value: "贝叶斯" } });

    const clear = screen.getByRole("button", { name: "清空搜索" });
    expect(clear).toBeInTheDocument();
    fireEvent.click(clear);

    expect(search).toHaveValue("");
    expect(screen.queryByRole("button", { name: "清空搜索" })).not.toBeInTheDocument();
  });

  it("shows the watched count and mini progress in the course subtitle", async () => {
    localStorage.setItem(posKey(video.id), "3600");
    localStorage.setItem(durKey(video.id), "3600");

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    await screen.findByText(displayTitle(video.title));

    expect(screen.getByText("已看完 1 个")).toBeInTheDocument();
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

  it("collapses the wide study panel and restores that state for the video", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    const workbench = screen.getByLabelText("学习工作台响应布局");
    fireEvent.click(screen.getByRole("button", { name: "收起学习资料面板" }));

    expect(workbench).toHaveAttribute("data-panel-collapsed");
    expect(screen.queryByLabelText("学习资料面板")).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "调整学习资料宽度" })).not.toBeInTheDocument();
    expect(readVideoResumeState(video.id).studyPanelCollapsed).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "展开学习资料面板" }));
    expect(workbench).not.toHaveAttribute("data-panel-collapsed");
    expect(screen.getByLabelText("学习资料面板")).toBeInTheDocument();
  });

  it("loads a saved collapsed study panel when reopening a video", async () => {
    writeVideoResumeState(video.id, { studyPanelCollapsed: true });
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    expect(screen.getByLabelText("学习工作台响应布局")).toHaveAttribute(
      "data-panel-collapsed",
    );
    expect(screen.getByRole("button", { name: "展开学习资料面板" })).toBeInTheDocument();
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

  it("collapses and expands the study panel from the workbench", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    const wb = screen.getByLabelText("学习工作台响应布局");
    expect(wb).not.toHaveAttribute("data-panel-collapsed");
    expect(screen.getByLabelText("学习资料面板")).toBeInTheDocument();

    // 收起：右栏隐藏，出现展开把手。
    fireEvent.click(screen.getByRole("button", { name: "收起学习资料面板" }));
    expect(wb).toHaveAttribute("data-panel-collapsed");
    expect(screen.queryByLabelText("学习资料面板")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开学习资料面板" })).toBeInTheDocument();

    // 展开：右栏回来。
    fireEvent.click(screen.getByRole("button", { name: "展开学习资料面板" }));
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

  it("dedupes global actions: settings/dashboard live only in the rail, not the sidebar", async () => {
    renderHome();
    const sidebar = await screen.findByRole("complementary", { name: "课程侧栏" });
    // 全局动作只出现在常驻 rail，侧栏里去重
    expect(within(sidebar).queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
    expect(within(sidebar).queryByRole("button", { name: "学习面板" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "设置" })).toHaveLength(1);
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
    ).toHaveAttribute("aria-current", "page");
  });

  it("recovers backend processing tasks after the home view remounts", async () => {
    mockIpc.pipeline.active.mockResolvedValue([video]);
    mockIpc.pipeline.jobs.mockResolvedValue([
      {
        id: "asr-job",
        video_id: video.id,
        stage: "asr",
        status: "running",
        progress: 0.35,
        message: "恢复中的识别任务",
        started_at: null,
        finished_at: null,
      },
    ]);
    renderHome();

    await waitFor(() => expect(mockIpc.pipeline.jobs).toHaveBeenCalledWith(video.id));
    fireEvent.click(within(screen.getByRole("navigation", { name: "工具栏" })).getByRole("button", { name: "处理队列" }));

    const queuePage = screen.getByLabelText("处理队列页面");
    expect(within(queuePage).getByText(displayTitle(video.title))).toBeInTheDocument();
    expect(within(queuePage).getByText("恢复中的识别任务")).toBeInTheDocument();
    expect(within(queuePage).getByText("35%")).toBeInTheDocument();
  });

  it("shows a retryable queue load error instead of an empty queue", async () => {
    mockIpc.pipeline.active
      .mockRejectedValueOnce(new Error("processing queue unavailable"))
      .mockResolvedValueOnce([]);
    renderHome();

    fireEvent.click(within(screen.getByRole("navigation", { name: "工具栏" })).getByRole("button", { name: "处理队列" }));
    const queuePage = screen.getByLabelText("处理队列页面");

    expect(await within(queuePage).findByRole("alert")).toHaveTextContent(
      "processing queue unavailable",
    );
    expect(within(queuePage).queryByText(/暂无正在处理的视频/)).not.toBeInTheDocument();

    const activeCallsBeforeRetry = mockIpc.pipeline.active.mock.calls.length;
    fireEvent.click(within(queuePage).getByRole("button", { name: "重试" }));

    await waitFor(() =>
      expect(mockIpc.pipeline.active.mock.calls.length).toBeGreaterThan(
        activeCallsBeforeRetry,
      ),
    );
    expect(await within(queuePage).findByText(/暂无正在处理的视频/)).toBeInTheDocument();
  });

  it("routes desktop sidebar navigation through the registered settings exit guard", async () => {
    renderHome();
    const rail = await screen.findByRole("navigation", { name: "工具栏" });

    fireEvent.click(within(rail).getByRole("button", { name: "设置" }));
    expect(screen.getByText("设置面板")).toBeInTheDocument();

    fireEvent.click(within(rail).getByRole("button", { name: "学习面板" }));

    expect(settingsExitRequestMock).toHaveBeenCalledOnce();
    expect(screen.getByText("设置面板")).toBeInTheDocument();

    const continuation = settingsExitRequestMock.mock.calls[0][0];
    act(() => continuation());

    expect(screen.queryByText("设置面板")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "学习面板" })).toBeInTheDocument();
  });

  it("guards course selection while settings has an unresolved draft", async () => {
    renderHome();
    const rail = await screen.findByRole("navigation", { name: "工具栏" });
    const sidebar = await screen.findByRole("complementary", { name: "课程侧栏" });
    fireEvent.click(within(rail).getByRole("button", { name: "设置" }));

    fireEvent.click(within(sidebar).getByRole("button", { name: /申论课程/ }));

    expect(settingsExitRequestMock).toHaveBeenCalledOnce();
    expect(screen.getByText("设置面板")).toBeInTheDocument();

    act(() => settingsExitRequestMock.mock.calls[0][0]());

    expect(screen.queryByText("设置面板")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "申论课程" })).toBeInTheDocument();
  });

  it("shows and retries a per-video jobs load error instead of waiting", async () => {
    mockIpc.pipeline.active.mockResolvedValue([video]);
    mockIpc.pipeline.jobs
      .mockRejectedValueOnce(new Error("jobs database unavailable"))
      .mockResolvedValueOnce([
        {
          id: "asr-job",
          video_id: video.id,
          stage: "asr",
          status: "running",
          progress: 0.4,
          message: "识别任务已恢复",
          started_at: null,
          finished_at: null,
        },
      ]);
    renderHome();

    await waitFor(() => expect(mockIpc.pipeline.jobs).toHaveBeenCalledWith(video.id));
    fireEvent.click(within(screen.getByRole("navigation", { name: "工具栏" })).getByRole("button", { name: "处理队列" }));
    const queuePage = screen.getByLabelText("处理队列页面");

    expect(await within(queuePage).findByText("任务进度读取失败")).toBeInTheDocument();
    expect(within(queuePage).getByRole("alert")).toHaveTextContent(
      "jobs database unavailable",
    );
    expect(within(queuePage).queryByText("等待中")).not.toBeInTheDocument();

    const jobsCallsBeforeRetry = mockIpc.pipeline.jobs.mock.calls.length;
    fireEvent.click(within(queuePage).getByRole("button", { name: "重试" }));

    await waitFor(() =>
      expect(mockIpc.pipeline.jobs.mock.calls.length).toBeGreaterThan(
        jobsCallsBeforeRetry,
      ),
    );
    expect(await within(queuePage).findByText("识别任务已恢复")).toBeInTheDocument();
  });

  it("starts processing from the homepage video card menu and shows the queue page", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /视频操作/ }));

    expect(screen.getByRole("menuitem", { name: "修改标题" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "删除" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "开始处理" }));
    await waitFor(() => expect(mockIpc.pipeline.process).toHaveBeenCalledWith(video.id));

    fireEvent.click(within(screen.getByRole("navigation", { name: "工具栏" })).getByRole("button", { name: "处理队列" }));
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
    fireEvent.click(within(screen.getByRole("navigation", { name: "工具栏" })).getByRole("button", { name: "处理队列" }));

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
      within(screen.getByRole("navigation", { name: "工具栏" })).getByRole("button", {
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
      within(screen.getByRole("navigation", { name: "工具栏" })).getByRole("button", {
        name: "处理队列",
      }),
    );

    expect(screen.getByText("识别音频中")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("refreshes has_transcript once when ASR finishes without LLM follow-ups", async () => {
    const { queryClient } = renderHome();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    await screen.findByText(displayTitle(video.title));

    act(() => {
      useJobs.getState().setOne({
        video_id: video.id,
        job_id: "asr-running",
        stage: "asr",
        status: "running",
        progress: 0.5,
        message: null,
      });
    });
    expect(
      invalidate.mock.calls.filter(([filters]) =>
        Array.isArray(filters?.queryKey) && filters.queryKey[0] === "videos",
      ),
    ).toHaveLength(0);

    act(() => {
      useJobs.getState().setOne({
        video_id: video.id,
        job_id: "asr-done",
        stage: "asr",
        status: "done",
        progress: 1,
        message: null,
      });
      for (const stage of ["chapters", "summary", "notes", "quiz", "mindmap"]) {
        useJobs.getState().setOne({
          video_id: video.id,
          job_id: `${stage}-canceled`,
          stage,
          status: "canceled",
          progress: 0,
          message: null,
        });
      }
    });

    await waitFor(() =>
      expect(
        invalidate.mock.calls.filter(([filters]) =>
          Array.isArray(filters?.queryKey) && filters.queryKey[0] === "videos",
        ),
      ).toHaveLength(1),
    );

    act(() => {
      useJobs.getState().setOne({
        video_id: video.id,
        job_id: "asr-done",
        stage: "asr",
        status: "done",
        progress: 1,
        message: "重复终态事件",
      });
    });
    expect(
      invalidate.mock.calls.filter(([filters]) =>
        Array.isArray(filters?.queryKey) && filters.queryKey[0] === "videos",
      ),
    ).toHaveLength(1);
  });

  it("clears a recorrection failure when switching away from its course", async () => {
    const transcribedVideo = {
      ...video,
      processed_status: "done" as const,
      has_transcript: true,
    };
    mockIpc.videos.list.mockImplementation(async (courseId: string) =>
      courseId === course.id ? [transcribedVideo] : [],
    );
    mockIpc.pipeline.recorrect.mockRejectedValueOnce(new Error("纠错服务不可用"));
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /视频操作/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重新纠错" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("纠错服务不可用");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /数学课程/ }));

    await waitFor(() =>
      expect(screen.queryByText("纠错服务不可用")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    await screen.findByText(displayTitle(video.title));
    expect(screen.queryByText("纠错服务不可用")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
    expect(mockIpc.pipeline.recorrect).toHaveBeenCalledTimes(1);
  });

  it("explains the replacement and does not recorrect when cancelled", async () => {
    const transcribedVideo = {
      ...video,
      processed_status: "done" as const,
      has_transcript: true,
    };
    mockIpc.videos.list.mockImplementation(async (courseId: string) =>
      courseId === course.id ? [transcribedVideo] : [],
    );
    confirmMock.mockResolvedValue(false);
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /视频操作/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重新纠错" }));

    await waitFor(() =>
      expect(confirmMock).toHaveBeenCalledWith(
        expect.stringContaining("会替换当前文稿"),
        expect.objectContaining({
          title: "重新纠正文稿？",
          okLabel: "确认重新纠错",
        }),
      ),
    );
    expect(mockIpc.pipeline.recorrect).not.toHaveBeenCalled();
  });

  it("keeps a pending recorrection guarded and preserves its error after returning", async () => {
    const transcribedVideo = {
      ...video,
      processed_status: "done" as const,
      has_transcript: true,
    };
    mockIpc.videos.list.mockImplementation(async (courseId: string) =>
      courseId === course.id ? [transcribedVideo] : [],
    );
    let failRecorrection!: (error: Error) => void;
    mockIpc.pipeline.recorrect.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          failRecorrection = reject;
        }),
    );
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /视频操作/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重新纠错" }));
    await waitFor(() => expect(mockIpc.pipeline.recorrect).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: /视频操作/ }));
    const pendingItem = screen.getByRole("menuitem", { name: "纠错中…" });
    expect(pendingItem).toBeDisabled();
    fireEvent.click(pendingItem);
    expect(mockIpc.pipeline.recorrect).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole("button", { name: /数学课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    await screen.findByText(displayTitle(video.title));
    const guardedAfterReturn = screen.queryByRole("menuitem", { name: "纠错中…" });
    if (!guardedAfterReturn) {
      fireEvent.click(await screen.findByRole("button", { name: /视频操作/ }));
    }
    expect(screen.getByRole("menuitem", { name: "纠错中…" })).toBeDisabled();
    expect(mockIpc.pipeline.recorrect).toHaveBeenCalledTimes(1);

    await act(async () => failRecorrection(new Error("返回后仍应看到纠错失败")));
    expect(await screen.findByRole("alert")).toHaveTextContent("返回后仍应看到纠错失败");
    expect(screen.getByRole("menuitem", { name: "重新纠错" })).toBeEnabled();
  });

  it("keeps complete failure details and lets users retry or remove a failed task", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /视频操作/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "开始处理" }));
    await waitFor(() => expect(mockIpc.pipeline.process).toHaveBeenCalledWith(video.id));

    const fullError =
      "语音识别失败：模型文件校验未通过，请重新下载模型后再试。详细信息：checksum mismatch";
    act(() => {
      useJobs.getState().setOne({
        video_id: video.id,
        job_id: "asr-failed",
        stage: "asr",
        status: "failed",
        progress: 0.42,
        message: fullError,
      });
    });

    fireEvent.click(
      within(screen.getByRole("navigation", { name: "工具栏" })).getByRole("button", {
        name: "处理队列",
      }),
    );

    const error = screen.getByText(fullError);
    expect(error).toHaveClass("whitespace-pre-wrap", "break-words");
    expect(
      screen.getByRole("progressbar", {
        name: `${displayTitle(video.title)} 的处理进度`,
      }),
    ).toHaveAttribute("aria-valuenow");
    const processCalls = mockIpc.pipeline.process.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(mockIpc.pipeline.process).toHaveBeenCalledTimes(processCalls + 1),
    );

    act(() => {
      useJobs.getState().setOne({
        video_id: video.id,
        job_id: "asr-failed-again",
        stage: "asr",
        status: "failed",
        progress: 0.42,
        message: fullError,
      });
    });
    mockIpc.pipeline.dismiss.mockRejectedValueOnce(new Error("任务移除失败"));
    fireEvent.click(screen.getByRole("button", { name: "移除" }));

    const removeError = (await screen.findByText("任务移除失败")).closest(
      '[role="alert"]',
    ) as HTMLElement;
    expect(removeError).toHaveTextContent("任务移除失败");
    expect(screen.getByText(displayTitle(video.title))).toBeInTheDocument();
    fireEvent.click(within(removeError).getByRole("button", { name: "重试" }));

    await waitFor(() => expect(mockIpc.pipeline.dismiss).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText(displayTitle(video.title))).not.toBeInTheDocument(),
    );
  });

  it("renames a video through an inline editor instead of a browser prompt", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    const trigger = await screen.findByRole("button", { name: /视频操作/ });
    fireEvent.click(trigger);
    const editTitle = screen.getByRole("menuitem", { name: "修改标题" });
    expect(editTitle).toHaveFocus();
    fireEvent.click(editTitle);

    const titleInput = screen.getByLabelText("视频标题");
    expect(titleInput).toHaveFocus();
    fireEvent.change(titleInput, { target: { value: "重命名.mp4" } });
    fireEvent.click(screen.getByRole("button", { name: "保存标题" }));

    await waitFor(() =>
      expect(mockIpc.videos.updateTitle).toHaveBeenCalledWith(video.id, "重命名.mp4"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "修改标题" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("does not steal focus after an asynchronous title save when the user moved on", async () => {
    let finishSave!: (updated: Video) => void;
    mockIpc.videos.updateTitle.mockImplementationOnce(
      () => new Promise<Video>((resolve) => {
        finishSave = resolve;
      }),
    );
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /申论课程/ }));
    fireEvent.click(await screen.findByRole("button", { name: /视频操作/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "修改标题" }));
    fireEvent.change(screen.getByLabelText("视频标题"), {
      target: { value: "异步重命名.mp4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存标题" }));

    const search = screen.getByLabelText("搜索本课程视频");
    search.focus();
    expect(search).toHaveFocus();
    await act(async () => {
      finishSave({ ...video, title: "异步重命名.mp4" });
    });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "修改标题" })).not.toBeInTheDocument());
    expect(search).toHaveFocus();
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

    const search = screen.getByLabelText("搜索本课程视频");
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
