import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Home } from "./Home";
import type { Course, Video } from "@/lib/types";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    courses: { list: vi.fn(), create: vi.fn() },
    videos: {
      list: vi.fn(),
      addLocal: vi.fn(),
      mediaUrl: vi.fn(),
      ensurePlayable: vi.fn(),
      cover: vi.fn(),
      updateTitle: vi.fn(),
      delete: vi.fn(),
    },
    pipeline: { process: vi.fn(), jobs: vi.fn(), recorrect: vi.fn() },
    transcripts: { list: vi.fn() },
    ai: {
      buildEmbeddings: vi.fn(),
      ragQuery: vi.fn(),
      getChapters: vi.fn(),
      getNotes: vi.fn(),
      saveNotes: vi.fn(),
      generate: vi.fn(),
      getQuiz: vi.fn(),
      getMindmap: vi.fn(),
      getSummary: vi.fn(),
    },
    slides: {
      list: vi.fn(),
      screenshots: vi.fn(),
      extract: vi.fn(),
      capture: vi.fn(),
    },
    export: {
      subtitles: vi.fn(),
      notes: vi.fn(),
      quiz: vi.fn(),
      mindmap: vi.fn(),
    },
    settings: { get: vi.fn(), set: vi.fn() },
    secrets: { set: vi.fn() },
    tools: { ocr: vi.fn(), importBilibili: vi.fn() },
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
const mockUseContainerWidth = vi.hoisted(() => ({
  useContainerWidth: vi.fn(),
}));
const mockBackButtonPress = vi.hoisted(() => ({
  onBackButtonPress: vi.fn(),
}));
const mockCurrentWindow = vi.hoisted(() => ({
  onCloseRequested: vi.fn(),
}));
vi.mock("@/lib/useContainerWidth", () => mockUseContainerWidth);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), confirm: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));
vi.mock("@tauri-apps/api/app", () => mockBackButtonPress);
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => mockCurrentWindow as never,
}));

const course: Course = {
  id: "course-1",
  name: "Downloads",
  root_path: "/tmp/downloads",
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

describe("Home selected-video integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("wide");
    mockBackButtonPress.onBackButtonPress.mockReset();
    mockCurrentWindow.onCloseRequested.mockReset();
    mockBackButtonPress.onBackButtonPress.mockImplementation(async () => ({
      unregister: vi.fn(),
    }));
    mockCurrentWindow.onCloseRequested.mockImplementation(async () => vi.fn());
    mockIpc.courses.list.mockResolvedValue([course]);
    mockIpc.videos.list.mockResolvedValue([video]);
    mockIpc.videos.mediaUrl.mockResolvedValue("http://127.0.0.1:1234/m/video-1");
    mockIpc.videos.cover.mockResolvedValue([]);
    mockIpc.pipeline.jobs.mockResolvedValue([]);
    mockIpc.pipeline.process.mockResolvedValue(undefined);
    mockIpc.transcripts.list.mockResolvedValue([]);
    mockIpc.ai.getChapters.mockResolvedValue([]);
    mockIpc.ai.getNotes.mockResolvedValue(null);
    mockIpc.ai.getQuiz.mockResolvedValue(null);
    mockIpc.ai.getMindmap.mockResolvedValue(null);
    mockIpc.ai.getSummary.mockResolvedValue(null);
    mockIpc.slides.list.mockResolvedValue([]);
    mockIpc.slides.screenshots.mockResolvedValue([]);
    mockIpc.settings.get.mockResolvedValue(null);
    mockIpc.settings.set.mockResolvedValue(undefined);
    mockIpc.secrets.set.mockResolvedValue(undefined);
  });

  it("keeps visible learning UI when the real selected-video panels mount", async () => {
    const { container } = renderHome();

    fireEvent.click(await screen.findByRole("button", { name: "Downloads" }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    expect(container.firstElementChild).toHaveAttribute("data-bucket", "wide");
    expect(screen.getByRole("region", { name: "学习工作台" })).toBeInTheDocument();
    expect(screen.getByText(video.title)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "AI 概览" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "笔记" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "文稿" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "课件" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "笔记" }));
    // 笔记面板按需懒加载，等它挂载。
    expect(await screen.findByRole("button", { name: "笔记" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "出题" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "脑图" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提问" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "搜索" })).toBeInTheDocument();
  });

  it("switches the selected-video shell to a stacked layout on narrow screens", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: "Downloads" }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    expect(screen.getByLabelText("学习工作台响应布局")).toHaveAttribute(
      "data-layout",
      "stacked",
    );
    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开课程库" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "主导航" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("学习资料面板")).toBeInTheDocument();
  });

  it("shows a rail instead of the full sidebar for iPad landscape workspaces", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("wide");

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: "Downloads" }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    expect(screen.getByLabelText("学习工作台响应布局")).toHaveAttribute(
      "data-layout",
      "wide",
    );
    expect(screen.getByRole("navigation", { name: "工具栏" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回课程库" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开课程库" })).not.toBeInTheDocument();
  });

  it("returns from the queue page when Android back is pressed", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    vi.stubGlobal("navigator", { userAgent: "Android" });

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: "Downloads" }));
    fireEvent.click(screen.getByRole("button", { name: "队列" }));

    expect(screen.getByLabelText("处理队列页面")).toBeInTheDocument();

    await waitFor(() => expect(mockBackButtonPress.onBackButtonPress).toHaveBeenCalled());
    const handler = mockBackButtonPress.onBackButtonPress.mock.calls[
      mockBackButtonPress.onBackButtonPress.mock.calls.length - 1
    ]?.[0] as
      | ((payload: { canGoBack: boolean }) => void)
      | undefined;
    expect(handler).toBeTypeOf("function");

    act(() => {
      handler?.({ canGoBack: false });
    });

    await waitFor(() =>
      expect(screen.queryByLabelText("处理队列页面")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { name: "课程视频" })).toBeInTheDocument();
  });

  it("uses bottom tabs and course-list drill-down on a compact screen", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    renderHome();

    const nav = await screen.findByRole("navigation", { name: "主导航" });
    expect(within(nav).getByRole("button", { name: "课程" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "队列" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "课程侧栏" })).toHaveClass(
      "ca-course-screen",
    );

    fireEvent.click(within(nav).getByRole("button", { name: "设置" }));

    expect(await screen.findByRole("heading", { name: "设置" })).toBeInTheDocument();
  });
});
