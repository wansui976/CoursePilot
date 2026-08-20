import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Home } from "./Home";
import type { Course, Video } from "@/lib/types";
import { displayTitle } from "@/lib/videoTitle";
import { usePlayer } from "@/stores/player";
import { useAssistantUi } from "@/stores/assistant";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    app: { exit: vi.fn() },
    courses: { list: vi.fn(), create: vi.fn(), rename: vi.fn() },
    videos: {
      list: vi.fn(),
      addLocal: vi.fn(),
      mediaUrl: vi.fn(),
      ensurePlayable: vi.fn(),
      ensureCrop: vi.fn().mockResolvedValue({
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
        detecting: false,
      }),
      cancelCropDetect: vi.fn().mockResolvedValue(undefined),
      cover: vi.fn(),
      updateTitle: vi.fn(),
      delete: vi.fn(),
    },
    pipeline: {
      process: vi.fn(),
      dismiss: vi.fn(),
      jobs: vi.fn(),
      active: vi.fn(),
      recorrect: vi.fn(),
    },
    transcripts: { list: vi.fn(), update: vi.fn() },
    ai: {
      getProfiles: vi.fn(),
      saveProfiles: vi.fn(),
      setApiKey: vi.fn(),
      hasApiKey: vi.fn(),
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
    srs: {
      weakConcepts: vi.fn(),
      countDue: vi.fn(),
      dueByCourse: vi.fn(),
    },
    stats: {
      nextDueAt: vi.fn(),
      continueLearning: vi.fn(),
      dailyTotals: vi.fn(),
      courseTotals: vi.fn(),
      courseVideoIds: vi.fn(),
      videoProgress: vi.fn(),
    },
    settings: { get: vi.fn(), set: vi.fn() },
    secrets: { set: vi.fn(), has: vi.fn() },
    tools: { ocr: vi.fn(), importBilibili: vi.fn() },
    dev: {
      logs: vi.fn(),
      llmUsage: vi.fn(),
      clearLogs: vi.fn(),
      clearLlmUsage: vi.fn(),
    },
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/components/ConceptsPanel", () => ({
  ConceptsPanel: ({
    onClose,
    onJump,
    initialNavigationState,
  }: {
    onClose: () => void;
    onJump: (videoId: string, startMs: number, state: {
      conceptId: string;
      conceptName: string;
      search: string;
      expandedConceptId: string;
      scrollTop: number;
    }) => void;
    initialNavigationState?: {
      search: string;
      expandedConceptId: string | null;
      scrollTop: number;
    } | null;
  }) => (
    <section
      aria-label="课程知识页面"
      data-search={initialNavigationState?.search ?? ""}
      data-expanded={initialNavigationState?.expandedConceptId ?? ""}
      data-scroll-top={initialNavigationState?.scrollTop ?? 0}
    >
      <button type="button" onClick={onClose}>关闭课程知识</button>
      <button
        type="button"
        onClick={() =>
          onJump("video-1", 65_000, {
            conceptId: "concept-1",
            conceptName: "贝叶斯定理",
            search: "条件概率",
            expandedConceptId: "concept-1",
            scrollTop: 320,
          })
        }
      >
        回看字幕证据
      </button>
    </section>
  ),
}));
const mockUseContainerWidth = vi.hoisted(() => ({
  useContainerWidth: vi.fn(),
  coarsePointer: vi.fn(() => false),
  useIsPortrait: vi.fn(() => false),
}));
const mockPlatform = vi.hoisted(() => ({
  isTablet: vi.fn(() => false),
  isMobile: vi.fn(() => false),
  isAndroid: vi.fn(() => false),
  isIOS: vi.fn(() => false),
  isDesktop: vi.fn(() => true),
}));
const mockBackButtonPress = vi.hoisted(() => ({
  onBackButtonPress: vi.fn(),
}));
const mockCurrentWindow = vi.hoisted(() => ({
  onCloseRequested: vi.fn(),
  setFullscreen: vi.fn(),
}));
vi.mock("@/lib/useContainerWidth", () => mockUseContainerWidth);
vi.mock("@/lib/platform", () => mockPlatform);
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
    localStorage.clear();
    useAssistantUi.setState({ open: false, side: "right", width: 380 });
    usePlayer.setState({
      videoId: null,
      currentMs: 0,
      durationMs: 0,
      seekRequest: null,
      pendingSeek: null,
    });
    mockUseContainerWidth.useContainerWidth.mockReturnValue("wide");
    mockUseContainerWidth.coarsePointer.mockReturnValue(false);
    mockUseContainerWidth.useIsPortrait.mockReturnValue(false);
    mockPlatform.isTablet.mockReturnValue(false);
    mockBackButtonPress.onBackButtonPress.mockReset();
    mockCurrentWindow.onCloseRequested.mockReset();
    mockCurrentWindow.setFullscreen.mockReset().mockResolvedValue(undefined);
    mockBackButtonPress.onBackButtonPress.mockImplementation(async () => ({
      unregister: vi.fn(),
    }));
    mockCurrentWindow.onCloseRequested.mockImplementation(async () => vi.fn());
    mockIpc.courses.list.mockResolvedValue([course]);
    mockIpc.courses.rename.mockReset().mockResolvedValue(undefined);
    mockIpc.app.exit.mockReset().mockResolvedValue(undefined);
    mockIpc.videos.list.mockResolvedValue([video]);
    mockIpc.videos.mediaUrl.mockResolvedValue("http://127.0.0.1:1234/m/video-1");
    mockIpc.videos.cover.mockResolvedValue([]);
    mockIpc.pipeline.jobs.mockResolvedValue([]);
    mockIpc.pipeline.active.mockResolvedValue([]);
    mockIpc.pipeline.process.mockResolvedValue(undefined);
    mockIpc.pipeline.dismiss.mockResolvedValue(undefined);
    mockIpc.transcripts.list.mockResolvedValue([]);
    mockIpc.transcripts.update.mockReset().mockResolvedValue(undefined);
    mockIpc.ai.getChapters.mockResolvedValue([]);
    mockIpc.ai.getNotes.mockResolvedValue(null);
    mockIpc.ai.getQuiz.mockResolvedValue(null);
    mockIpc.ai.getMindmap.mockResolvedValue(null);
    mockIpc.ai.getSummary.mockResolvedValue(null);
    mockIpc.ai.getProfiles.mockResolvedValue([
      {
        id: "profile-1",
        name: "默认配置",
        kind: "openai",
        base_url: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      },
    ]);
    mockIpc.ai.saveProfiles.mockResolvedValue(undefined);
    mockIpc.ai.setApiKey.mockResolvedValue(undefined);
    mockIpc.ai.hasApiKey.mockResolvedValue(false);
    mockIpc.slides.list.mockResolvedValue([]);
    mockIpc.slides.screenshots.mockResolvedValue([]);
    mockIpc.srs.weakConcepts.mockResolvedValue([]);
    mockIpc.srs.countDue.mockResolvedValue(0);
    mockIpc.srs.dueByCourse.mockResolvedValue([]);
    mockIpc.stats.nextDueAt.mockResolvedValue(null);
    mockIpc.stats.continueLearning.mockResolvedValue([]);
    mockIpc.stats.dailyTotals.mockResolvedValue([]);
    mockIpc.stats.courseTotals.mockResolvedValue([]);
    mockIpc.stats.courseVideoIds.mockResolvedValue([]);
    mockIpc.stats.videoProgress.mockResolvedValue([]);
    mockIpc.settings.get.mockResolvedValue(null);
    mockIpc.settings.set.mockResolvedValue(undefined);
    mockIpc.secrets.set.mockResolvedValue(undefined);
    mockIpc.secrets.has.mockResolvedValue(false);
    mockIpc.dev.logs.mockResolvedValue([]);
    mockIpc.dev.llmUsage.mockResolvedValue([]);
    mockIpc.dev.clearLogs.mockResolvedValue(undefined);
    mockIpc.dev.clearLlmUsage.mockResolvedValue(undefined);
  });

  it("keeps visible learning UI when the real selected-video panels mount", async () => {
    const { container } = renderHome();

    fireEvent.click(
      await screen.findByRole("button", { name: /Downloads/ }, { timeout: 5_000 }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /底层逻辑/ }, { timeout: 5_000 }),
    );

    expect(container.firstElementChild).toHaveAttribute("data-bucket", "wide");
    expect(screen.getByRole("region", { name: "学习工作台" })).toBeInTheDocument();
    expect(screen.getByText(displayTitle(video.title))).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "概览" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "文稿" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "笔记" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "练习" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "更多" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "笔记" }));
    // 笔记面板按需懒加载，Tiptap/NotesPanel 在完整套件并行跑时偶尔超过默认等待窗口。
    expect(
      await screen.findByLabelText("笔记内容滚动区", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "学习工具" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "更多" }));
    expect(
      await screen.findByRole("group", { name: "更多学习资料" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "课件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "脑图" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "片段" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "搜索" })).toBeInTheDocument();
  }, 15_000);

  it("shows a retryable media error instead of an endless preparing state", async () => {
    mockIpc.videos.mediaUrl
      .mockRejectedValueOnce(new Error("media service unavailable"))
      .mockResolvedValueOnce("http://127.0.0.1:1234/m/video-1");
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("media service unavailable");
    expect(screen.queryByText("正在准备播放…")).not.toBeInTheDocument();

    const callsBeforeRetry = mockIpc.videos.mediaUrl.mock.calls.length;
    fireEvent.click(within(alert).getByRole("button", { name: "重试" }));

    await waitFor(() =>
      expect(mockIpc.videos.mediaUrl.mock.calls.length).toBeGreaterThan(callsBeforeRetry),
    );
    expect(await screen.findByLabelText("课程视频播放器")).toBeInTheDocument();
  });

  it("shows an error with retry when the videos query fails", async () => {
    mockIpc.videos.list.mockRejectedValue(new Error("boom"));

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));

    // 失败不再静默留空：出现错误提示 + 重试按钮。
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("switches the selected-video shell to a stacked layout on narrow screens", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
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

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
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

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
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
    // 标题层级调整后，选中课程时 h1 显示课程名。
    expect(screen.getByRole("heading", { name: "Downloads" })).toBeInTheDocument();
    expect(mockIpc.app.exit).not.toHaveBeenCalled();
  });

  it("exits Android once when back is pressed at the course-list root", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    vi.stubGlobal("navigator", { userAgent: "Android" });

    renderHome();

    await screen.findByRole("navigation", { name: "主导航" });
    await waitFor(() => expect(mockBackButtonPress.onBackButtonPress).toHaveBeenCalled());
    const handler = mockBackButtonPress.onBackButtonPress.mock.calls[
      mockBackButtonPress.onBackButtonPress.mock.calls.length - 1
    ]?.[0] as ((payload: { canGoBack: boolean }) => void) | undefined;

    act(() => handler?.({ canGoBack: false }));

    await waitFor(() => expect(mockIpc.app.exit).toHaveBeenCalledOnce());
  });

  it("closes the course action menu before exiting the Android root", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    vi.stubGlobal("navigator", { userAgent: "Android" });
    renderHome();

    const action = (await screen.findAllByRole("button", { name: "课程操作" }))[0];
    fireEvent.click(action);
    expect(await screen.findByRole("menuitem", { name: "重命名" })).toBeInTheDocument();
    await waitFor(() => expect(mockBackButtonPress.onBackButtonPress).toHaveBeenCalled());
    const handler = mockBackButtonPress.onBackButtonPress.mock.calls[
      mockBackButtonPress.onBackButtonPress.mock.calls.length - 1
    ]?.[0] as ((payload: { canGoBack: boolean }) => void) | undefined;

    act(() => handler?.({ canGoBack: false }));

    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "重命名" })).not.toBeInTheDocument(),
    );
    expect(mockIpc.app.exit).not.toHaveBeenCalled();
  });

  it("cancels course renaming before exiting the Android root", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    vi.stubGlobal("navigator", { userAgent: "Android" });
    renderHome();

    const action = (await screen.findAllByRole("button", { name: "课程操作" }))[0];
    fireEvent.click(action);
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    const input = screen.getByRole("textbox", { name: "重命名课程" });
    fireEvent.change(input, { target: { value: "未完成的课程名" } });

    await waitFor(() => expect(mockBackButtonPress.onBackButtonPress).toHaveBeenCalled());
    const handler = mockBackButtonPress.onBackButtonPress.mock.calls[
      mockBackButtonPress.onBackButtonPress.mock.calls.length - 1
    ]?.[0] as ((payload: { canGoBack: boolean }) => void) | undefined;

    act(() => handler?.({ canGoBack: false }));

    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "重命名课程" })).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "课程操作" })[0]).toHaveFocus(),
    );
    expect(mockIpc.courses.rename).not.toHaveBeenCalled();
    expect(mockIpc.app.exit).not.toHaveBeenCalled();
  });

  it("closes the video action menu on Android back and restores its trigger", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    vi.stubGlobal("navigator", { userAgent: "Android" });
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
    const trigger = await screen.findByRole("button", { name: "视频操作" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "修改标题" })).toHaveFocus();

    await waitFor(() => expect(mockBackButtonPress.onBackButtonPress).toHaveBeenCalled());
    const handler = mockBackButtonPress.onBackButtonPress.mock.calls[
      mockBackButtonPress.onBackButtonPress.mock.calls.length - 1
    ]?.[0] as ((payload: { canGoBack: boolean }) => void) | undefined;
    act(() => handler?.({ canGoBack: false }));

    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "视频操作菜单" })).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    expect(screen.getByRole("heading", { name: "Downloads" })).toBeInTheDocument();
    expect(mockIpc.app.exit).not.toHaveBeenCalled();
  });

  it("closes an open import menu before leaving the selected course on Android back", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    vi.stubGlobal("navigator", { userAgent: "Android" });
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
    const importTrigger = screen.getByRole("button", { name: "导入" });
    fireEvent.click(importTrigger);
    expect(screen.getByRole("menu", { name: "导入" })).toBeInTheDocument();

    await waitFor(() => expect(mockBackButtonPress.onBackButtonPress).toHaveBeenCalled());
    const handler = mockBackButtonPress.onBackButtonPress.mock.calls[
      mockBackButtonPress.onBackButtonPress.mock.calls.length - 1
    ]?.[0] as ((payload: { canGoBack: boolean }) => void) | undefined;

    act(() => handler?.({ canGoBack: false }));

    expect(screen.queryByRole("menu", { name: "导入" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Downloads" })).toBeInTheDocument();
    expect(importTrigger).toHaveFocus();
    expect(mockIpc.app.exit).not.toHaveBeenCalled();
  });

  it("closes transcript search before leaving the video workspace on Android back", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    vi.stubGlobal("navigator", { userAgent: "Android" });
    mockIpc.transcripts.list.mockResolvedValue([
      {
        id: 1,
        video_id: video.id,
        segment_idx: 0,
        start_ms: 0,
        end_ms: 1_000,
        text: "第一句文稿",
      },
    ]);
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));
    fireEvent.click(await screen.findByRole("tab", { name: /文稿/ }));
    const searchTrigger = await screen.findByRole("button", { name: "搜索文稿" });
    fireEvent.click(searchTrigger);
    expect(screen.getByRole("searchbox", { name: "搜索文稿" })).toHaveFocus();

    await waitFor(() => expect(mockBackButtonPress.onBackButtonPress).toHaveBeenCalled());
    const handler = mockBackButtonPress.onBackButtonPress.mock.calls[
      mockBackButtonPress.onBackButtonPress.mock.calls.length - 1
    ]?.[0] as ((payload: { canGoBack: boolean }) => void) | undefined;

    act(() => handler?.({ canGoBack: false }));

    expect(screen.queryByRole("searchbox", { name: "搜索文稿" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "学习工作台" })).toBeInTheDocument();
    expect(searchTrigger).toHaveFocus();
    expect(mockIpc.app.exit).not.toHaveBeenCalled();
  });

  it("cancels an unsaved transcript edit before leaving the Android workspace", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    vi.stubGlobal("navigator", { userAgent: "Android" });
    mockIpc.transcripts.list.mockResolvedValue([
      {
        id: 1,
        video_id: video.id,
        segment_idx: 0,
        start_ms: 0,
        end_ms: 1_000,
        text: "第一句文稿",
      },
    ]);
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));
    fireEvent.click(await screen.findByRole("tab", { name: /文稿/ }));
    fireEvent.click((await screen.findAllByRole("button", { name: "编辑这句文稿" }))[0]);
    fireEvent.change(screen.getByLabelText("编辑文稿"), {
      target: { value: "尚未保存的字幕改动" },
    });

    await waitFor(() => expect(mockBackButtonPress.onBackButtonPress).toHaveBeenCalled());
    const handler = mockBackButtonPress.onBackButtonPress.mock.calls[
      mockBackButtonPress.onBackButtonPress.mock.calls.length - 1
    ]?.[0] as ((payload: { canGoBack: boolean }) => void) | undefined;
    act(() => handler?.({ canGoBack: false }));

    await waitFor(() => expect(screen.queryByLabelText("编辑文稿")).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "学习工作台" })).toBeInTheDocument();
    expect(mockIpc.transcripts.update).not.toHaveBeenCalled();
    expect(mockIpc.app.exit).not.toHaveBeenCalled();
  });

  it("cancels inline video rename on the system back path without leaving the course", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    vi.stubGlobal("navigator", { userAgent: "Android" });
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
    const trigger = await screen.findByRole("button", { name: "视频操作" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "修改标题" }));
    expect(screen.getByLabelText("视频标题")).toHaveFocus();

    await waitFor(() => expect(mockCurrentWindow.onCloseRequested).toHaveBeenCalled());
    const handler = mockCurrentWindow.onCloseRequested.mock.calls[
      mockCurrentWindow.onCloseRequested.mock.calls.length - 1
    ]?.[0] as ((event: { preventDefault: () => void }) => void) | undefined;
    const preventDefault = vi.fn();
    act(() => handler?.({ preventDefault }));

    expect(preventDefault).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "修改标题" })).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    expect(screen.getByRole("heading", { name: "Downloads" })).toBeInTheDocument();
    expect(mockIpc.app.exit).not.toHaveBeenCalled();
  });

  it("closes the visible assistant before handling the underlying Android page", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    vi.stubGlobal("navigator", { userAgent: "Android" });
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: "打开助手" }));
    expect(await screen.findByRole("dialog", { name: "助手" })).toBeVisible();
    await waitFor(() => expect(mockBackButtonPress.onBackButtonPress).toHaveBeenCalled());
    const handler = mockBackButtonPress.onBackButtonPress.mock.calls[
      mockBackButtonPress.onBackButtonPress.mock.calls.length - 1
    ]?.[0] as ((payload: { canGoBack: boolean }) => void) | undefined;

    act(() => handler?.({ canGoBack: false }));

    await waitFor(() => expect(useAssistantUi.getState().open).toBe(false));
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    expect(mockIpc.app.exit).not.toHaveBeenCalled();
  });

  it("closes the assistant before a transcript search hidden behind it on Android back", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    vi.stubGlobal("navigator", { userAgent: "Android" });
    mockIpc.transcripts.list.mockResolvedValue([
      {
        id: 1,
        video_id: video.id,
        segment_idx: 0,
        start_ms: 0,
        end_ms: 1_000,
        text: "第一句文稿",
      },
    ]);
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));
    fireEvent.click(await screen.findByRole("tab", { name: /文稿/ }));
    fireEvent.click(await screen.findByRole("button", { name: "搜索文稿" }));
    expect(screen.getByRole("searchbox", { name: "搜索文稿" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开助手" }));
    expect(await screen.findByRole("dialog", { name: "助手" })).toBeVisible();

    await waitFor(() => expect(mockBackButtonPress.onBackButtonPress).toHaveBeenCalled());
    const handler = mockBackButtonPress.onBackButtonPress.mock.calls[
      mockBackButtonPress.onBackButtonPress.mock.calls.length - 1
    ]?.[0] as ((payload: { canGoBack: boolean }) => void) | undefined;
    act(() => handler?.({ canGoBack: false }));

    await waitFor(() => expect(useAssistantUi.getState().open).toBe(false));
    expect(screen.getByRole("searchbox", { name: "搜索文稿" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "学习工作台" })).toBeInTheDocument();
    expect(mockIpc.app.exit).not.toHaveBeenCalled();
  });

  it("exits video fullscreen before leaving the Android learning workspace", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    vi.stubGlobal("navigator", { userAgent: "Android" });
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));
    const stage = await screen.findByLabelText("课程视频舞台");
    fireEvent.mouseEnter(stage);
    fireEvent.click(await screen.findByRole("button", { name: "全屏" }));
    expect(await screen.findByRole("button", { name: "退出全屏" })).toBeInTheDocument();

    await waitFor(() => expect(mockBackButtonPress.onBackButtonPress).toHaveBeenCalled());
    const handler = mockBackButtonPress.onBackButtonPress.mock.calls[
      mockBackButtonPress.onBackButtonPress.mock.calls.length - 1
    ]?.[0] as ((payload: { canGoBack: boolean }) => void) | undefined;
    act(() => handler?.({ canGoBack: false }));

    await waitFor(() => expect(mockCurrentWindow.setFullscreen).toHaveBeenLastCalledWith(false));
    expect(screen.getByRole("region", { name: "学习工作台" })).toBeInTheDocument();
    expect(screen.getByLabelText("课程视频播放器")).toBeInTheDocument();
    expect(mockIpc.app.exit).not.toHaveBeenCalled();
  });

  it("lets the settings dirty guard consume Android back before closing", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    vi.stubGlobal("navigator", { userAgent: "Android" });

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    fireEvent.click(await screen.findByRole("button", { name: "大模型" }));
    const profileName = await screen.findByLabelText("配置名称");
    fireEvent.change(profileName, { target: { value: "尚未保存的配置" } });
    expect(await screen.findByText("未保存")).toBeInTheDocument();

    await waitFor(() => expect(mockBackButtonPress.onBackButtonPress).toHaveBeenCalled());
    const handler = mockBackButtonPress.onBackButtonPress.mock.calls[
      mockBackButtonPress.onBackButtonPress.mock.calls.length - 1
    ]?.[0] as
      | ((payload: { canGoBack: boolean }) => void)
      | undefined;

    act(() => handler?.({ canGoBack: false }));

    expect(
      await screen.findByRole("dialog", { name: "有未保存的 LLM 修改" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("配置名称")).toHaveValue("尚未保存的配置");

    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "有未保存的 LLM 修改" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("配置名称")).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "设置分类" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).getByRole("button", { name: "设置" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("uses Android back to leave a settings detail before closing settings", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    vi.stubGlobal("navigator", { userAgent: "Android" });
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    fireEvent.click(await screen.findByRole("button", { name: "外观" }));
    expect(screen.queryByRole("navigation", { name: "设置分类" })).not.toBeInTheDocument();

    await waitFor(() => expect(mockBackButtonPress.onBackButtonPress).toHaveBeenCalled());
    const handler = mockBackButtonPress.onBackButtonPress.mock.calls[
      mockBackButtonPress.onBackButtonPress.mock.calls.length - 1
    ]?.[0] as ((payload: { canGoBack: boolean }) => void) | undefined;
    act(() => handler?.({ canGoBack: false }));

    expect(await screen.findByRole("navigation", { name: "设置分类" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(mockIpc.app.exit).not.toHaveBeenCalled();
  });

  it("returns from the developer console to settings and keeps its bottom tab selected", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    vi.stubGlobal("navigator", { userAgent: "Android" });
    renderHome();

    const nav = await screen.findByRole("navigation", { name: "主导航" });
    fireEvent.click(within(nav).getByRole("button", { name: "设置" }));
    fireEvent.click(await screen.findByRole("button", { name: "开发者" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开开发控制台" }));

    expect(await screen.findByRole("heading", { name: "开发控制台" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "设置" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await waitFor(() => expect(mockBackButtonPress.onBackButtonPress).toHaveBeenCalled());
    const handler = mockBackButtonPress.onBackButtonPress.mock.calls[
      mockBackButtonPress.onBackButtonPress.mock.calls.length - 1
    ]?.[0] as ((payload: { canGoBack: boolean }) => void) | undefined;
    act(() => handler?.({ canGoBack: false }));

    expect(await screen.findByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "开发控制台" })).not.toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "设置" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(mockIpc.app.exit).not.toHaveBeenCalled();
  });

  it("guards compact bottom-tab navigation while LLM settings is dirty", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    fireEvent.click(await screen.findByRole("button", { name: "大模型" }));
    fireEvent.change(await screen.findByLabelText("配置名称"), {
      target: { value: "底栏切换前未保存" },
    });

    fireEvent.click(screen.getByRole("button", { name: "学习" }));

    expect(
      await screen.findByRole("dialog", { name: "有未保存的 LLM 修改" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "学习面板" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));

    expect(
      await screen.findByRole("heading", { name: "学习面板" }),
    ).toBeInTheDocument();
  });

  it("returns from the course knowledge page when Android back is pressed", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    vi.stubGlobal("navigator", { userAgent: "Android" });

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
    await screen.findByText(displayTitle(video.title));
    fireEvent.click(screen.getByRole("button", { name: "知识点" }));

    expect(screen.getByLabelText("课程知识页面")).toBeInTheDocument();

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
      expect(screen.queryByLabelText("课程知识页面")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { name: "Downloads" })).toBeInTheDocument();
  });

  it("returns from a subtitle source to the same concept context", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
    await screen.findByText(displayTitle(video.title));
    fireEvent.click(screen.getByRole("button", { name: "知识点" }));
    fireEvent.click(screen.getByRole("button", { name: "回看字幕证据" }));

    expect(await screen.findByRole("region", { name: "学习工作台" })).toBeInTheDocument();
    const returnButton = screen.getByRole("button", { name: "返回知识点：贝叶斯定理" });
    fireEvent.click(returnButton);

    const knowledgePage = await screen.findByLabelText("课程知识页面");
    expect(knowledgePage).toHaveAttribute("data-search", "条件概率");
    expect(knowledgePage).toHaveAttribute("data-expanded", "concept-1");
    expect(knowledgePage).toHaveAttribute("data-scroll-top", "320");
  });

  it("uses Android back to return from a source video to its concept", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    vi.stubGlobal("navigator", { userAgent: "Android" });
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
    await screen.findByText(displayTitle(video.title));
    fireEvent.click(screen.getByRole("button", { name: "知识点" }));
    fireEvent.click(screen.getByRole("button", { name: "回看字幕证据" }));

    expect(
      await screen.findByRole("button", { name: "返回知识点：贝叶斯定理" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(mockBackButtonPress.onBackButtonPress).toHaveBeenCalled());
    const handler = mockBackButtonPress.onBackButtonPress.mock.calls[
      mockBackButtonPress.onBackButtonPress.mock.calls.length - 1
    ]?.[0] as ((payload: { canGoBack: boolean }) => void) | undefined;

    act(() => handler?.({ canGoBack: false }));

    const knowledgePage = await screen.findByLabelText("课程知识页面");
    expect(knowledgePage).toHaveAttribute("data-expanded", "concept-1");
  });

  it("uses bottom tabs and course-list drill-down on a compact screen", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("compact");
    renderHome();

    const nav = await screen.findByRole("navigation", { name: "主导航" });
    expect(within(nav).getByRole("button", { name: "课程" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("button", { name: "学习" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "队列" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "课程侧栏" })).toHaveClass(
      "ca-course-screen",
    );

    fireEvent.click(within(nav).getByRole("button", { name: "学习" }));

    expect(await screen.findByRole("heading", { name: "学习面板" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "学习" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    fireEvent.click(within(nav).getByRole("button", { name: "设置" }));

    expect(await screen.findByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "设置" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    fireEvent.click(screen.getByRole("button", { name: "返回" }));

    await waitFor(() =>
      expect(within(nav).getByRole("button", { name: "课程" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );

    fireEvent.click(within(nav).getByRole("button", { name: "队列" }));
    expect(await screen.findByLabelText("处理队列页面")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "队列" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    fireEvent.click(screen.getByRole("button", { name: "返回上一菜单" }));

    await waitFor(() =>
      expect(within(nav).getByRole("button", { name: "课程" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
  });

  it("uses the phone-style library layout on iPad portrait", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("medium");
    mockPlatform.isTablet.mockReturnValue(true);

    renderHome();

    expect(await screen.findByRole("complementary", { name: "课程侧栏" })).toHaveClass(
      "ca-course-screen",
    );
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
  });

  it("uses the stacked workspace on iPad portrait", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("medium");
    mockPlatform.isTablet.mockReturnValue(true);

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    expect(screen.getByLabelText("学习工作台响应布局")).toHaveAttribute(
      "data-layout",
      "stacked",
    );
    expect(screen.queryByRole("navigation", { name: "工具栏" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
  });

  // 12.9" iPad 竖屏宽达 1024，会真正落入 wide 档；但它仍须使用无侧栏的
  // 单列 shell，否则 CSS 会留着 256px 侧栏轨道，把唯一的 main 挤进第一列。
  it("stacks the workspace on a wide iPad in portrait", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("wide");
    mockUseContainerWidth.useIsPortrait.mockReturnValue(true);
    mockPlatform.isTablet.mockReturnValue(true);

    const { container } = renderHome();

    expect(container.firstElementChild).toHaveAttribute("data-bucket", "wide");
    expect(container.firstElementChild).toHaveAttribute("data-shell", "stacked");
    expect(screen.queryByRole("navigation", { name: "工具栏" })).not.toBeInTheDocument();
    expect(await screen.findByRole("navigation", { name: "主导航" })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    expect(screen.getByLabelText("学习工作台响应布局")).toHaveAttribute(
      "data-layout",
      "stacked",
    );
    expect(screen.queryByRole("navigation", { name: "工具栏" })).not.toBeInTheDocument();
  });

  it("still stacks the workspace on an iPad portrait even when pointer media queries are unavailable", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("wide");
    mockUseContainerWidth.coarsePointer.mockReturnValue(false);
    mockUseContainerWidth.useIsPortrait.mockReturnValue(true);
    mockPlatform.isTablet.mockReturnValue(true);

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    expect(screen.getByLabelText("学习工作台响应布局")).toHaveAttribute(
      "data-layout",
      "stacked",
    );
  });

  // 横屏 iPad(wide)继续保留桌面式左右分栏。
  it("keeps the split workspace on a wide iPad in landscape", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("wide");
    mockUseContainerWidth.coarsePointer.mockReturnValue(true);
    mockUseContainerWidth.useIsPortrait.mockReturnValue(false);
    mockPlatform.isTablet.mockReturnValue(true);

    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /Downloads/ }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    expect(screen.getByLabelText("学习工作台响应布局")).toHaveAttribute(
      "data-layout",
      "wide",
    );
  });
});
