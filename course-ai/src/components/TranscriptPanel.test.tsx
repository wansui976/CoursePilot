import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptPanel } from "./TranscriptPanel";
import type { TranscriptSegment } from "@/lib/types";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    transcripts: {
      list: vi.fn(),
      update: vi.fn(),
    },
    export: {
      subtitles: vi.fn(),
    },
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

function makeSegments(count: number): TranscriptSegment[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    video_id: "video-1",
    segment_idx: i,
    start_ms: (i + 1) * 1_000,
    end_ms: (i + 1) * 1_000 + 900,
    text: `第 ${i + 1} 句文稿内容`,
  }));
}

// 原生滚动列表：直接渲染即可（不再需要虚拟列表的视口/行高注入）。
function renderTranscriptPanel(instanceKey = "one") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const ui = (videoId: string) => (
    <QueryClientProvider client={queryClient}>
      <div data-theme="light">
        <TranscriptPanel key={instanceKey} videoId={videoId} />
      </div>
    </QueryClientProvider>
  );
  const view = render(ui("video-1"));
  // 模拟 TabsPanel 保活下的换视频：同一实例仅 prop 变化，不重挂。
  const switchVideo = (videoId: string) => view.rerender(ui(videoId));
  return { ...view, switchVideo };
}

describe("TranscriptPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    mockIpc.transcripts.list.mockResolvedValue(makeSegments(60));
  });

  it("uses theme-aware muted text for segment timestamps", async () => {
    renderTranscriptPanel();

    expect(await screen.findByText("00:01")).toHaveClass(
      "text-[var(--text-muted)]",
    );
  });

  it("persists the transcript scroll position while scrolling", async () => {
    renderTranscriptPanel();
    await screen.findByText("00:01");
    const scroller = screen.getByLabelText("文稿内容滚动区");

    act(() => {
      scroller.scrollTop = 800;
      fireEvent.scroll(scroller);
    });

    await waitFor(() => {
      const raw = localStorage.getItem("course-ai-resume:video-1");
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw as string).transcriptScrollTop).toBe(800);
    });
  });

  it("restores each video's own scroll position when switching without remount", async () => {
    localStorage.setItem(
      "course-ai-resume:video-2",
      JSON.stringify({ transcriptScrollTop: 300 }),
    );
    const { switchVideo } = renderTranscriptPanel();
    await screen.findByText("00:01");
    const scroller = screen.getByLabelText("文稿内容滚动区");
    act(() => {
      scroller.scrollTop = 800;
      fireEvent.scroll(scroller);
    });

    switchVideo("video-2");

    // 新视频恢复自己保存的位置，而不是停留在旧视频的偏移。
    await waitFor(() => {
      expect(screen.getByLabelText("文稿内容滚动区").scrollTop).toBe(300);
    });
    // 旧视频的位置被正确写回，也没有被新视频的值污染。
    expect(
      JSON.parse(localStorage.getItem("course-ai-resume:video-1") as string)
        .transcriptScrollTop,
    ).toBe(800);
    expect(
      JSON.parse(localStorage.getItem("course-ai-resume:video-2") as string)
        .transcriptScrollTop,
    ).toBe(300);
  });

  it("migrates the legacy transcriptTopIndex and clears it after restoring", async () => {
    localStorage.setItem(
      "course-ai-resume:video-1",
      JSON.stringify({ transcriptTopIndex: 30 }),
    );
    renderTranscriptPanel();
    await screen.findByText("00:01");

    await waitFor(() => {
      const saved = JSON.parse(
        localStorage.getItem("course-ai-resume:video-1") as string,
      );
      // jsdom 无布局，换算出的像素值恒为 0；这里验证迁移发生且旧行号被清零。
      expect(saved.transcriptTopIndex).toBe(0);
      expect(saved.transcriptScrollTop).toBeGreaterThanOrEqual(0);
    });
  });
});
