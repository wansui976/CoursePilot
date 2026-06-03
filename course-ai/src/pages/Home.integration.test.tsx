import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    pipeline: { process: vi.fn(), jobs: vi.fn() },
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
    tools: { ocr: vi.fn(), importBilibili: vi.fn() },
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), confirm: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
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
  beforeEach(() => {
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
  });

  it("keeps visible learning UI when the real selected-video panels mount", async () => {
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: "Downloads" }));
    fireEvent.click(await screen.findByRole("button", { name: /底层逻辑/ }));

    expect(screen.getByText("学习工作台")).toBeInTheDocument();
    expect(screen.getByText(video.title)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "AI 概览" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "笔记" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "文稿" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "课件" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "笔记" }));
    // 笔记面板按需懒加载，等它挂载。
    expect(await screen.findByRole("button", { name: "AI笔记" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI出题" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI脑图" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提问" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "搜索文稿" })).toBeInTheDocument();
  });
});
